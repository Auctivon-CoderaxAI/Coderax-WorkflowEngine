import type {
  AgentId,
  AgentList,
  BudgetState,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  DataMode,
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
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { LeaseStore, RunScope } from '../execution/lease.js';
import { workRunKey } from '../execution/lease.js';
import type { TaskRunner, RunOutcome, RunResult } from '../execution/runner.js';
import type { RunSupervisor } from '../execution/supervisor.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter, AgentHistoryTurn, AgentReportEvent } from '../agents/types.js';
import { redactContent, redactText, redactToolInput } from '../observability/redact.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { BudgetLedger } from '../models/budget.js';
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
import {
  createRunWorkspace,
  removeRunWorkspaceIfEmpty,
  workspaceRoots,
} from '../execution/workspace.js';
import { buildTranscript } from './transcript.js';

export type ApplicationServiceDeps = {
  config: EngineConfig;
  clock: Clock;
  ids: IdGenerator;
  auth: AuthService;
  agents: AgentRegistry;
  models: ModelCatalog;
  budget: BudgetLedger;
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  permissions: PermissionStore;
  notifications: NotificationStore;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  supervisor: RunSupervisor;
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

  /**
   * Earlier turns for this conversation, read from the store rather than from
   * process memory, so a resume on another replica sees the same exchange.
   * History is context, not authority: a store failure costs the agent its
   * context instead of failing a task the owner already submitted. The current
   * objective is excluded because it is sent separately.
   */
  async function historyFor(
    conversation: ConversationRecord,
    currentText: string,
    adapter: AgentAdapter,
  ): Promise<AgentHistoryTurn[]> {
    // The adapter's declared isolation is the authority, not the call site. An
    // agent that advertises `conversations: none` never receives earlier turns,
    // even when the owner selected it inside an existing thread.
    if (adapter.isolation.conversations === 'none') return [];
    try {
      const messages = await deps.conversations.messages({
        ownerId: conversation.ownerId,
        conversationId: conversation.conversationId,
        mode: conversation.mode,
      });
      if (messages === null) return [];
      return buildTranscript({ messages, currentText });
    } catch {
      return [];
    }
  }

  /**
   * Resolves the one conversation a request may use. A caller-supplied id is
   * accepted only when the stored record has the same owner, data mode and
   * surface; otherwise private history could enter a cloud run, or a Work run
   * could be started inside a Chat thread. The failure is deliberately uniform
   * so it does not reveal that a foreign conversation exists.
   */
  async function bindConversation(input: {
    principal: Principal;
    conversationId?: string;
    mode: DataMode;
    isWork: boolean;
    agent: AgentId;
    title?: string;
  }): Promise<ServiceResult<ConversationRecord>> {
    const now = deps.clock.iso();
    const binding = await deps.conversations.ensure({
      conversationId: input.conversationId ?? deps.ids.conversationId(),
      ownerId: input.principal.ownerId,
      tenantId: null,
      ...(input.title ? { title: input.title } : {}),
      mode: input.mode,
      isWork: input.isWork,
      agent: input.agent,
      createdAt: now,
      updatedAt: now,
    });
    if (!binding.ok) {
      return fail(
        'conflict',
        'That conversation is bound to a different owner, data mode or surface; start a new conversation.',
      );
    }
    if (binding.record.agent !== input.agent) {
      await deps.conversations.updateAgent(binding.record.conversationId, input.agent);
      return ok({ ...binding.record, agent: input.agent, updatedAt: now });
    }
    return ok(binding.record);
  }

  function publish(
    task: TaskRecord,
    type: Parameters<EventBus['publish']>[0]['type'],
    payload?: unknown,
    /** Present for run-origin events: a revoked generation may not publish. */
    token?: string,
  ): void {
    if (token !== undefined && !deps.supervisor.isLive(task.taskId, token)) return;
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
              artifacts: [] as Array<{ path: string; bytes?: number; digest?: string }>,
            },
            ...(outcome.usage ? { usage: outcome.usage } : {}),
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
          ...(task.model ? { model: task.model } : {}),
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

    const model = task.model
      ? deps.models.resolve(task.model, task.mode)
      : deps.models.resolve(null, task.mode);
    if (!model.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: model.code === 'paid_model_refused' ? 'paid_model_refused' : 'not_configured',
        detail: model.detail,
        retryable: false,
      });
      return;
    }

    // One directory per task and generation. Two runs in the same mode, and two
    // generations of the same task, therefore cannot read or overwrite each
    // other's files, and revoking one run cannot affect another.
    const workspace = await createRunWorkspace({
      mode: task.mode,
      roots: workspaceRoots(deps.config.workspaces),
      runId: task.taskId,
      generation: task.generation,
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
    await deps.supervisor.begin({
      taskId,
      token,
      generation: started.task.generation,
      workspaceRoot: workspace.value.root,
    });
    publish(started.task, 'task.started');

    const controller = new AbortController();
    controllers.set(taskId, controller);

    const steps = [...started.task.steps];
    const completed: string[] = [...started.task.checkpoint.completedSteps];
    let text = '';
    let visible = text;
    const emitText = (next: string, replace = false): void => {
      if (replace || !next.startsWith(visible)) {
        publish(started.task, 'text.replace', { text: next }, token);
      } else if (next !== visible) {
        publish(started.task, 'text.delta', { text: next.slice(visible.length) }, token);
      }
      visible = next;
    };

    const report = (event: AgentReportEvent): void => {
      if (controllers.get(taskId) !== controller || controller.signal.aborted) return;
      // The controller is replaced by a resume; the supervisor is the durable
      // answer to "may this generation still act". Both must agree.
      if (!deps.supervisor.isLive(taskId, token)) return;
      if (event.type === 'step.started') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'running';
        else steps.push({ id: event.stepId, title: event.title, state: 'running' });
        publish(started.task, 'step.started', { stepId: event.stepId, title: event.title }, token);
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
        publish(started.task, 'step.completed', { stepId: event.stepId, title: event.title }, token);
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
        }, token);
        return;
      }
      if (event.type === 'tool.result') {
        publish(started.task, 'tool.result', {
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          ...(event.output === undefined ? {} : { output: redactText(event.output) }),
        }, token);
        return;
      }
      if (event.type === 'file.edit') {
        if (typeof event.path !== 'string' || event.path.length < 1 || event.path.length > 1024) {
          throw new RangeError('file.edit path must contain 1–1024 characters.');
        }
        publish(started.task, 'file.edit', { path: event.path }, token);
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
      }, token);
    };

    const history = await historyFor(
      {
        conversationId: task.conversationId,
        ownerId: task.ownerId,
        tenantId: task.tenantId,
        mode: task.mode,
        isWork: true,
        agent: task.agent,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      task.objective,
      adapter.value as AgentAdapter,
    );
    let result: RunResult;
    try {
      result = await deps.runner.run({
        scope: scopeOf(started.task),
        token,
        adapter: adapter.value as AgentAdapter,
        request: {
          ownerId: task.ownerId,
          tenantId: task.tenantId,
          conversationId: task.conversationId,
          objective: task.objective,
          history,
          model: model.value.ref,
          mode: task.mode,
          workspaceRoot: workspace.value.root,
          maxSteps: deps.config.engines.native.maxSteps,
          budget: task.budget,
          signal: controller.signal,
        },
        report,
        generation: started.task.generation,
        workspaceRoot: workspace.value.root,
      });
    } catch {
      await deps.supervisor.abandon({
        taskId,
        token,
        reason: 'The runner failed before termination could be verified.',
      });
      await settle(started.task, token, {
        kind: 'failed',
        code: 'provider_error',
        detail: 'The execution supervisor could not verify the run.',
        retryable: true,
      });
      return;
    }

    // Only a *different live controller* means a newer generation took over.
    // A missing entry is shutdown (which clears the map): this run still holds
    // the lease and must settle instead of leaving the task running forever.
    const current = controllers.get(taskId);
    const superseded = current !== undefined && current !== controller;
    if (!superseded) controllers.delete(taskId);
    const verified = result.terminated;
    try {
      if (superseded || result.ownershipLost) {
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
    } finally {
      // Verified termination means the adapter returned. Anything else means it
      // may still be running, so its capability and workspace are revoked rather
      // than left available to a generation the engine can no longer supervise.
      if (verified) {
        deps.supervisor.finish(taskId, token);
      } else {
        await deps.supervisor.abandon({
          taskId,
          token,
          reason: 'The adapter did not verify termination within the cancellation grace period.',
        });
      }
    }
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

    submitWork: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;

      const model = deps.models.resolve(request.model, request.mode);
      if (!model.ok) return model;

      const reservation = deps.budget.reserve(principal.ownerId, deps.clock.now());
      if (!reservation.allowed) {
        return fail(
          'budget_exhausted',
          'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
        );
      }

      const now = deps.clock.iso();
      const bound = await bindConversation({
        principal,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        mode: request.mode,
        isWork: true,
        agent: agentId,
        title: request.objective.slice(0, 120),
      });
      if (!bound.ok) return bound;
      const conversationId = bound.value.conversationId;
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
        model: model.value.ref,
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
      return ok(toStatus(reconciled));
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
      const model = deps.models.resolve(request.model, request.mode);
      if (!model.ok) return model;

      const reservation = deps.budget.reserve(principal.ownerId, deps.clock.now());
      if (!reservation.allowed) {
        return fail('budget_exhausted', 'The daily zero-cost request budget is exhausted.');
      }
      // A chat turn is a run too, so it gets its own empty directory instead of
      // the shared mode root. It is removed afterwards when it produced nothing.
      const workspace = await createRunWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
        runId: deps.ids.runToken(),
        generation: 0,
      });
      if (!workspace.ok) return workspace;

      const now = deps.clock.iso();
      const bound = await bindConversation({
        principal,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        mode: request.mode,
        isWork: false,
        agent: request.agent,
      });
      if (!bound.ok) {
        await removeRunWorkspaceIfEmpty(workspace.value.root);
        return bound;
      }
      const conversation = bound.value;
      const conversationId = conversation.conversationId;
      await deps.conversations.appendMessage({
        messageId: deps.ids.messageId(),
        conversationId,
        role: 'user',
        text: request.message,
        createdAt: now,
      });

      const history = await historyFor(conversation, request.message, adapter.value);
      const controller = new AbortController();
      let outcome: Awaited<ReturnType<AgentAdapter['run']>>;
      try {
        outcome = await adapter.value.run(
          {
            ownerId: principal.ownerId,
            tenantId: conversation.tenantId,
            conversationId,
            objective: request.message,
            history,
            model: model.value.ref,
            mode: request.mode,
            workspaceRoot: workspace.value.root,
            maxSteps: 1,
            budget: null,
            signal: controller.signal,
          },
          () => undefined,
        );
      } finally {
        await removeRunWorkspaceIfEmpty(workspace.value.root);
      }
      if (!outcome.ok) {
        return fail(
          outcome.code === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          outcome.detail,
          outcome.retryable,
        );
      }
      const reply = redactContent(outcome.summary);
      deps.budget.consume(principal.ownerId, outcome.usage ?? {}, deps.clock.now());
      const messageId = deps.ids.messageId();
      await deps.conversations.appendMessage({
        messageId,
        conversationId,
        role: 'assistant',
        text: reply,
        createdAt: deps.clock.iso(),
        agent: request.agent,
      });
      return ok({
        conversationId,
        messageId,
        text: reply,
        agent: request.agent,
        model: model.value.ref,
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
        exhausted: used.requests >= budget.maxRequests,
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
      // Wait for the runner's grace bound to turn every aborted run into a
      // settled outcome, then revoke whatever is still registered. The second
      // step is the verified part: no capability survives shutdown.
      await Promise.race([
        deps.scheduler.idle(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deps.config.execution.cancelGraceMs + 1_000);
          timer.unref();
        }),
      ]);
      await deps.supervisor.shutdown();
    },
  };

  return service;
}
