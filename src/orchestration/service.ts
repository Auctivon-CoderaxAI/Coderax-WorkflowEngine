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
  KnowledgeIngestRequest,
  KnowledgeIngestResult,
  KnowledgeList,
  KnowledgeSearchResult,
  RoutingMode,
  RoutingReport,
  ToolList,
  PermissionScope,
} from '@coderax/contracts';
import { isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { TaskPatch, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { LeaseStore, RunScope } from '../execution/lease.js';
import { workRunKey } from '../execution/lease.js';
import type { TaskRunner, RunOutcome } from '../execution/runner.js';
import type { ExecutionSupervisor } from '../execution/supervisor.js';
import type { ExecutionIdentity } from '../execution/identity.js';
import type { ToolExecutionGuard } from '../execution/guard.js';
import type { AgentRegistry } from '../agents/registry.js';
import type {
  AgentAdapter,
  AgentContext,
  AgentHistoryTurn,
  AgentReportEvent,
} from '../agents/types.js';
import type { ApprovalGate, ToolRuntime } from '../tools/types.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { Router as ModelRouter } from '../models/router.js';
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
import { resolveEngineWorkspace, workspaceRoots } from '../execution/workspace.js';
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
  supervisor: ExecutionSupervisor;
  scheduler: TaskScheduler;
  health: HealthService;
  tools: ToolRuntime;
  knowledge: KnowledgeStore;
  modelRouter: ModelRouter;
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
  tools: () => ToolList;
  routing: (mode: RoutingMode) => RoutingReport;
  ingestKnowledge: (
    principal: Principal,
    body: KnowledgeIngestRequest,
  ) => Promise<ServiceResult<KnowledgeIngestResult>>;
  knowledge: (principal: Principal, mode: DataMode) => Promise<KnowledgeList>;
  searchKnowledge: (
    principal: Principal,
    query: string,
    k: number,
    mode: DataMode,
  ) => Promise<KnowledgeSearchResult>;
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

/**
 * Scopes a Chat turn may use. A Chat turn has no task, so a tool that needs a
 * durable owner approval is still refused; these are the read-only capabilities
 * that previously ran with no execution identity at all.
 */
const CHAT_SCOPES: readonly PermissionScope[] = [
  'workspace.read',
  'memory.read',
  'knowledge.read',
];

/** Everything a Work run's configured tool runtime can expose. */
const WORK_SCOPES: readonly PermissionScope[] = [
  'workspace.read',
  'workspace.write',
  'command.execute',
  'network.access',
  'memory.read',
  'memory.write',
  'knowledge.read',
  'knowledge.write',
  'conversation.read',
  'credential.use',
  'browser.use',
];

export function createApplicationService(deps: ApplicationServiceDeps): ApplicationService {
  /** Which attempt currently represents each task, for a same-replica cancel. */
  const executionsByTask = new Map<string, string>();

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

  /**
   * The approval gate for one run. A read-only tool never reaches it. A tool
   * with a scope needs either a live grant for the exact resource or a new
   * durable request; a chat turn has no task to attach a request to, so it is
   * refused instead of running the action unapproved.
   */
  function approvalGate(input: {
    ownerId: string;
    taskId: string | null;
    requireApproval: boolean;
    guard?: ToolExecutionGuard;
  }): ApprovalGate {
    return {
      ensure: async ({ scope, resource, description, tool, binding, consume }) => {
        if (input.guard && !input.guard.live()) return { decision: 'denied' as const };
        if (input.taskId === null) return { decision: 'denied' as const };
        if (!input.requireApproval) return { decision: 'denied' };
        const prior = await deps.permissions.lookup({
          ownerId: input.ownerId, taskId: input.taskId, scope, resource, binding, consume,
        });
        if (prior) return prior;
        const created = await deps.permissions.request({
          ownerId: input.ownerId,
          taskId: input.taskId,
          agent: 'coderax',
          binding,
          scope,
          resource,
          description: `${tool}: ${description}`.slice(0, 2000),
        });
        return { decision: 'pending' as const, requestId: created.requestId };
      },
    };
  }

  /**
   * Context is lent, not stored on the adapter. Only Coderax Native receives it;
   * an external agent's isolation says `memory: none` and it is never given these
   * ports. Memory and retrieval are scoped to the run's data mode, so a cloud run
   * cannot read private entries.
   */
  async function nativeContext(input: {
    ownerId: string;
    mode: DataMode;
    task?: TaskRecord;
    guard?: ToolExecutionGuard;
  }): Promise<AgentContext> {
    return {
      taskId: input.task?.taskId ?? null,
      tools: {
        runtime: deps.tools,
        gate: approvalGate({
          ownerId: input.ownerId,
          taskId: input.task?.taskId ?? null,
          requireApproval: input.task?.requireApproval ?? false,
          ...(input.guard ? { guard: input.guard } : {}),
        }),
        ...(input.guard ? { guard: input.guard } : {}),
      },
      memory: {
        list: async () =>
          (await deps.memory.list({ ownerId: input.ownerId, mode: input.mode })).entries.map(
            (entry) => `${entry.key}: ${entry.value}`,
          ),
      },
      knowledge: {
        search: (query, k) =>
          deps.knowledge.search({ ownerId: input.ownerId, mode: input.mode, query, k }),
      },
      ...(input.task
        ? {
            plannedSteps: input.task.steps.map((step) => ({ id: step.id, title: step.title })),
            completedSteps: [...input.task.checkpoint.completedSteps],
            ...(input.task.checkpoint.outputs ? { priorOutputs: input.task.checkpoint.outputs } : {}),
            priorText: input.task.checkpoint.text,
            requireApproval: input.task.requireApproval,
          }
        : {}),
    };
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
    if (outcome.kind === 'suspended') {
      // A suspension keeps the task alive: the owner decides, and resume claims a
      // new generation. The checkpoint is written under the same fence, and the
      // lease is released so the conversation is not held by a run that stopped.
      const applied = await deps.tasks.updateFenced({
        taskId: task.taskId,
        token,
        patch: {
          state: 'awaiting_approval',
          updatedAt: now,
          failure: {
            code: 'approval_required',
            detail: outcome.detail,
            retryable: true,
          },
          ...(checkpoint ? { checkpoint } : {}),
        },
      });
      if (applied.applied) {
        deps.audit.record({
          actor: task.ownerId,
          action: 'work.awaiting_approval',
          taskId: task.taskId,
          conversationId: task.conversationId,
          outcome: 'accepted',
          detail: 'approval_required',
        });
      }
      await releaseLease(task, token);
      return;
    }
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

    const steps = [...started.task.steps];
    const completed: string[] = [...started.task.checkpoint.completedSteps];
    const outputs = [...(started.task.checkpoint.outputs ?? (started.task.checkpoint.text
      ? [{ stepId: completed.join(', '), text: started.task.checkpoint.text }] : []))];
    let reports = Promise.resolve();
    const saveReport = (patch: TaskPatch): void => {
      reports = reports.then(async () => {
        await deps.tasks.updateFenced({ taskId, token, patch });
      }).catch(() => { /* The settlement checkpoint includes all completed steps. */ });
    };
    let text = '';
    let visible = text;
    const emitText = (next: string, replace = false): void => {
      if (replace || !next.startsWith(visible)) publish(started.task, 'text.replace', { text: next });
      else if (next !== visible) publish(started.task, 'text.delta', { text: next.slice(visible.length) });
      visible = next;
    };

    // The supervisor drops events once the execution loses authority, so this
    // sink no longer needs its own controller check.
    const report = (event: AgentReportEvent): void => {
      if (event.type === 'step.started') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'running';
        else steps.push({ id: event.stepId, title: event.title, state: 'running' });
        publish(started.task, 'step.started', { stepId: event.stepId, title: event.title });
        saveReport({ steps: structuredClone(steps), updatedAt: deps.clock.iso() });
        return;
      }
      if (event.type === 'step.completed') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'completed';
        completed.push(event.stepId);
        publish(started.task, 'step.completed', { stepId: event.stepId, title: event.title });
        if (event.output !== undefined) outputs.push({ stepId: event.stepId, text: redactContent(event.output) });
        saveReport({
          steps: structuredClone(steps),
          checkpoint: { completedSteps: [...completed], text: visible, outputs: [...outputs] },
          updatedAt: deps.clock.iso(),
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

    const history = task.agent === 'coderax' ? await historyFor(task.conversationId, task.objective) : [];
    const identity: ExecutionIdentity = {
      executionId: deps.ids.executionId(),
      kind: 'work',
      taskId,
      conversationId: task.conversationId,
      ownerId: task.ownerId,
      tenantId: task.tenantId,
      agent: started.task.agent,
      mode: task.mode,
      generation: started.task.generation,
      token,
    };
    executionsByTask.set(taskId, identity.executionId);

    // Work and Chat now share one execution path. The runner keeps its lease
    // heartbeat and bounded cancellation; the supervisor owns the identity, the
    // capability grant, revocation and the termination record around it.
    const supervised = await deps.supervisor.run({
      identity,
      adapter: adapter.value,
      workspaceRoot: workspace.value.root,
      scopes: WORK_SCOPES,
      report,
      launch: async (execution) => {
        const result = await deps.runner.run({
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
            workspaceRoot: execution.workspaceRoot,
            maxSteps: deps.config.engines.native.maxSteps,
            budget: task.budget,
            signal: execution.signal,
            ...(started.task.agent === 'coderax'
              ? {
                  context: {
                    ...await nativeContext({
                      ownerId: task.ownerId,
                      mode: task.mode,
                      task: started.task,
                      guard: execution.guard,
                    }),
                    pendingAction: started.task.pendingAction ?? null,
                    savePendingAction: async (pendingAction) => (await deps.tasks.updateFenced({
                      taskId, token, patch: { pendingAction: pendingAction?.observations
                        ? { ...pendingAction, observations: pendingAction.observations.map(redactContent) } : pendingAction },
                    })).applied,
                    savePlan: async (plan) => {
                      const planned = plan.map((step) => ({ ...step, state: 'queued' as const }));
                      const saved = await deps.tasks.updateFenced({ taskId, token, patch: { steps: planned } });
                      if (saved.applied) steps.splice(0, steps.length, ...planned);
                      return saved.applied;
                    },
                  },
                }
              : {}),
          },
          report: execution.report,
        });
        return {
          outcome: result.outcome,
          ownershipLost: result.ownershipLost,
          abandoned: result.outcome.kind === 'cancelled' && result.outcome.abandoned === true,
        };
      },
    });
    // Only the attempt that still owns this mapping may remove it: a superseded
    // run can finish after its replacement has already registered itself.
    if (executionsByTask.get(taskId) === identity.executionId) {
      executionsByTask.delete(taskId);
    }

    if (!supervised.admitted) {
      await settle(started.task, token, {
        kind: 'failed',
        code: supervised.code === 'workspace_denied' ? 'workspace_denied' : 'server_unavailable',
        detail: supervised.detail,
        retryable: supervised.code !== 'workspace_denied',
      });
      return;
    }
    if (supervised.ownershipLost || supervised.cause === 'interrupted') {
      // Deliberately no terminal write and no notification: this run no longer
      // owns the task, and the new owner is the only writer of its state.
      return;
    }
    if (supervised.cause === 'shutdown') {
      // The process is stopping; the task is left for startup reconciliation and
      // this generation does not settle it.
      return;
    }
    const safeText = redactContent(text);
    emitText(safeText);
    const outcome = supervised.outcome.kind === 'completed'
      ? { ...supervised.outcome, summary: redactContent(supervised.outcome.summary) }
      : supervised.outcome;
    await reports;
    await settle(started.task, token, outcome, { completedSteps: completed, text: safeText, outputs });
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
    tools: () => ({ tools: deps.tools.list() }),
    routing: (mode) => deps.modelRouter.report(mode),
    ingestKnowledge: (principal, body) =>
      deps.knowledge.ingest({
        ownerId: principal.ownerId,
        mode: body.mode,
        title: body.title,
        text: body.text,
      }),
    knowledge: (principal, mode) => deps.knowledge.list({ ownerId: principal.ownerId, mode }),
    searchKnowledge: (principal, query, k, mode) =>
      deps.knowledge.search({ ownerId: principal.ownerId, mode, query, k }),

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
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      await deps.conversations.ensure({
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

      if (task.state === 'awaiting_approval') {
        const token = deps.ids.runToken();
        const now = deps.clock.now();
        const expiresAt = new Date(now.getTime() + deps.config.execution.leaseTtlMs);
        if (!await deps.lease.claim({ key: workRunKey(scopeOf(task)), owner: task.ownerId, token, now, expiresAt })) {
          return fail('busy', 'Another run holds this conversation.');
        }
        const claimed = await deps.tasks.reissue({
          taskId, token, expected: { state: task.state, generation: task.generation },
          now: now.toISOString(), leaseExpiresAt: expiresAt.toISOString(),
        });
        if (!claimed.applied) {
          await releaseLease(task, token);
          return fail('conflict', 'The suspended task changed before cancellation.');
        }
        await settle(claimed.task, token, { kind: 'cancelled' });
        return ok({ taskId, state: 'cancelled', generation: claimed.task.generation, outcome: 'accepted' });
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
        const executionId = executionsByTask.get(task.taskId);
        if (executionId) deps.supervisor.cancel(executionId, reason);
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
        expected: { state: task.state, generation },
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) {
        await releaseLease(task, token);
        return fail('conflict', 'That task cannot be resumed.');
      }
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
        expected: { state: task.state, generation },
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) {
        await releaseLease(task, token);
        return fail('conflict', 'That task cannot be retried.');
      }
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
      const workspace = await resolveEngineWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
      });
      if (!workspace.ok) return workspace;

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      const conversation = await deps.conversations.ensure({
        conversationId,
        ownerId: principal.ownerId,
        tenantId: null,
        mode: request.mode,
        isWork: false,
        agent: request.agent,
        createdAt: now,
        updatedAt: now,
      });
      await deps.conversations.appendMessage({
        messageId: deps.ids.messageId(),
        conversationId,
        role: 'user',
        text: request.message,
        createdAt: now,
      });

      const history = request.agent === 'coderax' ? await historyFor(conversationId, request.message) : [];
      const identity: ExecutionIdentity = {
        executionId: deps.ids.executionId(),
        kind: 'chat',
        taskId: null,
        conversationId,
        ownerId: principal.ownerId,
        tenantId: conversation.tenantId,
        agent: request.agent,
        mode: request.mode,
        generation: 0,
        token: null,
      };

      // A Chat turn is supervised for the same reasons a Work run is: it can call
      // tools, it needs a revocable identity, and it must not keep acting after
      // it has lost authority. It is not a task, so there is no lease and no
      // terminal write.
      const supervised = await deps.supervisor.run({
        identity,
        adapter: adapter.value,
        workspaceRoot: workspace.value.root,
        scopes: CHAT_SCOPES,
        launch: async (execution) => {
          const outcome = await adapter.value.run(
            {
              ownerId: principal.ownerId,
              tenantId: conversation.tenantId,
              conversationId,
              objective: request.message,
              history,
              model: model.value.ref,
              mode: request.mode,
              workspaceRoot: execution.workspaceRoot,
              maxSteps: 1,
              budget: null,
              signal: execution.signal,
              ...(request.agent === 'coderax'
                ? {
                    context: await nativeContext({
                      ownerId: principal.ownerId,
                      mode: request.mode,
                      guard: execution.guard,
                    }),
                  }
                : {}),
            },
            execution.report,
          );
          return {
            outcome: outcome.ok
              ? {
                  kind: 'completed' as const,
                  summary: outcome.summary,
                  ...(outcome.usage ? { usage: outcome.usage } : {}),
                }
              : outcome.code === 'cancelled'
                ? { kind: 'cancelled' as const }
                : outcome.code === 'approval_required'
                  ? { kind: 'suspended' as const, detail: outcome.detail }
                  : {
                      kind: 'failed' as const,
                      code: outcome.code,
                      detail: outcome.detail,
                      retryable: outcome.retryable,
                    },
          };
        },
      });
      if (!supervised.admitted) {
        return fail('engine_unavailable', supervised.detail, supervised.code !== 'workspace_denied');
      }
      const outcome = supervised.outcome;
      if (outcome.kind !== 'completed') {
        return fail(
          outcome.kind === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          outcome.kind === 'cancelled'
            ? 'The chat turn was cancelled.'
            : outcome.kind === 'failed'
              ? outcome.detail
              : outcome.kind === 'suspended'
                ? outcome.detail
                : 'The chat turn lost execution authority.',
          outcome.kind === 'failed' ? outcome.retryable : false,
        );
      }
      deps.budget.consume(principal.ownerId, outcome.usage ?? {}, deps.clock.now());
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
      // Retire attempts whose owning process stopped heartbeating before the
      // task sweep, so an old execution record cannot look live.
      await deps.supervisor.retireStale(deps.config.execution.leaseTtlMs);
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
      // Stop admitting, abort every supervised attempt with the `shutdown` cause
      // (not `cancelled`), and give them a bounded window to unwind before the
      // scheduler is stopped. Unsettled tasks are reconciled on next startup.
      await deps.supervisor.shutdown();
      deps.scheduler.stop();
      executionsByTask.clear();
    },
  };

  return service;
}
