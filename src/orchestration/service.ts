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
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleDispatch,
  ScheduleEventRequest,
  ScheduleEventResult,
  ScheduleExecution,
  ScheduleExecutionList,
  ScheduleList,
  ScheduleTriggerRequest,
  ScheduleUpcoming,
  ScheduleUpdateRequest,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { isTerminalExecution, isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { ScheduleExecutionRecord, ScheduleRecord, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { ScheduleNoticeStore, ScheduleRepository } from '../persistence/schedules.js';
import type { LeaseStore, RunScope } from '../execution/lease.js';
import { workRunKey } from '../execution/lease.js';
import type { TaskRunner, RunOutcome } from '../execution/runner.js';
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
import { createScheduleEngine } from '../scheduling/engine.js';
import type { SchedulePort, ScheduleTickReport } from '../scheduling/engine.js';
import { nextOccurrence, previewOccurrences } from '../scheduling/calendar.js';
import { scheduleSideEffectRefusal } from '../scheduling/policy.js';
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
  schedules: ScheduleRepository;
  scheduleNotices: ScheduleNoticeStore;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
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
  schedules: (principal: Principal) => Promise<ScheduleList>;
  schedule: (principal: Principal, scheduleId: string) => Promise<ServiceResult<Schedule>>;
  createSchedule: (
    principal: Principal,
    request: ScheduleCreateRequest,
  ) => Promise<ServiceResult<Schedule>>;
  pauseSchedule: (
    principal: Principal,
    scheduleId: string,
  ) => Promise<ServiceResult<ScheduleControlResult>>;
  resumeSchedule: (
    principal: Principal,
    scheduleId: string,
  ) => Promise<ServiceResult<ScheduleControlResult>>;
  cancelSchedule: (
    principal: Principal,
    scheduleId: string,
  ) => Promise<ServiceResult<ScheduleControlResult>>;
  triggerSchedule: (
    principal: Principal,
    scheduleId: string,
    request: ScheduleTriggerRequest,
  ) => Promise<ServiceResult<ScheduleDispatch>>;
  scheduleExecutions: (
    principal: Principal,
    scheduleId: string,
    limit?: number,
  ) => Promise<ServiceResult<ScheduleExecutionList>>;
  scheduleEvent: (
    principal: Principal,
    request: ScheduleEventRequest,
  ) => Promise<ServiceResult<ScheduleEventResult>>;
  updateSchedule: (
    principal: Principal,
    scheduleId: string,
    request: ScheduleUpdateRequest,
  ) => Promise<ServiceResult<Schedule>>;
  scheduleUpcoming: (
    principal: Principal,
    scheduleId: string,
    limit?: number,
  ) => Promise<ServiceResult<ScheduleUpcoming>>;
  markNotificationsRead: (principal: Principal) => Promise<NotificationList>;
  /** The background loop that discharges schedules without a client connected. */
  startSchedules: () => void;
  stopSchedules: () => Promise<void>;
  tickSchedules: () => Promise<ScheduleTickReport>;
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

    // Only the generation that actually settled the task may charge the ledger,
    // so a superseded run cannot consume the same inference twice. Without this,
    // Work and scheduled runs would escape the daily token ceiling that Chat
    // already honours.
    if (outcome.kind === 'completed' && outcome.usage) {
      deps.budget.consume(task.ownerId, outcome.usage, deps.clock.now());
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

    const history = await historyFor(task.conversationId, task.objective);
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
        workspaceRoot: workspace.value.root,
        maxSteps: deps.config.engines.native.maxSteps,
        budget: task.budget,
        signal: controller.signal,
      },
      report,
    });
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

  type SubmitOptions = { taskId?: string; conversationId?: string };

  /**
   * The one Work acceptance path, shared by a client request and a scheduled
   * occurrence.
   *
   * A scheduled caller supplies a deterministic task id. If that task already
   * exists the occurrence ran before, and the function refuses before reserving
   * budget or claiming a lease. That is the idempotency boundary the schedule
   * engine relies on, and it reuses the task repository's unique index instead of
   * maintaining a second execution ledger.
   */
  async function acceptTask(
    principal: Principal,
    request: WorkSubmitRequest,
    options: SubmitOptions = {},
  ): Promise<ServiceResult<TaskAccepted>> {
    if (options.taskId) {
      const existing = await deps.tasks.get(options.taskId);
      if (existing) {
        return fail('conflict', 'That occurrence already has a Work task.');
      }
    }

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
    const conversationId =
      options.conversationId ?? request.conversationId ?? deps.ids.conversationId();
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
      taskId: options.taskId ?? deps.ids.taskId(),
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
    // live run per conversation", and the created task carries the unique token
    // that authorizes its terminal write from the first instant.
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
      return created.reason === 'conversation_busy'
        ? fail('busy', 'This conversation already has an active Work task.')
        : fail('conflict', 'That task identity is already in use.');
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
  }

  const schedulePort: SchedulePort = {
    dispatch: async ({ schedule, taskId, conversationId }) => {
      // A dispatch can race the owner's cancellation. The receipt was already
      // written, but no Work may start for a schedule that is no longer active
      // in the cancelled sense.
      const current = await deps.schedules.get(schedule.scheduleId);
      if (!current) {
        return { ok: false, reason: 'refused', detail: 'That schedule no longer exists.' };
      }
      if (current.state === 'cancelled') {
        return { ok: false, reason: 'refused', detail: 'That schedule is cancelled.' };
      }
      const adapter = deps.agents.resolve(current.agent);
      if (!adapter.ok) {
        return { ok: false, reason: 'refused', detail: adapter.detail };
      }
      if (scheduleSideEffectRefusal(adapter.value.sideEffects)) {
        // Defense in depth: a schedule created before this guard existed must
        // not start an ungated run after an upgrade.
        return {
          ok: false,
          reason: 'refused',
          detail: 'This agent is not gateable by owner approval and cannot run from a schedule.',
        };
      }
      const accepted = await acceptTask(
        { ownerId: schedule.ownerId, isOwner: true },
        {
          objective: schedule.objective,
          agent: schedule.agent,
          ...(schedule.model ? { model: schedule.model } : {}),
          mode: schedule.mode,
          ...(schedule.limits.budget ? { budget: schedule.limits.budget } : {}),
          // A schedule never widens autonomy: every side effect still needs a
          // scoped owner decision from the permission store.
          requireApproval: true,
          conversationId,
        },
        { taskId, conversationId },
      );
      if (accepted.ok) {
        // Cancellation may have committed while acceptTask was creating the
        // task. Re-read after acceptance and stop the task we just created; the
        // receipt is still `claimed`, so cancellation marks it terminal.
        const after = await deps.schedules.get(schedule.scheduleId);
        if (!after || after.state === 'cancelled') {
          await service.cancelTask(
            { ownerId: schedule.ownerId, isOwner: true },
            accepted.value.taskId,
            'The schedule was cancelled during dispatch.',
          );
          return {
            ok: false,
            reason: 'refused',
            detail: 'That schedule was cancelled during dispatch.',
          };
        }
        return { ok: true };
      }
      if (accepted.code === 'busy') {
        return { ok: false, reason: 'busy', detail: accepted.detail };
      }
      if (accepted.code === 'budget_exhausted') {
        return { ok: false, reason: 'budget', detail: accepted.detail };
      }
      if (accepted.code === 'conflict') {
        return { ok: false, reason: 'duplicate', detail: accepted.detail };
      }
      return { ok: false, reason: 'refused', detail: accepted.detail };
    },

    taskSnapshot: async (taskId) => {
      const task = await deps.tasks.get(taskId);
      if (!task) return null;
      const reconciled = await reconcile(task);
      return {
        state: reconciled.state,
        summary: reconciled.result?.summary ?? null,
        failure: reconciled.failure
          ? {
              code: reconciled.failure.code,
              retryable: reconciled.failure.retryable !== false,
            }
          : null,
      };
    },
  };

  const scheduleEngine = createScheduleEngine({
    store: deps.schedules,
    notices: deps.scheduleNotices,
    port: schedulePort,
    settings: deps.config.schedules,
    clock: deps.clock,
    ids: deps.ids,
  });

  function toSchedule(record: ScheduleRecord): Schedule {
    return {
      scheduleId: record.scheduleId,
      name: record.name,
      objective: record.objective,
      agent: record.agent,
      mode: record.mode,
      model: record.model,
      timing: record.timing,
      condition: record.condition,
      retry: record.retry,
      priority: record.priority,
      limits: record.limits,
      requireApproval: true,
      missedRunPolicy: record.missedRunPolicy,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nextRunAt: record.nextRunAt,
      lastRunAt: record.lastRunAt,
      lastExecutionId: record.lastExecutionId,
      runsTotal: record.runsTotal,
      consecutiveFailures: record.consecutiveFailures,
      version: record.version,
      pausedAt: record.pausedAt,
      cancelledAt: record.cancelledAt,
      cancelReason: record.cancelReason,
    };
  }

  function toExecution(record: ScheduleExecutionRecord): ScheduleExecution {
    return {
      executionId: record.executionId,
      scheduleId: record.scheduleId,
      occurrenceKey: record.occurrenceKey,
      trigger: record.trigger,
      scheduledFor: record.scheduledFor,
      state: record.state,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      taskId: record.taskId,
      conversationId: record.conversationId,
      priority: record.priority,
      detail: record.detail,
      nextAttemptAt: record.nextAttemptAt,
      condition: record.condition,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
    };
  }

  async function ownedSchedule(
    scheduleId: string,
    principal: Principal,
  ): Promise<ServiceResult<ScheduleRecord>> {
    const record = await deps.schedules.get(scheduleId);
    if (!record || record.ownerId !== principal.ownerId) {
      return fail('not_found', 'That schedule does not exist for this owner.');
    }
    return ok(record);
  }

  function control(
    record: ScheduleRecord,
    outcome: ScheduleControlResult['outcome'],
  ): ScheduleControlResult {
    return { scheduleId: record.scheduleId, state: record.state, outcome };
  }

  const service: ApplicationService = {
    health: () => deps.health.report(),
    readiness: () => deps.health.readiness(),
    agents: () => deps.agents.list(),
    models: () => deps.models.list(),

    submitWork: (principal, request) => acceptTask(principal, request),

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

      const history = await historyFor(conversationId, request.message);
      const controller = new AbortController();
      const outcome = await adapter.value.run(
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
      if (!outcome.ok) {
        return fail(
          outcome.code === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          outcome.detail,
          outcome.retryable,
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

    notifications: async (principal) => {
      const [work, schedule] = await Promise.all([
        deps.notifications.list(principal.ownerId),
        deps.scheduleNotices.list(principal.ownerId, deps.config.schedules.historyLimit),
      ]);
      // One owner-facing list and one unread count. A schedule can fail before a
      // Work task exists, so its notices are a second record kind, not a second
      // notification endpoint.
      return {
        notifications: work.notifications,
        schedules: schedule.notifications,
        unread: work.unread + schedule.unread,
      };
    },

    markNotificationsRead: async (principal) => {
      const work = await deps.notifications.list(principal.ownerId);
      for (const notification of work.notifications) {
        if (!notification.read) {
          await deps.notifications.markRead(principal.ownerId, notification.taskId);
        }
      }
      await deps.scheduleNotices.markAllRead(principal.ownerId);
      return service.notifications(principal);
    },

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

    schedules: async (principal) => ({
      schedules: (await deps.schedules.listByOwner(principal.ownerId)).map(toSchedule),
    }),

    schedule: async (principal, scheduleId) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      return ok(toSchedule(found.value));
    },

    createSchedule: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;
      const sideEffectRefusal = scheduleSideEffectRefusal(adapter.value.sideEffects);
      if (sideEffectRefusal) {
        // Nobody is watching a scheduled occurrence. An adapter this engine
        // cannot gate per action would let a recurrence act without a scoped
        // owner decision, so scheduling refuses it instead of pretending the
        // task-level approval flag protects it.
        return fail('validation_failed', sideEffectRefusal);
      }
      const model = deps.models.resolve(request.model, request.mode);
      if (!model.ok) return model;

      const now = deps.clock.now();
      if (
        request.timing.kind === 'once' &&
        new Date(request.timing.at).getTime() <= now.getTime()
      ) {
        return fail('validation_failed', 'A one-time schedule must be in the future.');
      }
      const first = nextOccurrence(request.timing, now, now);
      if (request.timing.kind !== 'event' && !first) {
        return fail('validation_failed', 'No occurrence could be computed for that timing rule.');
      }

      const nowIso = now.toISOString();
      const record: ScheduleRecord = {
        scheduleId: deps.ids.scheduleId(),
        ownerId: principal.ownerId,
        name: request.name,
        objective: request.objective,
        agent: agentId,
        model: model.value.ref,
        mode: request.mode,
        timing: request.timing,
        condition: request.condition,
        retry: request.retry,
        priority: request.priority,
        limits: request.limits,
        requireApproval: true,
        missedRunPolicy: request.missedRunPolicy,
        state: request.enabled ? 'active' : 'paused',
        createdAt: nowIso,
        updatedAt: nowIso,
        nextRunAt: request.enabled && first ? first.toISOString() : null,
        lastRunAt: null,
        lastExecutionId: null,
        runsTotal: 0,
        consecutiveFailures: 0,
        version: 0,
        pausedAt: request.enabled ? null : nowIso,
        cancelledAt: null,
        cancelReason: null,
      };
      const created = await deps.schedules.create(record);
      if (!created.ok) {
        return fail('conflict', 'That schedule identity is already in use.');
      }
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.created',
        outcome: 'accepted',
        detail: `schedule=${record.scheduleId} priority=${record.priority}`,
      });
      return ok(toSchedule(created.schedule));
    },

    pauseSchedule: async (principal, scheduleId) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      const record = found.value;
      if (record.state === 'cancelled' || record.state === 'exhausted') {
        return ok(control(record, 'already_terminal'));
      }
      if (record.state === 'paused') return ok(control(record, 'unchanged'));
      const applied = await deps.schedules.update({
        scheduleId,
        expectedVersion: record.version,
        patch: {
          state: 'paused',
          nextRunAt: null,
          pausedAt: deps.clock.iso(),
          updatedAt: deps.clock.iso(),
        },
      });
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.paused',
        outcome: 'accepted',
        detail: `schedule=${scheduleId}`,
      });
      return ok(control(applied.schedule ?? record, applied.applied ? 'accepted' : 'unchanged'));
    },

    resumeSchedule: async (principal, scheduleId) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      const record = found.value;
      if (record.state === 'cancelled' || record.state === 'exhausted') {
        return ok(control(record, 'already_terminal'));
      }
      if (record.state === 'active') return ok(control(record, 'unchanged'));

      const now = deps.clock.now();
      const next = nextOccurrence(record.timing, now, new Date(record.createdAt));
      if (record.timing.kind !== 'event' && !next) {
        return fail(
          'validation_failed',
          'That schedule has no future occurrence; create a new one instead of resuming it.',
        );
      }
      const applied = await deps.schedules.update({
        scheduleId,
        expectedVersion: record.version,
        patch: {
          state: 'active',
          nextRunAt: next ? next.toISOString() : null,
          pausedAt: null,
          updatedAt: deps.clock.iso(),
        },
      });
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.resumed',
        outcome: 'accepted',
        detail: `schedule=${scheduleId}`,
      });
      return ok(control(applied.schedule ?? record, applied.applied ? 'accepted' : 'unchanged'));
    },

    cancelSchedule: async (principal, scheduleId) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      const record = found.value;
      if (record.state === 'cancelled') return ok(control(record, 'already_terminal'));

      const now = deps.clock.iso();
      const applied = await deps.schedules.update({
        scheduleId,
        expectedVersion: record.version,
        patch: {
          state: 'cancelled',
          nextRunAt: null,
          cancelledAt: now,
          cancelReason: 'The owner cancelled the schedule.',
          updatedAt: now,
        },
      });
      if (!applied.applied) {
        // A concurrent tick changed the record. Never acknowledge a
        // cancellation that did not commit: report the current state so the
        // client can retry against the new version.
        const latest = await deps.schedules.get(scheduleId);
        if (!latest) return fail('not_found', 'That schedule no longer exists.');
        if (latest.state === 'cancelled') return ok(control(latest, 'already_terminal'));
        return fail('conflict', 'The schedule changed while it was being cancelled; retry.');
      }
      const cancelled = applied.schedule ?? record;

      // A live run is stopped through the durable lease, not by writing its task
      // record here: only the generation that holds the token may settle it.
      const executions = await deps.schedules.listExecutions(
        scheduleId,
        deps.config.schedules.historyLimit,
      );
      for (const execution of executions) {
        if (isTerminalExecution(execution.state)) continue;
        if (execution.state === 'retry_wait' || execution.state === 'claimed') {
          // A claimed receipt may already have a live task: dispatch writes the
          // receipt first and the task second. Cancel the task through the
          // durable lease before terminalizing the receipt, otherwise a run the
          // owner cancelled keeps executing with no receipt to reconcile.
          if (execution.taskId) {
            await service.cancelTask(principal, execution.taskId, 'The schedule was cancelled.');
          }
          await deps.schedules.updateExecution({
            executionId: execution.executionId,
            from: ['retry_wait', 'claimed'],
            patch: {
              state: 'cancelled',
              detail: 'The schedule was cancelled.',
              updatedAt: now,
              finishedAt: now,
            },
          });
          continue;
        }
        if (execution.state === 'dispatched' && execution.taskId) {
          await service.cancelTask(principal, execution.taskId, 'The schedule was cancelled.');
        }
      }

      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.cancelled',
        outcome: 'accepted',
        detail: `schedule=${scheduleId}`,
      });
      return ok(control(cancelled, 'accepted'));
    },

    triggerSchedule: async (principal, scheduleId, request) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      if (found.value.state === 'cancelled') {
        return fail('conflict', 'That schedule is cancelled.');
      }
      const key = request.idempotencyKey ?? deps.ids.executionId();
      const dispatch = await scheduleEngine.trigger({
        schedule: found.value,
        occurrenceKey: `manual:${key}`,
        trigger: 'manual',
      });
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.triggered',
        outcome: dispatch.state === 'refused' ? 'refused' : 'accepted',
        detail: `schedule=${scheduleId} execution=${dispatch.executionId}`,
      });
      return ok(dispatch);
    },

    scheduleExecutions: async (principal, scheduleId, limit) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      const bounded = Math.min(
        Math.max(1, limit ?? deps.config.schedules.historyLimit),
        500,
      );
      const records = await deps.schedules.listExecutions(scheduleId, bounded);
      return ok({ executions: records.map(toExecution) });
    },

    scheduleEvent: async (principal, request) => {
      const active = await deps.schedules.listActive();
      const matching = active.filter(
        (record) =>
          record.ownerId === principal.ownerId &&
          record.timing.kind === 'event' &&
          record.timing.event === request.event,
      );
      const dispatched: ScheduleDispatch[] = [];
      for (const record of matching) {
        dispatched.push(
          await scheduleEngine.trigger({
            schedule: record,
            occurrenceKey: `event:${request.event}:${request.idempotencyKey}`,
            trigger: 'event',
          }),
        );
      }
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.event',
        outcome: 'accepted',
        detail: `event=${request.event} schedules=${dispatched.length}`,
      });
      return ok({ event: request.event, dispatched });
    },

    updateSchedule: async (principal, scheduleId, request) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      const record = found.value;
      if (record.state === 'cancelled' || record.state === 'exhausted') {
        return fail('conflict', 'A terminal schedule cannot be edited.');
      }

      const now = deps.clock.now();
      const timing = request.timing ?? record.timing;
      if (timing.kind === 'once' && new Date(timing.at).getTime() <= now.getTime()) {
        return fail('validation_failed', 'A one-time schedule must be in the future.');
      }

      const enabled = request.enabled ?? record.state === 'active';
      const timingChanged = request.timing !== undefined;
      const enabledChanged = enabled !== (record.state === 'active');
      let nextRunAt = record.nextRunAt;
      if (!enabled) {
        nextRunAt = null;
      } else if (timingChanged || enabledChanged || nextRunAt === null) {
        const next = nextOccurrence(timing, now, new Date(record.createdAt));
        if (timing.kind !== 'event' && !next) {
          return fail(
            'validation_failed',
            'That timing rule has no future occurrence; the schedule was not changed.',
          );
        }
        nextRunAt = next ? next.toISOString() : null;
      }

      const nowIso = now.toISOString();
      const applied = await deps.schedules.update({
        scheduleId,
        expectedVersion: record.version,
        patch: {
          name: request.name ?? record.name,
          timing,
          condition: request.condition ?? record.condition,
          retry: request.retry ?? record.retry,
          priority: request.priority ?? record.priority,
          limits: request.limits ? { ...record.limits, ...request.limits } : record.limits,
          missedRunPolicy: request.missedRunPolicy ?? record.missedRunPolicy,
          state: enabled ? 'active' : 'paused',
          nextRunAt,
          pausedAt: enabled ? null : (record.pausedAt ?? nowIso),
          updatedAt: nowIso,
        },
      });
      if (!applied.applied || !applied.schedule) {
        return fail('conflict', 'The schedule changed while this edit was applied; retry.');
      }
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.updated',
        outcome: 'accepted',
        detail: `schedule=${scheduleId}`,
      });
      return ok(toSchedule(applied.schedule));
    },

    scheduleUpcoming: async (principal, scheduleId, limit) => {
      const found = await ownedSchedule(scheduleId, principal);
      if (!found.ok) return found;
      if (found.value.state === 'cancelled' || found.value.state === 'exhausted') {
        return ok({ scheduleId, occurrences: [] });
      }
      const bounded = Math.min(Math.max(1, limit ?? 5), 20);
      return ok({
        scheduleId,
        occurrences: previewOccurrences(found.value, deps.clock.now(), bounded),
      });
    },

    startSchedules: () => scheduleEngine.start(),
    stopSchedules: () => scheduleEngine.stop(),
    tickSchedules: () => scheduleEngine.tick(),

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
      await scheduleEngine.stop();
      deps.scheduler.stop();
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };

  return service;
}
