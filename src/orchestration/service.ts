import type {
  AgentId,
  AgentList,
  BudgetState,
  CapabilityReport,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  DataMode,
  Deliverable,
  DeliverableRequest,
  MemoryList,
  ModelList,
  NotificationList,
  PermissionDecisionRequest,
  PermissionList,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { ConversationRecord, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import { ConversationModeConflict, type ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { LeaseStore, RunScope } from '../execution/lease.js';
import { workRunKey } from '../execution/lease.js';
import type { TaskRunner, RunOutcome } from '../execution/runner.js';
import type { AgentRegistry } from '../agents/registry.js';
import type {
  AgentAdapter,
  AgentHistoryTurn,
  AgentReportEvent,
  AgentRunOutcome,
} from '../agents/types.js';
import { redactContent, redactText, redactToolInput } from '../observability/redact.js';
import type { ModelCatalog } from '../models/catalog.js';
import { inferRoutingMode } from '../models/router.js';
import { estimateTokens } from '../models/verify.js';
import type { BudgetLedger } from '../models/budget.js';
import type { PolicyDecision } from '../models/policy.js';
import type { PermissionStore } from '../permissions/store.js';
import type { MemoryStore } from '../memory/store.js';
import type { AuditLog } from '../observability/audit.js';
import type { HealthService } from '../observability/health.js';
import type { EventBus, Replay, Unsubscribe } from '../events/bus.js';
import type { TaskScheduler } from '../scheduling/scheduler.js';
import type { AuthService, Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { ArtifactService } from '../artifacts/service.js';
import { resolveEngineWorkspace, workspaceRoots } from '../execution/workspace.js';
import { buildTranscript } from './transcript.js';
import type { ArtifactToolkit } from '../artifacts/types.js';
import { ArtifactPersistError } from '../artifacts/types.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';

export type ApplicationServiceDeps = {
  config: EngineConfig;
  clock: Clock;
  ids: IdGenerator;
  auth: AuthService;
  agents: AgentRegistry;
  models: ModelCatalog;
  budget: BudgetLedger;
  externalPolicy: (engine: Exclude<AgentAdapter['engine'], 'native'>, mode: DataMode) => PolicyDecision;
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  permissions: PermissionStore;
  notifications: NotificationStore;
  artifactService: ArtifactService;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  toolkit: ArtifactToolkit;
  /** The single capability registry; no module reports capabilities separately. */
  capabilities: CapabilityRegistry;
};

export type EventStream = {
  replay: Replay;
  subscribe: (listener: (event: unknown) => void) => Unsubscribe;
  lastSeq: number;
};

export type ApplicationService = {
  health: () => ReturnType<HealthService['report']>;
  readiness: () => ReturnType<HealthService['readiness']>;
  agents: () => AgentList;
  models: () => ModelList;
  capabilities: () => CapabilityReport;
  deliver: (
    principal: Principal,
    request: DeliverableRequest,
  ) => Promise<ServiceResult<Deliverable>>;
  submitWork: (
    principal: Principal,
    request: WorkSubmitRequest,
  ) => Promise<ServiceResult<TaskAccepted>>;
  task: (principal: Principal, taskId: string) => Promise<ServiceResult<TaskStatus>>;
  cancelTask: (
    principal: Principal,
    taskId: string,
    reason?: string,
  ) => Promise<ServiceResult<TaskControlResult>>;
  resumeTask: (
    principal: Principal,
    taskId: string,
    generation: number,
  ) => Promise<ServiceResult<TaskControlResult>>;
  retryTask: (
    principal: Principal,
    taskId: string,
    generation: number,
  ) => Promise<ServiceResult<TaskControlResult>>;
  chat: (principal: Principal, request: ChatRequest) => Promise<ServiceResult<ChatReply>>;
  conversations: (principal: Principal) => Promise<ConversationList>;
  conversation: (
    principal: Principal,
    conversationId: string,
  ) => Promise<ServiceResult<Conversation>>;
  memory: (principal: Principal, mode: DataMode) => Promise<MemoryList>;
  permissions: (principal: Principal, taskId: string) => Promise<ServiceResult<PermissionList>>;
  decidePermission: (
    principal: Principal,
    taskId: string,
    body: PermissionDecisionRequest,
  ) => Promise<ServiceResult<PermissionList>>;
  notifications: (principal: Principal) => Promise<NotificationList>;
  /** Durable artifact storage; the only path that returns artifact bytes. */
  artifacts: ArtifactService;
  events: (
    principal: Principal,
    taskId: string,
    after: number,
  ) => Promise<ServiceResult<EventStream>>;
  budget: (principal: Principal) => BudgetState;
  /** Startup ownership verification: retires runs whose lease is gone. */
  recoverInterrupted: () => Promise<{ interrupted: number }>;
  shutdown: () => Promise<void>;
};

function scopeOf(task: TaskRecord): RunScope {
  return {
    ownerId: task.ownerId,
    tenantId: task.tenantId,
    conversationId: task.conversationId,
  };
}

export function createApplicationService(deps: ApplicationServiceDeps): ApplicationService {
  const controllers = new Map<string, AbortController>();

  function checkExternal(engine: AgentAdapter['engine'], mode: DataMode): ServiceResult<void> {
    if (engine === 'native') return ok(undefined);
    const decision = deps.externalPolicy(engine, mode);
    return decision.allowed ? ok(undefined) : fail('model_missing', decision.detail);
  }

  async function ensureConversation(record: ConversationRecord): Promise<ServiceResult<ConversationRecord>> {
    try {
      return ok(await deps.conversations.ensure(record));
    } catch (error) {
      if (error instanceof ConversationModeConflict) return fail('conflict', error.message);
      throw error;
    }
  }

  /**
   * Earlier turns for this conversation, read from the store rather than from
   * process memory, so a resume on another replica sees the same exchange.
   * History is context, not authority: a store failure costs the agent its
   * context instead of failing a task the owner already submitted. The current
   * objective is excluded because it is sent separately.
   */
  async function historyFor(
    conversationId: string,
    currentText: string,
  ): Promise<AgentHistoryTurn[]> {
    try {
      const messages = await deps.conversations.messages(conversationId);
      return buildTranscript({ messages, currentText });
    } catch {
      return [];
    }
  }

  function publish(
    task: TaskRecord,
    type: Parameters<EventBus['publish']>[0]['type'],
    payload?: unknown,
  ): void {
    deps.events.publish({
      taskId: task.taskId,
      agent: task.agent,
      generation: task.generation,
      type,
      at: deps.clock.iso(),
      ...(payload === undefined ? {} : { payload: scrub(type, payload) }),
    });
  }

  /** Failure text is written by an adapter or a provider, so it is scrubbed. */
  function scrub(type: string, payload: unknown): unknown {
    if (type !== 'task.failed' || typeof payload !== 'object' || payload === null) {
      return payload;
    }
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail !== 'string') {
      return payload;
    }
    return { ...(payload as Record<string, unknown>), detail: redactText(detail, [], 1000) };
  }

  function toStatus(task: TaskRecord): TaskStatus {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      agent: task.agent,
      mode: task.mode,
      ...(task.model ? { model: task.model } : {}),
      generation: task.generation,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.leaseExpiresAt ? { leaseExpiresAt: task.leaseExpiresAt } : {}),
      cancelRequested: task.cancelRequested,
      steps: task.steps.map((step) => ({
        id: step.id,
        title: step.title,
        state: step.state,
      })),
      ...(task.result
        ? {
            result: {
              ...(task.result.summary ? { summary: task.result.summary } : {}),
              artifacts: task.result.artifacts,
            },
          }
        : {}),
      ...(task.usage ? { usage: task.usage } : {}),
      ...(task.failure
        ? {
            failure: {
              code: task.failure.code,
              ...(task.failure.detail
                ? { detail: redactText(task.failure.detail, [], 1000) }
                : {}),
            },
          }
        : {}),
    };
  }

  function ownedTask(task: TaskRecord | null, principal: Principal): ServiceResult<TaskRecord> {
    if (!task || task.ownerId !== principal.ownerId) {
      return fail('not_found', 'That task does not exist for this owner.');
    }
    return ok(task);
  }

  async function notifyTerminal(
    task: TaskRecord,
    state: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    summary?: string,
  ): Promise<void> {
    await deps.notifications.record({
      taskId: task.taskId,
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      agent: task.agent,
      mode: task.mode,
      state,
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
      createdAt: deps.clock.iso(),
      read: false,
    });
  }

  async function releaseLease(task: TaskRecord, token: string): Promise<void> {
    await deps.lease
      .release({ key: workRunKey(scopeOf(task)), token })
      .catch(() => false);
  }

  /**
   * Persists a terminal outcome only while this generation still owns the task.
   * When ownership was lost the function writes nothing at all: a superseded run
   * must never overwrite the state a newer generation owns.
   */
  async function settle(
    task: TaskRecord,
    token: string,
    outcome: RunOutcome,
    checkpoint?: TaskRecord['checkpoint'],
  ): Promise<void> {
    if (outcome.kind === 'interrupted') {
      return;
    }
    const now = deps.clock.iso();
    const patch =
      outcome.kind === 'completed'
        ? {
            state: 'completed' as const,
            updatedAt: now,
            result: {
              summary: outcome.summary.slice(0, 20_000),
              artifacts: (outcome.artifacts ?? []).map((artifact) => ({
                path: artifact.filename,
                bytes: artifact.bytes,
                digest: artifact.sha256,
                artifactId: artifact.artifactId,
              })),
            },
            ...(outcome.usage ? { usage: outcome.usage } : {}),
            ...(outcome.model ? { model: outcome.model } : {}),
          }
        : outcome.kind === 'cancelled'
          ? { state: 'cancelled' as const, updatedAt: now }
          : {
              state: 'failed' as const,
              updatedAt: now,
              failure: {
                code: outcome.code,
                detail: outcome.detail,
                retryable: outcome.retryable,
              },
            };

    const applied = await deps.tasks.updateFenced({
      taskId: task.taskId,
      token,
      patch: checkpoint ? { ...patch, checkpoint } : patch,
    });
    if (!applied.applied) {
      if (applied.reason === 'terminal' || applied.reason === 'superseded') {
        await releaseLease(task, token);
      }
      return;
    }

    const settled = applied.task;
    try {
      if (outcome.kind === 'completed') {
        publish(settled, 'task.completed', {
          summary: outcome.summary.slice(0, 20_000),
          ...(settled.model ? { model: settled.model } : {}),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
      } else if (outcome.kind === 'cancelled') {
        publish(settled, 'task.cancelled', {});
      } else {
        publish(settled, 'task.failed', {
          code: outcome.code, detail: outcome.detail, retryable: outcome.retryable,
        });
      }

      const text = checkpoint?.text ?? '';
      if (text.length > 0) {
        await deps.conversations.appendMessage({
          messageId: deps.ids.messageId(),
          conversationId: task.conversationId,
          role: 'assistant',
          text,
          createdAt: now,
          agent: task.agent,
        }).catch(() => undefined);
      }
      const detail = outcome.kind === 'completed' ? outcome.summary
        : outcome.kind === 'failed' ? outcome.detail : undefined;
      await notifyTerminal(settled, outcome.kind, detail).catch(() => undefined);
      deps.audit.record({
        actor: task.ownerId,
        action: `work.${outcome.kind}`,
        taskId: task.taskId,
        conversationId: task.conversationId,
        outcome: outcome.kind,
        ...(outcome.kind === 'failed' ? { detail: outcome.code } : {}),
      });
    } finally {
      await releaseLease(task, token);
    }
  }

  async function execute(taskId: string, token: string): Promise<void> {
    const task = await deps.tasks.get(taskId);
    if (!task || task.runToken !== token) return;

    const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
    if (!lease || !lease.live) {
      await settle(task, token, {
        kind: 'failed',
        code: 'server_unavailable',
        detail: 'The run lost its lease before it started.',
        retryable: true,
      });
      return;
    }
    if (lease.cancelRequested) {
      await settle(task, token, { kind: 'cancelled' });
      return;
    }

    const adapter = deps.agents.resolve(task.agent);
    if (!adapter.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: 'not_configured',
        detail: adapter.detail,
        retryable: false,
      });
      return;
    }

    const external = checkExternal(adapter.value.engine, task.mode);
    if (!external.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: 'not_configured',
        detail: external.detail,
        retryable: false,
      });
      return;
    }

    const routing = inferRoutingMode({ objective: task.objective });
    const pinned = task.modelPinned === true && task.model !== null;
    const model = deps.models.resolve(pinned ? task.model : null, task.mode, {
      operation: 'work',
      routing,
      estimatedInputTokens: estimateTokens([task.objective]),
      ...(task.budget === null ? {} : { maxOutputTokens: task.budget.maxOutputTokens }),
    });
    if (!model.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: model.code === 'paid_model_refused' ? 'paid_model_refused' : 'not_configured',
        detail: model.detail,
        retryable: false,
      });
      return;
    }

    const workspace = await resolveEngineWorkspace({
      mode: task.mode,
      roots: workspaceRoots(deps.config.workspaces),
    });
    if (!workspace.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: 'workspace_denied',
        detail: workspace.detail,
        retryable: false,
      });
      return;
    }

    const started = await deps.tasks.updateFenced({
      taskId,
      token,
      patch: {
        state: 'running',
        updatedAt: deps.clock.iso(),
        leaseExpiresAt: lease.expiresAt.toISOString(),
        model: model.value.ref,
      },
    });
    if (!started.applied) return;
    publish(started.task, 'task.started');

    const controller = new AbortController();
    controllers.set(taskId, controller);

    const steps = [...started.task.steps];
    const completed: string[] = [...started.task.checkpoint.completedSteps];
    let text = '';
    let visible = text;
    const emitText = (next: string, replace = false): void => {
      if (replace || !next.startsWith(visible)) publish(started.task, 'text.replace', { text: next });
      else if (next !== visible) publish(started.task, 'text.delta', { text: next.slice(visible.length) });
      visible = next;
    };

    const report = (event: AgentReportEvent): void => {
      if (controllers.get(taskId) !== controller || controller.signal.aborted) return;
      if (event.type === 'step.started') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'running';
        else steps.push({ id: event.stepId, title: event.title, state: 'running' });
        publish(started.task, 'step.started', { stepId: event.stepId, title: event.title });
        void deps.tasks.updateFenced({
          taskId,
          token,
          patch: { steps, updatedAt: deps.clock.iso() },
        });
        return;
      }
      if (event.type === 'step.completed') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'completed';
        completed.push(event.stepId);
        publish(started.task, 'step.completed', { stepId: event.stepId, title: event.title });
        void deps.tasks.updateFenced({
          taskId,
          token,
          patch: {
            steps,
            checkpoint: { completedSteps: [...completed], text: visible },
            updatedAt: deps.clock.iso(),
          },
        });
        return;
      }
      if (event.type === 'text.delta' || event.type === 'text.replace') {
        text = event.type === 'text.replace' ? event.text : text + event.text;
        // A trailing token can become a credential when the next delta arrives.
        let end = text.length;
        while (end > 0 && !/\s/.test(text.charAt(end - 1))) end--;
        const complete = text.slice(0, end);
        emitText(redactContent(complete), event.type === 'text.replace');
        return;
      }
      if (event.type === 'tool.call') {
        publish(started.task, 'tool.call', {
          callId: event.callId,
          tool: event.tool,
          ...(event.input === undefined ? {} : { input: redactToolInput(event.input) }),
        });
        return;
      }
      if (event.type === 'tool.result') {
        publish(started.task, 'tool.result', {
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          ...(event.output === undefined ? {} : { output: redactText(event.output) }),
        });
        return;
      }
      if (event.type === 'file.edit') {
        if (typeof event.path !== 'string' || event.path.length < 1 || event.path.length > 1024) {
          throw new RangeError('file.edit path must contain 1–1024 characters.');
        }
        publish(started.task, 'file.edit', { path: event.path });
        return;
      }
      /**
       * An approval is published, not granted: the permission store is the only
       * authority that can approve a resource, and the adapter must have created
       * that request before reporting it.
       */
      publish(started.task, 'approval.required', {
        requestId: event.requestId,
        tool: event.tool,
        description: redactText(event.description, [], 2000),
      });
    };

    const history = adapter.value.isolation.conversations === 'granted'
      ? await historyFor(task.conversationId, task.objective)
      : undefined;
    // External engines bypass the router, so their request slot is reserved here.
    const externalReservation =
      started.task.engine === 'native'
        ? null
        : deps.budget.reserve({
            ownerId: task.ownerId,
            at: deps.clock.now(),
            inputTokens: estimateTokens([task.objective]),
            outputTokens: task.budget?.maxOutputTokens ?? 1_024,
          });
    if (externalReservation !== null && !externalReservation.allowed) {
      await settle(task, token, {
        kind: 'failed',
        code: 'budget_exhausted',
        detail: 'The daily zero-cost request budget is exhausted; the external run was not dispatched.',
        retryable: true,
      });
      return;
    }
    const held = externalReservation?.allowed ? externalReservation.reservation : null;
    let dispatched = false;
    let result: Awaited<ReturnType<TaskRunner['run']>> | undefined;
    try {
      result = await deps.runner.run({
        scope: scopeOf(started.task),
        token,
        adapter: adapter.value as AgentAdapter,
        request: {
          // Present for a durable Work run; Native uses it to gate artifacts.
          taskId: task.taskId,
          ownerId: task.ownerId,
          tenantId: task.tenantId,
          conversationId: task.conversationId,
          objective: task.objective,
          ...(history === undefined ? {} : { history }),
          model: model.value.ref,
          routing,
          allowFallback: !pinned,
          mode: task.mode,
          operation: 'work',
          workspaceRoot: workspace.value.root,
          maxSteps: deps.config.engines.native.maxSteps,
          budget: task.budget,
          signal: controller.signal,
        },
        report,
        admitDispatch: () => {
          dispatched = !controller.signal.aborted && checkExternal(adapter.value.engine, task.mode).ok;
          return dispatched;
        },
      });
    } finally {
      // Budget settlement does not depend on whether this generation still owns the task.
      if (held) {
        if (dispatched) {
          const outcome = result?.outcome;
          deps.budget.settle(held.id, outcome?.kind === 'completed' ? outcome.usage ?? {} : {});
        } else {
          deps.budget.release(held.id);
        }
      }
    }
    if (controllers.get(taskId) !== controller) return;
    controllers.delete(taskId);

    if (result.ownershipLost) {
      // Deliberately no terminal write and no notification: this run no longer
      // owns the task, and the new owner is the only writer of its state.
      return;
    }
    const safeText = redactContent(text);
    emitText(safeText);
    const outcome = result.outcome.kind === 'completed'
      ? { ...result.outcome, summary: redactContent(result.outcome.summary) }
      : result.outcome;
    await settle(started.task, token, outcome, { completedSteps: completed, text: safeText });
  }

  async function reconcile(task: TaskRecord): Promise<TaskRecord> {
    if (isTerminalState(task.state) || task.state === 'awaiting_approval') {
      return task;
    }
    const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
    if (lease && lease.live) return task;
    if (lease && !lease.live && lease.token === task.runToken) {
      const applied = await deps.tasks.updateFenced({
        taskId: task.taskId,
        token: task.runToken ?? '',
        patch: {
          state: 'interrupted',
          updatedAt: deps.clock.iso(),
          failure: {
            code: 'server_unavailable',
            detail: 'The run stopped heartbeating and was retired.',
            retryable: true,
          },
        },
      });
      if (applied.applied) {
        publish(applied.task, 'task.interrupted', {
          detail: 'Execution ownership was lost; the task is safe to resume.',
        });
        await notifyTerminal(applied.task, 'interrupted');
        deps.audit.record({
          actor: task.ownerId,
          action: 'work.interrupted',
          taskId: task.taskId,
          conversationId: task.conversationId,
          outcome: 'failed',
        });
        return applied.task;
      }
    }
    return task;
  }

  const service: ApplicationService = {
    health: () => deps.health.report(),
    readiness: () => deps.health.readiness(),
    agents: () => deps.agents.list(),
    models: () => deps.models.list(),
    capabilities: () => deps.capabilities.report(),

    deliver: async (principal, request) => {
      const workspace = await resolveEngineWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
      });
      if (!workspace.ok) return workspace;
      return deps.toolkit.produce({
        request,
        context: {
          mode: request.mode,
          root: workspace.value.root,
          clock: deps.clock,
          ids: deps.ids,
          // The owner's own request is the authorization; the write is still
          // confined to the resolved mode root and recorded as a receipt.
          authorize: () => true,
          receipts: (entry) => {
            const record = deps.audit.record({
              actor: principal.ownerId,
              action: entry.action,
              outcome: entry.outcome === 'completed' ? 'completed' : 'refused',
              detail: entry.detail.slice(0, 500),
            });
            return { receipt: record.receipt, at: record.at };
          },
          persist: async (generated) => {
            const uploaded = await deps.artifactService.upload(principal, {
              filename: generated.filename,
              mediaType: generated.mediaType,
              kind: generated.kind,
              contentBase64: Buffer.from(generated.data).toString('base64'),
              mode: request.mode,
              ...(generated.sha256 === undefined
                  ? {}
                  : { sha256: generated.sha256.replace(/^sha256:/, '') }),
              ...(generated.title === undefined
                ? {}
                : { note: generated.title.slice(0, 500) }),
              ...(generated.relativePath === undefined
                ? {}
                : { relativePath: generated.relativePath }),
              ...(generated.projectId === undefined
                ? {}
                : { projectId: generated.projectId }),
            });
            if (!uploaded.ok) throw new ArtifactPersistError(uploaded.detail);
            return uploaded.value.artifact;
          },
        },
      });
    },

    submitWork: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;
      const external = checkExternal(adapter.value.engine, request.mode);
      if (!external.ok) return external;

      const routing = inferRoutingMode({ objective: request.objective });
      const model = deps.models.resolve(request.model, request.mode, {
        operation: 'work',
        routing,
        estimatedInputTokens: estimateTokens([request.objective]),
        ...(request.budget === undefined
          ? {}
          : { maxOutputTokens: request.budget.maxOutputTokens }),
      });
      if (!model.ok) return model;

      if (!deps.budget.available(principal.ownerId, deps.clock.now())) {
        return fail(
          'budget_exhausted',
          'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
        );
      }

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      const conversation = await ensureConversation({
        conversationId,
        ownerId: principal.ownerId,
        tenantId: null,
        title: request.objective.slice(0, 120),
        mode: request.mode,
        isWork: true,
        agent: agentId,
        createdAt: now,
        updatedAt: now,
      });
      if (!conversation.ok) return conversation;
      await deps.conversations.appendMessage({
        messageId: deps.ids.messageId(),
        conversationId,
        role: 'user',
        text: request.objective,
        createdAt: now,
      });

      const task: TaskRecord = {
        taskId: deps.ids.taskId(),
        ownerId: principal.ownerId,
        tenantId: null,
        conversationId,
        agent: agentId,
        engine: adapter.value.engine,
        mode: request.mode,
        objective: request.objective,
        // An automatic route stores no model until execution ranks it; an explicit
        // request stays pinned so a fallback can never replace the owner's choice.
        model: request.model === undefined ? null : model.value.ref,
        modelPinned: request.model !== undefined,
        state: 'queued',
        generation: 1,
        runToken: null,
        steps: [],
        checkpoint: { completedSteps: [], text: '' },
        createdAt: now,
        updatedAt: now,
        leaseExpiresAt: null,
        cancelRequested: false,
        requireApproval: request.requireApproval,
        budget: request.budget ?? null,
        usage: null,
        result: null,
        failure: null,
      };

      // Claim first, then create. The lease is the cross-replica guard for "one
      // live run per conversation", and the created task carries the unique
      // token that authorizes its terminal write from the first instant.
      const token = deps.ids.runToken();
      const claimedAt = deps.clock.now();
      const key = workRunKey({
        ownerId: task.ownerId,
        tenantId: task.tenantId,
        conversationId,
      });
      const claimed = await deps.lease.claim({
        key,
        owner: task.ownerId,
        token,
        now: claimedAt,
        expiresAt: new Date(claimedAt.getTime() + deps.config.execution.leaseTtlMs),
      });
      if (!claimed) {
        return fail('busy', 'This conversation already has a live Work run.');
      }

      const created = await deps.tasks.create({
        ...task,
        runToken: token,
        leaseExpiresAt: new Date(
          claimedAt.getTime() + deps.config.execution.leaseTtlMs,
        ).toISOString(),
      });
      if (!created.ok) {
        await deps.lease.release({ key, token }).catch(() => false);
        return fail(
          'busy',
          created.reason === 'conversation_busy'
            ? 'This conversation already has an active Work task.'
            : 'That task identity is already in use.',
        );
      }

      publish(created.task, 'task.queued');
      deps.audit.record({
        actor: principal.ownerId,
        action: 'work.accepted',
        taskId: task.taskId,
        conversationId,
        outcome: 'accepted',
        detail: `agent=${agentId} model=${modelKey(model.value.ref)}`,
      });

      deps.scheduler.enqueue(() => execute(task.taskId, token));

      return ok({
        taskId: task.taskId,
        conversationId,
        state: 'queued',
        generation: 1,
        eventsPath: `/v1/work/${task.taskId}/events`,
      });
    },

    task: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const reconciled = await reconcile(found.value);
      const status = toStatus(reconciled);
      // Result artifacts are read from the artifact service rather than copied
      // into the fenced task row. The task remains the authority on state; the
      // artifact store is the authority on files, and a download can be made
      // from exactly the descriptors reported here.
      const listed = await deps.artifactService.list(principal, {
        mode: reconciled.mode,
        taskId: reconciled.taskId,
        limit: 100,
      });
      if (listed.ok && listed.value.artifacts.length > 0) {
        status.result = {
          ...(status.result ?? {}),
          artifacts: listed.value.artifacts.map((artifact) => ({
            // A generated source tree keeps its directory-relative path; a flat
            // artifact falls back to its file name. Neither is a host path.
            path: artifact.relativePath ?? artifact.filename,
            bytes: artifact.bytes,
            digest: artifact.sha256,
            artifactId: artifact.artifactId,
          })),
        };
      }
      return ok(status);
    },

    cancelTask: async (principal, taskId, reason) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const task = found.value;
      if (isTerminalState(task.state)) {
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'already_terminal',
        });
      }

      const outcome = await deps.lease.cancel({
        key: workRunKey(scopeOf(task)),
        now: deps.clock.now(),
      });
      if (outcome === 'none') {
        return fail('not_found', 'No live run exists for that task.');
      }

      if (outcome === 'requested') {
        await deps.tasks.updateFenced({
          taskId: task.taskId,
          token: task.runToken ?? '',
          patch: { cancelRequested: true, updatedAt: deps.clock.iso() },
        });
        controllers.get(task.taskId)?.abort();
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'accepted',
        });
      }

      const applied = await deps.tasks.updateFenced({
        taskId: task.taskId,
        token: task.runToken ?? '',
        patch: {
          state: 'interrupted',
          updatedAt: deps.clock.iso(),
          cancelRequested: true,
          failure: {
            code: 'cancelled',
            detail: reason ?? 'The run was interrupted before it could be cancelled live.',
            retryable: true,
          },
        },
      });
      if (!applied.applied) {
        return ok({
          taskId: task.taskId,
          state: (await deps.tasks.get(task.taskId))?.state ?? task.state,
          generation: task.generation,
          outcome: 'superseded',
        });
      }
      publish(applied.task, 'task.interrupted', {
        detail: 'The run had already stopped; it was retired as interrupted.',
      });
      await notifyTerminal(applied.task, 'interrupted');
      return ok({
        taskId: task.taskId,
        state: 'interrupted',
        generation: task.generation,
        outcome: 'accepted',
      });
    },

    resumeTask: async (principal, taskId, generation) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const task = await reconcile(found.value);
      if (task.generation !== generation) {
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'superseded',
        });
      }
      if (task.state !== 'interrupted' && task.state !== 'awaiting_approval') {
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'already_terminal',
        });
      }
      const token = deps.ids.runToken();
      const now = deps.clock.now();
      const claimed = await deps.lease.claim({
        key: workRunKey(scopeOf(task)),
        owner: task.ownerId,
        token,
        now,
        expiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs),
      });
      if (!claimed) return fail('busy', 'This conversation already has a live Work run.');

      const applied = await deps.tasks.reissue({
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) return fail('conflict', 'That task cannot be resumed.');
      publish(applied.task, 'task.queued', {});
      publish(applied.task, 'text.replace', { text: '' });
      deps.scheduler.enqueue(() => execute(taskId, token));
      return ok({
        taskId,
        state: 'queued',
        generation: applied.task.generation,
        outcome: 'accepted',
      });
    },

    retryTask: async (principal, taskId, generation) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const task = found.value;
      if (task.generation !== generation) {
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'superseded',
        });
      }
      if (task.state !== 'failed' && task.state !== 'interrupted') {
        return ok({
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: 'already_terminal',
        });
      }
      const token = deps.ids.runToken();
      const now = deps.clock.now();
      const claimed = await deps.lease.claim({
        key: workRunKey(scopeOf(task)),
        owner: task.ownerId,
        token,
        now,
        expiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs),
      });
      if (!claimed) return fail('busy', 'This conversation already has a live Work run.');

      const applied = await deps.tasks.reissue({
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) return fail('conflict', 'That task cannot be retried.');
      publish(applied.task, 'task.queued', {});
      publish(applied.task, 'text.replace', { text: '' });
      deps.scheduler.enqueue(() => execute(taskId, token));
      return ok({
        taskId,
        state: 'queued',
        generation: applied.task.generation,
        outcome: 'accepted',
      });
    },

    chat: async (principal, request) => {
      const adapter = deps.agents.resolve(request.agent);
      if (!adapter.ok) return adapter;
      const external = checkExternal(adapter.value.engine, request.mode);
      if (!external.ok) return external;
      const routing = inferRoutingMode({ objective: request.message });
      const model = deps.models.resolve(request.model, request.mode, {
        operation: 'chat',
        routing,
        estimatedInputTokens: estimateTokens([request.message]),
      });
      if (!model.ok) return model;

      if (!deps.budget.available(principal.ownerId, deps.clock.now())) {
        return fail('budget_exhausted', 'The daily zero-cost request budget is exhausted.');
      }
      const workspace = await resolveEngineWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
      });
      if (!workspace.ok) return workspace;

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      const conversation = await ensureConversation({
        conversationId,
        ownerId: principal.ownerId,
        tenantId: null,
        mode: request.mode,
        isWork: false,
        agent: request.agent,
        createdAt: now,
        updatedAt: now,
      });
      if (!conversation.ok) return conversation;
      await deps.conversations.appendMessage({
        messageId: deps.ids.messageId(),
        conversationId,
        role: 'user',
        text: request.message,
        createdAt: now,
      });

      const history = adapter.value.isolation.conversations === 'granted'
        ? await historyFor(conversationId, request.message)
        : undefined;
      const controller = new AbortController();
      // The router reserves internally. An external engine does not pass through
      // it, so hold one request/token slot before dispatch and settle afterward.
      const reservation =
        adapter.value.engine === 'native'
          ? null
          : deps.budget.reserve({
              ownerId: principal.ownerId,
              at: deps.clock.now(),
              inputTokens: estimateTokens([request.message]),
              outputTokens: 1_024,
            });
      if (reservation !== null && !reservation.allowed) {
        return fail('budget_exhausted', 'The daily zero-cost request budget is exhausted.');
      }
      const held = reservation?.allowed ? reservation.reservation : null;
      let dispatched = false;
      let outcome: AgentRunOutcome | undefined;
      try {
        outcome = await adapter.value.run(
          {
            ownerId: principal.ownerId,
            tenantId: conversation.value.tenantId,
            conversationId,
            objective: request.message,
            ...(history === undefined ? {} : { history }),
            model: model.value.ref,
            routing,
            allowFallback: request.model === undefined,
            mode: request.mode,
            operation: 'chat',
            workspaceRoot: workspace.value.root,
            maxSteps: 1,
            budget: null,
            signal: controller.signal,
          },
          () => undefined,
          () => {
            dispatched = checkExternal(adapter.value.engine, request.mode).ok;
            return dispatched;
          },
        );
      } finally {
        if (held) {
          if (dispatched) deps.budget.settle(held.id, outcome?.ok ? outcome.usage ?? {} : {});
          else deps.budget.release(held.id);
        }
      }
      if (!outcome.ok) {
        return fail(
          outcome.code === 'cancelled'
            ? 'cancelled'
            : outcome.code === 'budget_exhausted'
              ? 'budget_exhausted'
              : 'engine_unavailable',
          outcome.detail,
          outcome.retryable,
        );
      }
      const usedModel = outcome.model ?? model.value.ref;
      const messageId = deps.ids.messageId();
      await deps.conversations.appendMessage({
        messageId,
        conversationId,
        role: 'assistant',
        text: outcome.summary,
        createdAt: deps.clock.iso(),
        agent: request.agent,
      });
      return ok({
        conversationId,
        messageId,
        text: outcome.summary,
        agent: request.agent,
        model: usedModel,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        createdAt: deps.clock.iso(),
      });
    },

    conversations: (principal) => deps.conversations.list(principal.ownerId),

    conversation: async (principal, conversationId) => {
      const record = await deps.conversations.get(principal.ownerId, conversationId);
      if (!record) return fail('not_found', 'That conversation does not exist for this owner.');
      return ok(await deps.conversations.toContract(record));
    },

    memory: (principal, mode) => deps.memory.list({ ownerId: principal.ownerId, mode }),

    permissions: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return ok(await deps.permissions.list(principal.ownerId, taskId));
    },

    decidePermission: async (principal, taskId, body) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return deps.permissions.decide({
        ownerId: principal.ownerId,
        taskId,
        requestId: body.requestId,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
      });
    },

    notifications: (principal) => deps.notifications.list(principal.ownerId),

    artifacts: deps.artifactService,

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return ok({
        replay: deps.events.replay(taskId, after),
        subscribe: (listener) => deps.events.subscribe(taskId, after, listener),
        lastSeq: deps.events.lastSeq(taskId),
      });
    },

    budget: (principal) => {
      const used = deps.budget.snapshot(principal.ownerId, deps.clock.now());
      const budget = {
        maxRequests: deps.config.models.dailyRequestBudget,
        maxInputTokens: deps.config.models.dailyTokenBudget,
        maxOutputTokens: deps.config.models.dailyTokenBudget,
      };
      return {
        budget,
        used: {
          requests: used.requests,
          usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens },
        },
        remaining: { requests: Math.max(0, budget.maxRequests - used.requests) },
        exhausted: !deps.budget.available(principal.ownerId, deps.clock.now()),
      };
    },

    recoverInterrupted: async () => {
      const unsettled = await deps.tasks.listUnsettled();
      let interrupted = 0;
      for (const task of unsettled) {
        const before = task.state;
        const reconciled = await reconcile(task);
        if (before !== reconciled.state && reconciled.state === 'interrupted') {
          interrupted += 1;
        }
      }
      return { interrupted };
    },

    shutdown: async () => {
      deps.scheduler.stop();
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };

  return service;
}
