import type {
  AgentId,
  AgentList,
  ArtifactContent,
  ArtifactDescriptorList,
  ArtifactUploadResult,
  TaskArtifactUploadRequestInput,
  BudgetState,
  ChatReply,
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationList,
  DataMode,
  ExecutionEvent,
  MemoryDeleteRequest,
  MemoryList,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteRequest,
  ModelList,
  NotificationList,
  PermissionDecisionRequest,
  PermissionList,
  Schedule,
  ScheduleCancellation,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleExecution,
  ScheduleExecutionList,
  ScheduleList,
  ScheduleRemoval,
  ScheduleUpdateRequest,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskListQuery,
  TaskStatus,
  WorkSubmitRequest,
} from '@coderax/contracts';
import {
  CHAT_STREAM_VERSION,
  EVENT_SCHEMA_VERSION,
  isTerminalEvent,
  isTerminalState,
  modelKey,
} from '@coderax/contracts';
import type { EngineFailureCode, ModelDescriptor, ProblemCode } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { ScheduleExecutionRecord, ScheduleRecord, TaskRecord } from '../domain.js';
import { MemoryValueTooLargeError } from '../memory/errors.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { IdempotencyStore } from '../persistence/idempotency.js';
import type { LeaseStore, RunScope } from '../execution/lease.js';
import { workRunKey } from '../execution/lease.js';
import type { TaskRunner, RunOutcome } from '../execution/runner.js';
import type { AgentRegistry } from '../agents/registry.js';
import type {
  AgentAdapter,
  AgentHistoryTurn,
  AgentReport,
  AgentReportEvent,
  AgentRunOutcome,
} from '../agents/types.js';
import { redactContent, redactText, redactToolInput } from '../observability/redact.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { BudgetLedger } from '../models/budget.js';
import type { PermissionStore } from '../permissions/store.js';
import type { MemoryStore } from '../memory/store.js';
import type { ArtifactService } from '../artifacts/service.js';
import type { AuditLog } from '../observability/audit.js';
import type { HealthService } from '../observability/health.js';
import type { EventBus, Replay, Unsubscribe } from '../events/bus.js';
import type { EventLog } from '../events/log.js';
import type { ScheduleStore } from '../scheduling/store.js';
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
  artifactService: ArtifactService;
  schedules: ScheduleStore;
  idempotency: IdempotencyStore;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  /**
   * Durable history for events the bus published. Absent on the memory driver,
   * where the bus buffer is the only history there is.
   */
  eventLog?: EventLog | null;
};

export type EventStream = {
  replay: Replay;
  subscribe: (listener: (event: unknown) => void) => Unsubscribe;
  lastSeq: number;
  /**
   * Present when the requested cursor is older than the retained window. The
   * stream sends it first so a client knows the events that follow are not the
   * whole history rather than silently rendering a gap.
   */
  truncatedEvent: ExecutionEvent | null;
  /**
   * True when the replay already contains the terminal event, or when the task
   * is terminal and the cursor is at the end of the log. The stream then closes
   * instead of waiting for a frame that will never be published again.
   */
  closedAfterReplay: boolean;
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
  tasks: (principal: Principal, query: TaskListQuery) => Promise<TaskList>;
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
  /** The same turn, reported as versioned frames instead of one reply. */
  chatStream: (
    principal: Principal,
    request: ChatRequest,
  ) => Promise<ServiceResult<AsyncIterable<ChatStreamEvent>>>;
  conversations: (principal: Principal) => Promise<ConversationList>;
  conversation: (
    principal: Principal,
    conversationId: string,
  ) => Promise<ServiceResult<Conversation>>;
  memory: (principal: Principal, mode: DataMode) => Promise<MemoryList>;
  writeMemory: (
    principal: Principal,
    body: MemoryWriteRequest,
  ) => Promise<ServiceResult<MemoryList>>;
  deleteMemory: (principal: Principal, body: MemoryDeleteRequest) => Promise<MemoryList>;
  searchMemory: (principal: Principal, query: MemorySearchQuery) => Promise<MemorySearchResult>;
  permissions: (principal: Principal, taskId: string) => Promise<ServiceResult<PermissionList>>;
  decidePermission: (
    principal: Principal,
    taskId: string,
    body: PermissionDecisionRequest,
  ) => Promise<ServiceResult<PermissionList>>;
  notifications: (principal: Principal) => Promise<NotificationList>;
  markNotificationRead: (
    principal: Principal,
    taskId: string,
  ) => Promise<ServiceResult<NotificationList>>;
  /** Durable artifact storage; the only path that returns artifact bytes. */
  artifacts: ArtifactService;
  taskArtifacts: (
    principal: Principal,
    taskId: string,
  ) => Promise<ServiceResult<ArtifactDescriptorList>>;
  taskArtifact: (
    principal: Principal,
    taskId: string,
    artifactId: string,
  ) => Promise<ServiceResult<ArtifactContent>>;
  createTaskArtifact: (
    principal: Principal,
    taskId: string,
    body: TaskArtifactUploadRequestInput,
  ) => Promise<ServiceResult<ArtifactUploadResult>>;
  schedules: (principal: Principal) => Promise<ScheduleList>;
  createSchedule: (
    principal: Principal,
    request: ScheduleCreateRequest,
  ) => Promise<ServiceResult<Schedule>>;
  schedule: (principal: Principal, scheduleId: string) => Promise<ServiceResult<Schedule>>;
  updateSchedule: (
    principal: Principal,
    scheduleId: string,
    request: ScheduleUpdateRequest,
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
  ) => Promise<ServiceResult<ScheduleCancellation>>;
  scheduleExecutions: (
    principal: Principal,
    scheduleId: string,
    limit: number,
  ) => Promise<ServiceResult<ScheduleExecutionList>>;
  removeSchedule: (
    principal: Principal,
    scheduleId: string,
  ) => Promise<ServiceResult<ScheduleRemoval>>;
  /** Submits every due schedule. Called by the engine's timer, not by a client. */
  tickSchedules: () => Promise<{ started: number; skipped: number }>;
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

/** An engine failure is reported to Chat clients with a stable Problem code. */
function problemCodeFor(code: EngineFailureCode): ProblemCode {
  switch (code) {
    case 'cancelled':
      return 'cancelled';
    case 'workspace_denied':
      return 'workspace_denied';
    case 'not_configured':
      return 'engine_not_configured';
    case 'busy':
      return 'busy';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'paid_model_refused':
      return 'paid_model_refused';
    case 'protocol_error':
      return 'protocol_error';
    default:
      return 'engine_unavailable';
  }
}

type ChatPrepared = {
  adapter: AgentAdapter;
  model: ModelDescriptor;
  conversationId: string;
  tenantId: string | null;
  mode: DataMode;
  workspaceRoot: string;
  messageId: string;
  history: AgentHistoryTurn[];
};

function toSchedule(record: ScheduleRecord): Schedule {
  return {
    scheduleId: record.scheduleId,
    objective: record.objective,
    agent: record.agent,
    mode: record.mode,
    intervalMs: record.intervalMs,
    enabled: record.enabled,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.nextRunAt ? { nextRunAt: record.nextRunAt } : {}),
    ...(record.lastRunAt ? { lastRunAt: record.lastRunAt } : {}),
    ...(record.lastTaskId ? { lastTaskId: record.lastTaskId } : {}),
    runs: record.runs,
    skipped: record.skipped,
  };
}

function toScheduleExecution(record: ScheduleExecutionRecord): ScheduleExecution {
  return {
    at: record.at,
    outcome: record.outcome,
    nextRunAt: record.nextRunAt,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.code ? { code: record.code } : {}),
  };
}

export function createApplicationService(deps: ApplicationServiceDeps): ApplicationService {
  const controllers = new Map<string, AbortController>();
  const pendingSubmissions = new Map<string, () => Promise<ServiceResult<TaskAccepted>>>();
  const eventLog = deps.eventLog ?? null;

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

  /**
   * The union of stored history and the live buffer, ordered by sequence and
   * deduplicated by id. After a restart the live buffer is empty and the durable
   * log is the whole replay; while a run is live the two overlap.
   */
  function mergeReplay(durable: ExecutionEvent[], live: ExecutionEvent[]): ExecutionEvent[] {
    const byId = new Map<string, ExecutionEvent>();
    for (const event of durable) byId.set(event.eventId, event);
    for (const event of live) byId.set(event.eventId, event);
    return [...byId.values()].sort((left, right) => left.seq - right.seq);
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

  function acceptedFor(task: TaskRecord, replayed?: boolean): TaskAccepted {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      generation: task.generation,
      eventsPath: `/v1/work/${task.taskId}/events`,
      ...(replayed ? { replayed: true } : {}),
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
    let patch: Parameters<TaskRepository['updateFenced']>[0]['patch'];
    if (outcome.kind === 'completed') {
      const summary = outcome.summary.slice(0, 20_000);
      patch = {
        state: 'completed',
        updatedAt: now,
        result: { summary, artifacts: [] },
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      };
    } else if (outcome.kind === 'cancelled') {
      patch = { state: 'cancelled', updatedAt: now };
    } else {
      patch = {
        state: 'failed',
        updatedAt: now,
        failure: {
          code: outcome.code,
          detail: outcome.detail,
          retryable: outcome.retryable,
        },
      };
    }

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

  async function prepareChat(
    principal: Principal,
    request: ChatRequest,
  ): Promise<ServiceResult<ChatPrepared>> {
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

    return ok({
      adapter: adapter.value,
      model: model.value,
      conversationId,
      tenantId: conversation.tenantId,
      mode: request.mode,
      workspaceRoot: workspace.value.root,
      messageId: deps.ids.messageId(),
      history: await historyFor(conversationId, request.message),
    });
  }

  function runPreparedChat(
    prepared: ChatPrepared,
    principal: Principal,
    request: ChatRequest,
    report: AgentReport,
  ): Promise<AgentRunOutcome> {
    const controller = new AbortController();
    return prepared.adapter.run(
      {
        ownerId: principal.ownerId,
        tenantId: prepared.tenantId,
        conversationId: prepared.conversationId,
        objective: request.message,
        history: prepared.history,
        model: prepared.model.ref,
        mode: prepared.mode,
        workspaceRoot: prepared.workspaceRoot,
        maxSteps: 1,
        budget: null,
        signal: controller.signal,
      },
      report,
    );
  }

  /** One place that records the reply, so streaming and JSON cannot diverge. */
  async function finishChat(
    prepared: ChatPrepared,
    principal: Principal,
    request: ChatRequest,
    outcome: AgentRunOutcome,
  ): Promise<ServiceResult<ChatReply>> {
    if (!outcome.ok) {
      return fail(problemCodeFor(outcome.code), outcome.detail, outcome.retryable);
    }
    deps.budget.consume(principal.ownerId, outcome.usage ?? {}, deps.clock.now());
    const createdAt = deps.clock.iso();
    await deps.conversations.appendMessage({
      messageId: prepared.messageId,
      conversationId: prepared.conversationId,
      role: 'assistant',
      text: outcome.summary,
      createdAt,
      agent: request.agent,
    });
    return ok({
      conversationId: prepared.conversationId,
      messageId: prepared.messageId,
      text: outcome.summary,
      agent: request.agent,
      model: prepared.model.ref,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      createdAt,
    });
  }

  /**
   * Streams the same turn as frames.
   *
   * Text is redacted up to the last whitespace boundary before it is sent, for
   * the same reason the Work stream does it: a credential split across two
   * deltas would otherwise reach the client in pieces that match nothing.
   */
  async function* streamChat(
    prepared: ChatPrepared,
    principal: Principal,
    request: ChatRequest,
  ): AsyncGenerator<ChatStreamEvent> {
    yield {
      v: CHAT_STREAM_VERSION,
      type: 'chat.started',
      conversationId: prepared.conversationId,
      messageId: prepared.messageId,
      agent: request.agent,
      model: prepared.model.ref,
    };

    const queue: ChatStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let raw = '';
    let sent = '';
    const box: { outcome: AgentRunOutcome | null } = { outcome: null };

    const push = (frame: ChatStreamEvent): void => {
      queue.push(frame);
      wake?.();
    };
    const flush = (final: boolean): void => {
      let end = raw.length;
      if (!final) {
        while (end > 0 && !/\s/.test(raw.charAt(end - 1))) end -= 1;
      }
      const safe = redactContent(raw.slice(0, end));
      if (safe === sent) return;
      if (safe.startsWith(sent)) {
        push({ v: CHAT_STREAM_VERSION, type: 'chat.delta', text: safe.slice(sent.length) });
      } else {
        push({ v: CHAT_STREAM_VERSION, type: 'chat.replace', text: safe });
      }
      sent = safe;
    };

    const running = runPreparedChat(prepared, principal, request, (event) => {
      if (event.type === 'text.delta') {
        raw += event.text;
        flush(false);
        return;
      }
      if (event.type === 'text.replace') {
        raw = event.text;
        sent = '';
        push({ v: CHAT_STREAM_VERSION, type: 'chat.replace', text: redactContent(raw) });
        sent = redactContent(raw);
      }
      // Step, tool and approval reports belong to a durable Work task. A Chat
      // turn has no task, so they are not translated into frames it cannot own.
    })
      .then((outcome) => {
        box.outcome = outcome;
      })
      .catch(() => {
        box.outcome = {
          ok: false,
          code: 'provider_error',
          detail: 'The agent failed unexpectedly.',
          retryable: false,
        };
      })
      .finally(() => {
        finished = true;
        wake?.();
      });

    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, 30_000);
        timer.unref();
      });
      wake = null;
    }
    await running;

    const outcome = box.outcome;
    if (!outcome) {
      yield {
        v: CHAT_STREAM_VERSION,
        type: 'chat.failed',
        code: 'internal_error',
        detail: 'The turn ended without a result.',
        retryable: true,
      };
      return;
    }
    if (!outcome.ok) {
      yield {
        v: CHAT_STREAM_VERSION,
        type: 'chat.failed',
        code: problemCodeFor(outcome.code),
        detail: outcome.detail,
        retryable: outcome.retryable,
      };
      return;
    }

    // The adapter's summary is authoritative; any unflushed tail is sent now.
    flush(true);
    const finalText = redactContent(outcome.summary);
    if (finalText !== sent && finalText.startsWith(sent) && finalText.length > sent.length) {
      push({ v: CHAT_STREAM_VERSION, type: 'chat.delta', text: finalText.slice(sent.length) });
    } else if (finalText !== sent) {
      push({ v: CHAT_STREAM_VERSION, type: 'chat.replace', text: finalText });
    }
    for (const frame of queue) yield frame;
    const finishedReply = await finishChat(prepared, principal, request, {
      ...outcome, summary: finalText,
    }).catch(() => fail('internal_error', 'The reply could not be saved.'));
    if (!finishedReply.ok) {
      yield {
        v: CHAT_STREAM_VERSION,
        type: 'chat.failed',
        code: finishedReply.code,
        detail: finishedReply.detail,
        retryable: finishedReply.retryable,
      };
      return;
    }
    yield { v: CHAT_STREAM_VERSION, type: 'chat.completed', reply: finishedReply.value };
  }

  let ticking = false;
  async function tick() {
    const due = deps.schedules.due(deps.clock.now());
    let started = 0;
    let skipped = 0;
    for (const schedule of due) {
      // `due()` hands back copies, and an owner can pause or delete a schedule
      // while an earlier submission in this same tick is awaiting. Re-read the
      // record so a stale slot is never fired.
      const current = deps.schedules.get(schedule.ownerId, schedule.scheduleId);
      if (!current || !current.enabled || current.nextRunAt !== schedule.nextRunAt) {
        skipped += 1;
        continue;
      }
      const principal: Principal = { ownerId: schedule.ownerId, isOwner: true };
      // The firing time is part of the idempotency key, so a tick that overlaps
      // another tick cannot submit the same slot twice.
      const submitted = await service.submitWork(principal, {
        objective: schedule.objective,
        agent: schedule.agent,
        mode: schedule.mode,
        requireApproval: true,
        ...(schedule.conversationId ? { conversationId: schedule.conversationId } : {}),
        idempotencyKey: `schedule:${schedule.scheduleId}:${schedule.nextRunAt ?? ''}`,
      });
      const at = deps.clock.iso();
      const nextRunAt = new Date(
        deps.clock.now().getTime() + schedule.intervalMs,
      ).toISOString();
      if (submitted.ok) {
        deps.schedules.markRun({
          scheduleId: schedule.scheduleId,
          at,
          taskId: submitted.value.taskId,
          nextRunAt,
        });
        started += 1;
      } else {
        // Busy or refused: move to the next slot instead of hammering the
        // conversation every tick.
        deps.schedules.markSkipped({
          scheduleId: schedule.scheduleId,
          at,
          nextRunAt,
          code: submitted.code,
        });
        deps.audit.record({
          actor: schedule.ownerId,
          action: 'schedule.skipped',
          outcome: 'refused',
          detail: submitted.code,
        });
        skipped += 1;
      }
    }
    return { started, skipped };
  }

  /**
   * Pause and resume share one state change: the verb is explicit, the
   * decision (and the slot movement) belongs to the store. Repeating a verb is
   * reported as `unchanged` and does not move `nextRunAt`.
   */
  async function setScheduleEnabled(
    principal: Principal,
    scheduleId: string,
    enabled: boolean,
  ): Promise<ServiceResult<ScheduleControlResult>> {
    const existing = deps.schedules.get(principal.ownerId, scheduleId);
    if (!existing) return fail('not_found', 'That schedule does not exist for this owner.');
    const changed = existing.enabled !== enabled;
    const record = deps.schedules.setEnabled({ ownerId: principal.ownerId, scheduleId, enabled });
    if (!record) return fail('not_found', 'That schedule does not exist for this owner.');
    deps.audit.record({
      actor: principal.ownerId,
      action: enabled ? 'schedule.resumed' : 'schedule.paused',
      outcome: changed ? 'accepted' : 'refused',
    });
    return ok({
      scheduleId: record.scheduleId,
      enabled: record.enabled,
      ...(record.nextRunAt ? { nextRunAt: record.nextRunAt } : {}),
      runs: record.runs,
      outcome: changed ? 'accepted' : 'unchanged',
    });
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

      const idempotencyKey = request.idempotencyKey?.trim();
      const taskId = deps.ids.taskId();

      // A key is checked before a budget slot is spent: a retried submission is
      // the same intent, and charging it twice would let a network retry exhaust
      // the owner's daily budget.
      const intent = idempotencyKey ? { ownerId: principal.ownerId, key: idempotencyKey, taskId } : null;
      if (intent) {
        const reservation = await deps.idempotency.reserve(intent);
        if (!reservation.ok) {
          const prior = reservation.completedTaskId ? await deps.tasks.get(reservation.completedTaskId) : null;
          if (prior?.ownerId === principal.ownerId) return ok(acceptedFor(prior, true));
          const recover = reservation.pendingTaskId && pendingSubmissions.get(reservation.pendingTaskId);
          if (recover) return recover();
          return fail('busy', 'The submission has not yet been confirmed.', true);
        }
      }
      const releaseKey = async (): Promise<void> => {
        if (intent) await deps.idempotency.release(intent);
      };

      const reservation = deps.budget.reserve(principal.ownerId, deps.clock.now());
      if (!reservation.allowed) {
        await releaseKey();
        return fail(
          'budget_exhausted',
          'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
        );
      }

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      try {
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
      } catch (error) {
        await releaseKey();
        throw error;
      }

      const task: TaskRecord = {
        taskId,
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
      }).catch(async (error: unknown) => {
        await releaseKey();
        throw error;
      });
      if (!claimed) {
        await releaseKey();
        return fail('busy', 'This conversation already has a live Work run.');
      }

      const accept = async (
        stored: TaskRecord,
        replayed = false,
      ): Promise<ServiceResult<TaskAccepted>> => {
        publish(stored, 'task.queued');
        deps.audit.record({
          actor: principal.ownerId,
          action: 'work.accepted',
          taskId,
          conversationId,
          outcome: 'accepted',
          detail: `agent=${agentId} model=${modelKey(model.value.ref)}`,
        });
        deps.scheduler.enqueue(() => execute(taskId, token));
        // A durable key is completed before the submission is answered, so a
        // retry after a restart replays this task instead of starting another.
        if (intent) await deps.idempotency.complete(intent);
        return ok(acceptedFor(stored, replayed));
      };

      const messageId = deps.ids.messageId();
      const discard = async (): Promise<void> => {
        await deps.conversations.removeMessage(conversationId, messageId);
        await deps.lease.release({ key, token });
        await releaseKey();
      };

      // Only the original submitter can reconcile an in-flight insert. Once it
      // fails, let retries check that same task ID without creating another run.
      const notSaved = () => fail('internal_error', 'The submission could not be saved. Retry the request.', true);
      const retryableRecovery = (recover: (replayed: boolean) => Promise<ServiceResult<TaskAccepted> | null>) => {
        let running = false;
        const attempt = async (replayed: boolean): Promise<ServiceResult<TaskAccepted>> => {
          if (running) return fail('busy', 'The submission has not yet been confirmed.', true);
          running = true;
          try {
            const result = await recover(replayed);
            if (result === null) return fail('busy', 'The submission has not yet been confirmed.', true);
            pendingSubmissions.delete(taskId);
            return result;
          } finally {
            running = false;
          }
        };
        if (intent) pendingSubmissions.set(taskId, () => attempt(true));
        return attempt(false);
      };

      try {
        await deps.conversations.appendMessage({
          messageId,
          conversationId,
          role: 'user',
          text: request.objective,
          createdAt: now,
        });
      } catch {
        return retryableRecovery(async () => {
          await discard();
          return notSaved();
        });
      }

      let created;
      try {
        created = await deps.tasks.create({
          ...task,
          runToken: token,
          leaseExpiresAt: new Date(
            claimedAt.getTime() + deps.config.execution.leaseTtlMs,
          ).toISOString(),
        });
      } catch {
        return retryableRecovery(async (replayed) => {
          const stored = await deps.tasks.get(taskId).catch(() => undefined);
          if (stored?.runToken === token && stored.ownerId === task.ownerId) return accept(stored, replayed);
          if (stored !== null) return null;
          await discard();
          return notSaved();
        });
      }
      if (created.ok) return accept(created.task);
      return retryableRecovery(async () => {
        await discard();
        return fail(
          'busy',
          created.reason === 'conversation_busy'
            ? 'This conversation already has an active Work task.'
            : 'That task identity is already in use.',
        );
      });

    },

    tasks: async (principal, query) => {
      const all = await deps.tasks.listByOwner(principal.ownerId);
      const filtered = all
        .filter((task) => query.state === undefined || task.state === query.state)
        .filter(
          (task) =>
            query.conversationId === undefined || task.conversationId === query.conversationId,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const limit = query.limit ?? 50;
      return {
        tasks: filtered.slice(0, limit).map((task) => ({
          taskId: task.taskId,
          conversationId: task.conversationId,
          title: task.objective.slice(0, 300),
          state: task.state,
          agent: task.agent,
          mode: task.mode,
          ...(task.model ? { model: task.model } : {}),
          generation: task.generation,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          cancelRequested: task.cancelRequested,
        })),
      };
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
            path: artifact.relativePath ?? artifact.filename,
            bytes: artifact.bytes,
            digest: artifact.sha256,
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
      const prepared = await prepareChat(principal, request);
      if (!prepared.ok) return prepared;
      const outcome = await runPreparedChat(prepared.value, principal, request, () => undefined);
      return finishChat(prepared.value, principal, request, outcome);
    },

    chatStream: async (principal, request) => {
      // Everything that can be a Problem is decided before the first frame, so a
      // client either gets SSE or a normal error body, never a 200 that fails.
      const prepared = await prepareChat(principal, request);
      if (!prepared.ok) return prepared;
      return ok(streamChat(prepared.value, principal, request));
    },

    conversations: (principal) => deps.conversations.list(principal.ownerId),

    conversation: async (principal, conversationId) => {
      const record = await deps.conversations.get(principal.ownerId, conversationId);
      if (!record) return fail('not_found', 'That conversation does not exist for this owner.');
      return ok(await deps.conversations.toContract(record));
    },

    memory: (principal, mode) => deps.memory.list({ ownerId: principal.ownerId, mode }),

    writeMemory: async (principal, body) => {
      try {
        await deps.memory.put({
          ownerId: principal.ownerId,
          tenantId: null,
          mode: body.mode,
          key: body.key,
          value: body.value,
        });
      } catch (error) {
        // Only the bound guard is a validation failure. A storage outage must not
        // tell the owner that a valid value is too large.
        if (!(error instanceof MemoryValueTooLargeError)) throw error;
        return fail(
          'validation_failed',
          `That memory value exceeds the configured bound of ${error.maxValueLength} characters.`,
        );
      }
      return ok(await deps.memory.list({ ownerId: principal.ownerId, mode: body.mode }));
    },

    deleteMemory: async (principal, body) => {
      await deps.memory.delete({
        ownerId: principal.ownerId,
        mode: body.mode,
        key: body.key,
      });
      return deps.memory.list({ ownerId: principal.ownerId, mode: body.mode });
    },

    searchMemory: (principal, query) =>
      deps.memory.search({
        ownerId: principal.ownerId,
        mode: query.mode ?? 'private',
        query: query.q,
        limit: query.limit ?? 20,
      }),

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

    markNotificationRead: async (principal, taskId) => {
      const marked = await deps.notifications.markRead(principal.ownerId, taskId);
      if (!marked) return fail('not_found', 'That notification does not exist for this owner.');
      return ok(await deps.notifications.list(principal.ownerId));
    },

    artifacts: deps.artifactService,

    /**
     * The task routes are projections, not a second artifact authority: a task
     * only scopes the same owner- and mode-partitioned store the global routes
     * use. A known artifact id that belongs to another task is reported absent.
     */
    taskArtifacts: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return deps.artifactService.list(principal, {
        mode: found.value.mode,
        taskId,
        limit: 200,
      });
    },

    taskArtifact: async (principal, taskId, artifactId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const descriptor = await deps.artifactService.get(
        principal,
        artifactId,
        found.value.mode,
      );
      if (!descriptor.ok) return descriptor;
      if (descriptor.value.taskId !== taskId) {
        return fail('not_found', 'That artifact does not exist for this task.');
      }
      return deps.artifactService.download(principal, artifactId, { mode: found.value.mode });
    },

    createTaskArtifact: async (principal, taskId, body) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return deps.artifactService.upload(principal, {
        ...body,
        mode: found.value.mode,
        taskId,
        conversationId: found.value.conversationId,
      });
    },

    schedules: async (principal) => ({
      schedules: deps.schedules.list(principal.ownerId).map(toSchedule),
    }),

    createSchedule: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;
      // A schedule that can never run is refused now, not discovered at the first
      // firing when no client is watching.
      const model = deps.models.resolve(null, request.mode);
      if (!model.ok) return model;

      const record = deps.schedules.create({
        ownerId: principal.ownerId,
        objective: request.objective,
        agent: agentId,
        mode: request.mode,
        intervalMs: request.intervalMs,
        enabled: request.enabled,
        startAt: request.startAt ?? null,
        conversationId: request.conversationId ?? null,
      });
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.created',
        outcome: 'accepted',
        detail: `agent=${agentId} intervalMs=${request.intervalMs}`,
      });
      return ok(toSchedule(record));
    },

    schedule: async (principal, scheduleId) => {
      const record = deps.schedules.get(principal.ownerId, scheduleId);
      if (!record) return fail('not_found', 'That schedule does not exist for this owner.');
      return ok(toSchedule(record));
    },

    updateSchedule: async (principal, scheduleId, request) => {
      const existing = deps.schedules.get(principal.ownerId, scheduleId);
      if (!existing) return fail('not_found', 'That schedule does not exist for this owner.');
      if (Object.keys(request).length === 0) {
        return fail('validation_failed', 'An update must change at least one field.');
      }
      // A schedule that can never run is refused at edit time, not discovered
      // at the next firing when no client is watching.
      if (request.agent !== undefined) {
        const adapter = deps.agents.resolve(request.agent);
        if (!adapter.ok) return adapter;
      }
      if (request.agent !== undefined || request.mode !== undefined) {
        const model = deps.models.resolve(null, request.mode ?? existing.mode);
        if (!model.ok) return model;
      }
      const record = deps.schedules.update({
        ownerId: principal.ownerId,
        scheduleId,
        patch: {
          ...(request.objective !== undefined ? { objective: request.objective } : {}),
          ...(request.agent !== undefined ? { agent: request.agent } : {}),
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
          ...(request.intervalMs !== undefined ? { intervalMs: request.intervalMs } : {}),
          ...(request.startAt !== undefined ? { startAt: request.startAt } : {}),
        },
      });
      if (!record) return fail('not_found', 'That schedule does not exist for this owner.');
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.updated',
        outcome: 'accepted',
        detail: `intervalMs=${record.intervalMs}`,
      });
      return ok(toSchedule(record));
    },

    pauseSchedule: (principal, scheduleId) => setScheduleEnabled(principal, scheduleId, false),
    resumeSchedule: (principal, scheduleId) => setScheduleEnabled(principal, scheduleId, true),

    cancelSchedule: async (principal, scheduleId) => {
      const canceled = deps.schedules.remove(principal.ownerId, scheduleId);
      deps.audit.record({
        actor: principal.ownerId,
        action: 'schedule.canceled',
        outcome: canceled ? 'accepted' : 'refused',
      });
      return ok({ scheduleId, outcome: canceled ? 'canceled' : 'not_found' });
    },

    scheduleExecutions: async (principal, scheduleId, limit) => {
      const executions = deps.schedules.executions({
        ownerId: principal.ownerId,
        scheduleId,
        limit,
      });
      if (!executions) return fail('not_found', 'That schedule does not exist for this owner.');
      return ok({ scheduleId, executions: executions.map(toScheduleExecution) });
    },

    removeSchedule: async (principal, scheduleId) => {
      const removed = deps.schedules.remove(principal.ownerId, scheduleId);
      return ok({
        scheduleId,
        outcome: removed ? 'deleted' : 'not_found',
      });
    },

    tickSchedules: async () => {
      if (ticking) return { started: 0, skipped: 0 };
      ticking = true;
      try {
        return await tick();
      } finally {
        ticking = false;
      }
    },

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const live = deps.events.replay(taskId, after);
      const durable = eventLog ? await eventLog.read(taskId, after) : [];
      const durableLast = eventLog ? await eventLog.lastSeq(taskId) : 0;
      // A replay is also when this process learns how far a previous one got, so
      // a resumed run continues the numbering instead of repeating it.
      deps.events.adopt(taskId, durableLast);
      const replay: Replay = {
        events: mergeReplay(durable, live.events),
        truncated: live.truncated,
      };
      const oldest = replay.events[0]?.seq;
      const truncatedEvent: ExecutionEvent | null =
        replay.truncated && oldest !== undefined && oldest > 1
          ? ({
              v: EVENT_SCHEMA_VERSION,
              eventId: `evt_truncated_${taskId}_${after}`,
              taskId,
              seq: oldest - 1,
              at: deps.clock.iso(),
              agent: found.value.agent,
              generation: found.value.generation,
              type: 'stream.truncated',
              payload: { after, oldestSeq: oldest },
            } as ExecutionEvent)
          : null;
      const lastSeq = Math.max(deps.events.lastSeq(taskId), durableLast);
      const terminalInReplay =
        replay.events.some((event) => event.generation === found.value.generation && isTerminalEvent(event.type));
      return ok({
        replay,
        subscribe: (listener) => {
          // Replay delivery can yield to the runner before the route starts tailing.
          const cursor = Math.max(after, lastSeq);
          for (const event of deps.events.replay(taskId, cursor).events) listener(event);
          return deps.events.subscribe(taskId, cursor, listener);
        },
        lastSeq,
        truncatedEvent,
        closedAfterReplay:
          terminalInReplay || (isTerminalState(found.value.state) && (after >= lastSeq || replay.truncated)),
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
      // Aborting is not settling: a run that already started still writes its
      // outcome and releases its lease. The caller closes the connection right
      // after this, so the pool must be empty before that happens.
      await deps.scheduler.idle();
      // Same reason: every published event must reach the durable log while the
      // connection that stores it is still open.
      await deps.events.flush();
    },
  };

  return service;
}
