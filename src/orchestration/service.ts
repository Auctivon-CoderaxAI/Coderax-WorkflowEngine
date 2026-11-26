import type {
  AgentId,
  AgentList,
  ArtifactContent,
  ArtifactList,
  ArtifactRecord,
  BudgetState,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationDeletion,
  ConversationList,
  ConversationListQuery,
  DataMode,
  EngineHandshake,
  MemoryDeletion,
  MemoryEntry,
  MemoryList,
  MemoryPutRequest,
  MetricsReport,
  ModelList,
  NotificationList,
  NotificationListQuery,
  PermissionDecisionRequest,
  PermissionList,
  PermissionScope,
  PermissionListQuery,
  ReceiptList,
  ReceiptListQuery,
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleList,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
  TaskListQuery,
  TaskSummary,
  WorkSubmitRequest,
} from '@coderax/contracts';
import {
  API_PREFIX,
  CHAT_STREAM_SCHEMA_VERSION,
  CONTRACT_VERSION,
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  MIN_SDK_VERSION,
  ROUTES,
  SDK_VERSION,
  isTerminalState,
  modelKey,
} from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { ArtifactRow, ScheduleRecord, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
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
import type { ExecutionSupervisor } from '../execution/supervisor.js';
import type { ExecutionIdentity } from '../execution/identity.js';
import type { ExecutionRepository } from '../persistence/executions.js';
import type { QuarantineStore } from '../persistence/quarantine.js';
import type { CheckpointStore } from '../persistence/checkpoints.js';
import type { IdempotencyStore } from '../persistence/idempotency.js';
import type { RetentionService } from '../persistence/retention.js';
import type { PersistenceHealth } from '../bootstrap/persistence.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { createHash } from 'node:crypto';
import { decodeCursor } from '../persistence/pagination.js';
import type { TaskScheduler } from '../scheduling/scheduler.js';
import type { ScheduleRepository } from '../persistence/schedules.js';
import type { ArtifactRepository, ArtifactStorage } from '../artifacts/store.js';
import type { AuthService, Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { resolveEngineWorkspace, workspaceRoots } from '../execution/workspace.js';
import { buildTranscript } from './transcript.js';

const WORK_SCOPES: readonly PermissionScope[] = [
  'workspace.read',
  'workspace.write',
  'command.execute',
  'network.access',
  'memory.read',
  'conversation.read',
];

const CHAT_SCOPES: readonly PermissionScope[] = [
  'workspace.read',
  'network.access',
  'memory.read',
  'conversation.read',
];

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
  artifacts: ArtifactRepository;
  artifactStorage: ArtifactStorage;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  supervisor: ExecutionSupervisor;
  executions: ExecutionRepository;
  quarantine: QuarantineStore;
  checkpoints: CheckpointStore;
  idempotency: IdempotencyStore;
  retention: RetentionService;
  persistencePing: () => Promise<PersistenceHealth>;
  metrics: MetricsRegistry;
  /** The deployed revision reported by the host; null when it is not recorded. */
  deploymentRevision: string | null;
};

export type EventStream = {
  replay: Replay;
  subscribe: (listener: (event: unknown) => void) => Unsubscribe;
  lastSeq: number;
  /** The generation that owns the task now; older terminal events do not close. */
  generation: number;
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
  listTasks: (
    principal: Principal,
    query: TaskListQuery,
  ) => Promise<ServiceResult<TaskList>>;
  conversations: (
    principal: Principal,
    query: ConversationListQuery,
  ) => Promise<ServiceResult<ConversationList>>;
  conversation: (
    principal: Principal,
    conversationId: string,
  ) => Promise<ServiceResult<Conversation>>;
  deleteConversation: (
    principal: Principal,
    conversationId: string,
  ) => Promise<ServiceResult<ConversationDeletion>>;
  memory: (
    principal: Principal,
    mode: DataMode,
    query?: { limit?: number; cursor?: string },
  ) => Promise<MemoryList>;
  deleteMemory: (
    principal: Principal,
    key: string,
    mode: DataMode,
  ) => Promise<MemoryDeletion>;
  permissions: (
    principal: Principal,
    taskId: string,
    query?: PermissionListQuery,
  ) => Promise<ServiceResult<PermissionList>>;
  decidePermission: (
    principal: Principal,
    taskId: string,
    body: PermissionDecisionRequest,
  ) => Promise<ServiceResult<PermissionList>>;
  notifications: (
    principal: Principal,
    query: NotificationListQuery,
  ) => Promise<ServiceResult<NotificationList>>;
  markNotificationsRead: (
    principal: Principal,
    taskIds: string[],
  ) => Promise<NotificationList>;
  receipts: (
    principal: Principal,
    taskId: string,
    query: ReceiptListQuery,
  ) => Promise<ServiceResult<ReceiptList>>;
  metrics: (principal: Principal) => Promise<MetricsReport>;
  handshake: () => EngineHandshake;
  putMemory: (principal: Principal, request: MemoryPutRequest) => Promise<MemoryEntry>;
  pendingPermissions: (
    principal: Principal,
    query?: PermissionListQuery,
  ) => Promise<PermissionList>;
  listSchedules: (principal: Principal) => Promise<ScheduleList>;
  createSchedule: (
    principal: Principal,
    request: ScheduleCreateRequest,
  ) => Promise<ServiceResult<Schedule>>;
  schedule: (principal: Principal, scheduleId: string) => Promise<ServiceResult<Schedule>>;
  cancelSchedule: (
    principal: Principal,
    scheduleId: string,
  ) => Promise<ServiceResult<ScheduleControlResult>>;
  tickSchedules: () => Promise<{ submitted: number; failed: number }>;
  listArtifacts: (
    principal: Principal,
    taskId: string,
  ) => Promise<ServiceResult<ArtifactList>>;
  uploadArtifact: (
    principal: Principal,
    taskId: string,
    request: { path: string; mediaType: string; contentBase64: string },
  ) => Promise<ServiceResult<ArtifactRecord>>;
  artifact: (principal: Principal, artifactId: string) => Promise<ServiceResult<ArtifactRecord>>;
  artifactContent: (
    principal: Principal,
    artifactId: string,
  ) => Promise<ServiceResult<ArtifactContent>>;
  events: (
    principal: Principal,
    taskId: string,
    after: number,
  ) => Promise<ServiceResult<EventStream>>;
  budget: (principal: Principal) => Promise<BudgetState>;
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

function digestRequest(request: WorkSubmitRequest): string {
  const canonical = JSON.stringify({
    objective: request.objective,
    conversationId: request.conversationId ?? null,
    agent: request.agent ?? null,
    model: request.model ?? null,
    mode: request.mode,
    budget: request.budget ?? null,
    requireApproval: request.requireApproval,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toSummary(task: TaskRecord): TaskSummary {
  return {
    taskId: task.taskId,
    conversationId: task.conversationId,
    objective: task.objective,
    state: task.state,
    agent: task.agent,
    mode: task.mode,
    generation: task.generation,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cancelRequested: task.cancelRequested,
  };
}

function toSchedule(record: {
  scheduleId: string;
  objective: string;
  agent: AgentId;
  mode: DataMode;
  model: TaskRecord['model'];
  requireApproval: boolean;
  state: Schedule['state'];
  runAt: string;
  intervalMs: number | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastTaskId: string | null;
  lastError: string | null;
}): Schedule {
  return {
    scheduleId: record.scheduleId,
    objective: record.objective,
    agent: record.agent,
    mode: record.mode,
    ...(record.model ? { model: record.model } : {}),
    requireApproval: record.requireApproval,
    state: record.state,
    runAt: record.runAt,
    ...(record.intervalMs !== null ? { intervalMs: record.intervalMs } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.nextRunAt ? { nextRunAt: record.nextRunAt } : {}),
    ...(record.lastTaskId ? { lastTaskId: record.lastTaskId } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

function toArtifact(row: {
  artifactId: string;
  taskId: string;
  path: string;
  mediaType: string;
  bytes: number;
  digest: string;
  createdAt: string;
}): ArtifactRecord {
  return {
    artifactId: row.artifactId,
    taskId: row.taskId,
    path: row.path,
    mediaType: row.mediaType,
    bytes: row.bytes,
    digest: row.digest,
    createdAt: row.createdAt,
  };
}

/** Strict base64: a lenient decode would store bytes the client did not send. */
function decodeBase64(value: string): Buffer | null {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, 'base64');
  return decoded.toString('base64') === normalized ? decoded : null;
}

function capability(state: 'available' | 'unsupported' | 'unconfigured', detail: string) {
  return { state, detail };
}

export function createApplicationService(deps: ApplicationServiceDeps): ApplicationService {
  const controllers = new Map<string, AbortController>();
  const executionsByTask = new Map<string, string>();

  function checkpointFor(
    task: TaskRecord,
    kind: 'step' | 'settled',
    completedSteps: string[],
    text: string,
  ) {
    return {
      checkpointId: deps.ids.checkpointId(),
      taskId: task.taskId,
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      generation: task.generation,
      completedSteps: [...completedSteps],
      text,
      kind,
      createdAt: deps.clock.iso(),
    };
  }

  async function audit(input: Parameters<AuditLog['record']>[0]): Promise<void> {
    try {
      await deps.audit.record(input);
    } catch {
      // A settled task must not be stranded by an evidence write failure; the
      // failure is visible to health and must never be turned into a second
      // terminal write. Acceptance still awaits the receipt below.
    }
  }

  /**
   * A conversation a caller names must already exist, belong to the owner, and
   * carry the same data mode. Creating it implicitly would let a guessed id
   * adopt a conversation, and a mode mismatch would cross the private/cloud
   * boundary the engine exists to enforce.
   */
  async function existingConversation(
    principal: Principal,
    conversationId: string,
    mode: DataMode,
  ): Promise<ServiceResult<TaskRecord['conversationId']>> {
    const record = await deps.conversations.get(principal.ownerId, conversationId);
    if (!record) {
      return fail('not_found', 'That conversation does not exist for this owner.');
    }
    if (record.mode !== mode) {
      return fail(
        'forbidden',
        `That conversation belongs to ${record.mode} data and cannot be used from ${mode} data.`,
      );
    }
    return ok(record.conversationId);
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

  function acceptedFor(task: TaskRecord): TaskAccepted {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      generation: task.generation,
      eventsPath: `/v1/work/${task.taskId}/events`,
    };
  }

  /**
   * Fires every due schedule at most once per due occurrence. The idempotency
   * key is derived from the schedule and its due time, so a crash between
   * submitting and recording the submission cannot create a second task.
   */
  async function tickSchedules(): Promise<{ submitted: number; failed: number }> {
    const due = await deps.schedules.due(deps.clock.iso(), deps.config.schedules.tickBatch);
    let submitted = 0;
    let failed = 0;
    for (const record of due) {
      if (!record.nextRunAt) continue;
      const result = await service.submitWork(
        { ownerId: record.ownerId, isOwner: true },
        {
          objective: record.objective,
          agent: record.agent,
          ...(record.model ? { model: record.model } : {}),
          mode: record.mode,
          requireApproval: record.requireApproval,
          ...(record.budget ? { budget: record.budget } : {}),
          idempotencyKey: `schedule:${record.scheduleId}:${record.nextRunAt}`,
        },
      );
      const updated = { ...record, updatedAt: deps.clock.iso() };
      if (result.ok) {
        updated.lastTaskId = result.value.taskId;
        updated.lastError = null;
        if (record.intervalMs !== null) {
          updated.state = 'scheduled';
          updated.nextRunAt = new Date(
            deps.clock.now().getTime() + record.intervalMs,
          ).toISOString();
        } else {
          updated.state = 'submitted';
          updated.nextRunAt = null;
        }
        submitted += 1;
      } else if (result.code === 'busy') {
        // The run is still live in that conversation. Leave the schedule due so
        // the next tick retries it; dropping it would silently break the promise.
        updated.lastError = 'The conversation still has a live run; the schedule will retry.';
      } else {
        updated.state = 'failed';
        updated.nextRunAt = null;
        updated.lastError = result.detail.slice(0, 500);
        failed += 1;
      }
      await deps.schedules.update(updated).catch(() => false);
    }
    return { submitted, failed };
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
   * A reservation is released rather than settled when this attempt writes no
   * terminal state: the request slot stays charged because the run may have
   * reached the provider, and its unspent token allowance returns to the day.
   */
  async function releaseBudget(
    task: TaskRecord,
    options: { dispatched: boolean } = { dispatched: true },
  ): Promise<void> {
    await deps.budget
      .release(`budget_${task.taskId}_${task.generation}`, options)
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
    /** `release` is for a run that ended before anything was dispatched. */
    budget: 'settle' | 'release' = 'settle',
  ): Promise<void> {
    if (outcome.kind === 'interrupted') {
      await releaseBudget(task);
      return;
    }
    // Barrier: everything the run published is stored before the task record
    // says the run is over, so a client cannot read a terminal task whose
    // stream is missing the events that led to it.
    await deps.events.flush(task.taskId).catch(() => undefined);
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
        deps.metrics.recordLeaseFailure('fencingFailed');
        await releaseLease(task, token);
      }
      // This attempt ended without a terminal write, so nothing will settle its
      // reservation; leaving it would hold tokens for the rest of the day.
      await releaseBudget(task);
      return;
    }

    const settled = applied.task;
    try {
      if (checkpoint) {
        await deps.checkpoints
          .append(checkpointFor(settled, 'settled', checkpoint.completedSteps, checkpoint.text))
          .catch(() => undefined);
      }
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
        // Second fence. The terminal write proves this generation owned the task
        // at that instant; a resume can reissue a generation immediately after,
        // so the transcript append re-checks the token instead of trusting the
        // earlier read. A superseded run adds nothing to a newer run's history.
        const current = await deps.tasks.get(task.taskId);
        if (!current || current.runToken !== token) {
          return;
        }
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
      await audit({
        actor: task.ownerId,
        action: `work.${outcome.kind}`,
        taskId: task.taskId,
        conversationId: task.conversationId,
        outcome: outcome.kind,
        mode: task.mode,
        ...(outcome.kind === 'failed' ? { detail: outcome.code } : {}),
      });
      // The terminal event must be durable before the lease can be reissued.
      await deps.events.flush(settled.taskId).catch(() => undefined);
      if (budget === 'release') {
        // Nothing reached the provider, so neither the request slot nor the
        // token allowance was spent.
        await releaseBudget(settled, { dispatched: false });
      } else {
        // Settle is idempotent and owner-independent: the reservation id derives
        // from task and generation, so a replay cannot charge twice.
        await deps.budget
          .settle(`budget_${settled.taskId}_${settled.generation}`, settled.usage ?? {})
          .catch(() => false);
      }
    } finally {
      await releaseLease(task, token);
    }
  }

  async function execute(taskId: string, token: string): Promise<void> {
    const task = await deps.tasks.get(taskId);
    if (!task || task.runToken !== token) return;

    const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
    if (!lease || !lease.live) {
      await settle(
        task,
        token,
        {
          kind: 'failed',
          code: 'server_unavailable',
          detail: 'The run lost its lease before it started.',
          retryable: true,
        },
        undefined,
        'release',
      );
      return;
    }
    if (lease.cancelRequested) {
      await settle(task, token, { kind: 'cancelled' }, undefined, 'release');
      return;
    }

    const adapter = deps.agents.resolve(task.agent);
    if (!adapter.ok) {
      await settle(
        task,
        token,
        {
          kind: 'failed',
          code: 'not_configured',
          detail: adapter.detail,
          retryable: false,
        },
        undefined,
        'release',
      );
      return;
    }

    const model = task.model
      ? deps.models.resolve(task.model, task.mode)
      : deps.models.resolve(null, task.mode);
    if (!model.ok) {
      await settle(
        task,
        token,
        {
          kind: 'failed',
          code: model.code === 'paid_model_refused' ? 'paid_model_refused' : 'not_configured',
          detail: model.detail,
          retryable: false,
        },
        undefined,
        'release',
      );
      return;
    }

    const workspace = await resolveEngineWorkspace({
      mode: task.mode,
      roots: workspaceRoots(deps.config.workspaces),
    });
    if (!workspace.ok) {
      await settle(
        task,
        token,
        {
          kind: 'failed',
          code: 'workspace_denied',
          detail: workspace.detail,
          retryable: false,
        },
        undefined,
        'release',
      );
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
    // Continue the sequence after anything a previous process already stored.
    await deps.events.hydrate(taskId).catch(() => 0);
    publish(started.task, 'task.started');

    const executionId = deps.ids.executionId();
    executionsByTask.set(taskId, executionId);

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
      if (executionsByTask.get(taskId) !== executionId) return;
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
        void deps.checkpoints
          .append(checkpointFor(started.task, 'step', completed, visible))
          .catch(() => undefined);
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
    const identity: ExecutionIdentity = {
      executionId,
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
    const supervised = await deps.supervisor
      .run({
        identity,
        adapter: adapter.value as AgentAdapter,
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
            },
            report: execution.report,
            generation: started.task.generation,
            workspaceRoot: execution.workspaceRoot,
          });
          return {
            outcome: result.outcome,
            ownershipLost: result.ownershipLost,
            abandoned:
              result.outcome.kind === 'cancelled' && result.outcome.abandoned === true,
          };
        },
      })
      .catch(() => null);
    if (executionsByTask.get(taskId) === executionId) executionsByTask.delete(taskId);

    if (!supervised) {
      await settle(
        started.task,
        token,
        {
          kind: 'failed',
          code: 'server_unavailable',
          detail: 'The execution supervisor could not admit or record this run.',
          retryable: true,
        },
        undefined,
        'release',
      );
      return;
    }
    if (!supervised.admitted) {
      await settle(
        started.task,
        token,
        {
          kind: 'failed',
          code: supervised.code === 'workspace_denied' ? 'workspace_denied' : 'server_unavailable',
          detail: supervised.detail,
          retryable: supervised.code !== 'workspace_denied',
        },
        undefined,
        'release',
      );
      return;
    }
    if (supervised.ownershipLost) {
      // Deliberately no terminal write and no notification: this run no longer
      // owns the task, and the new owner is the only writer of its state.
      await releaseBudget(started.task);
      return;
    }
    const safeText = redactContent(text);
    emitText(safeText);
    const outcome = supervised.outcome.kind === 'completed'
      ? { ...supervised.outcome, summary: redactContent(supervised.outcome.summary) }
      : supervised.outcome;
    await settle(started.task, token, outcome, { completedSteps: completed, text: safeText });
  }

  const TERMINAL_EVENT = new Set([
    'task.completed',
    'task.failed',
    'task.cancelled',
    'task.interrupted',
  ]);

  /**
   * Repairs the one contradiction a crash can leave behind: a task record that
   * says it finished, and a stream that never received the terminal event. The
   * client reads the stream, so the stream is completed here from the
   * authoritative task record — never the other way around.
   */
  async function ensureTerminalEvent(task: TaskRecord): Promise<void> {
    if (!isTerminalState(task.state)) return;
    // The durable watermark, not this process's window, decides whether a
    // terminal event already exists. After a restart the in-memory cursor is
    // zero even though the stream is complete.
    const last = await deps.events.hydrate(task.taskId).catch(() => deps.events.lastSeq(task.taskId));
    const tail = await deps.events.read(task.taskId, Math.max(0, last - 1));
    if (tail.events.some((event) => TERMINAL_EVENT.has(event.type))) return;
    if (task.state === 'completed') {
      publish(task, 'task.completed', {
        ...(task.result?.summary ? { summary: task.result.summary } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.usage ? { usage: task.usage } : {}),
      });
    } else if (task.state === 'cancelled') {
      publish(task, 'task.cancelled', {});
    } else if (task.state === 'failed') {
      publish(task, 'task.failed', {
        code: task.failure?.code ?? 'provider_error',
        ...(task.failure?.detail ? { detail: task.failure.detail } : {}),
        retryable: task.failure?.retryable ?? false,
      });
    } else {
      publish(task, 'task.interrupted', {
        detail: task.failure?.detail ?? 'The run stopped before it could report a terminal event.',
      });
    }
    await deps.events.flush(task.taskId).catch(() => undefined);
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
        await releaseBudget(applied.task);
        await deps.events.hydrate(applied.task.taskId).catch(() => 0);
        publish(applied.task, 'task.interrupted', {
          detail: 'Execution ownership was lost; the task is safe to resume.',
        });
        await deps.events.flush(applied.task.taskId).catch(() => undefined);
        await notifyTerminal(applied.task, 'interrupted');
        await audit({
          actor: task.ownerId,
          action: 'work.interrupted',
          taskId: task.taskId,
          conversationId: task.conversationId,
          outcome: 'failed',
          mode: task.mode,
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

      const idempotencyKey = request.idempotencyKey;
      const requestHash = digestRequest(request);
      const reservedAt = deps.clock.now();
      const idempotencyExpiry = new Date(
        reservedAt.getTime() + deps.config.retention.idempotencyMs,
      ).toISOString();

      const releaseReservation = async (): Promise<void> => {
        if (!idempotencyKey) return;
        await deps.idempotency
          .release({ ownerId: principal.ownerId, key: idempotencyKey })
          .catch(() => undefined);
      };

      if (idempotencyKey) {
        const reservation = await deps.idempotency.reserve({
          ownerId: principal.ownerId,
          key: idempotencyKey,
          requestHash,
          now: reservedAt.toISOString(),
          expiresAt: idempotencyExpiry,
        });
        if (reservation.kind === 'replay') return ok(reservation.response);
        if (reservation.kind === 'conflict') {
          return fail(
            'conflict',
            'That idempotency key was already used for a different Work submission.',
          );
        }
        if (reservation.kind === 'pending') {
          return fail(
            'conflict',
            'A submission with that idempotency key is still in progress; retry it.',
            true,
          );
        }
      }

      if (request.conversationId) {
        const existing = await existingConversation(
          principal,
          request.conversationId,
          request.mode,
        );
        if (!existing.ok) {
          await releaseReservation();
          return existing;
        }
      }

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();

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
        await releaseReservation();
        return fail('busy', 'This conversation already has a live Work run.');
      }

      // Re-check after claiming: a concurrent submission may have won the same
      // idempotency key on another conversation. It is answered before the
      // budget is charged or a transcript is written.
      if (request.idempotencyKey) {
        const raced = await deps.tasks.findByIdempotencyKey(
          principal.ownerId,
          request.idempotencyKey,
        );
        if (raced) {
          await deps.lease.release({ key, token }).catch(() => false);
          return ok(acceptedFor(raced));
        }
      }

      // Deterministic per task generation: a retried admission cannot reserve a
      // second slot, and every replica settles the same id.
      const budgetReservationId = `budget_${task.taskId}_${task.generation}`;
      const reservation = await deps.budget.reserve({
        ownerId: principal.ownerId,
        at: deps.clock.now(),
        inputTokens:
          request.budget?.maxInputTokens ?? deps.config.models.reservationInputTokens,
        outputTokens:
          request.budget?.maxOutputTokens ?? deps.config.models.reservationOutputTokens,
        reservationId: budgetReservationId,
      });
      if (!reservation.allowed) {
        await deps.lease.release({ key, token }).catch(() => false);
        await releaseReservation();
        return fail('budget_exhausted', reservation.detail);
      }

      const created = await deps.tasks.create(
        {
          ...task,
          runToken: token,
          leaseExpiresAt: new Date(
            claimedAt.getTime() + deps.config.execution.leaseTtlMs,
          ).toISOString(),
        },
        request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : undefined,
      );
      if (!created.ok) {
        await deps.lease.release({ key, token }).catch(() => false);
        await releaseReservation();
        await deps.budget.release(budgetReservationId);
        if (created.reason === 'idempotent') {
          return ok(acceptedFor(created.task));
        }
        return fail(
          'busy',
          created.reason === 'conversation_busy'
            ? 'This conversation already has an active Work task.'
            : 'That task identity is already in use.',
        );
      }

      // The task exists before the transcript is written, so a concurrent replay
      // that loses the idempotency race cannot leave a second user message. If
      // the transcript write fails, the accepted task is failed rather than
      // stranded as queued with no run scheduled.
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
        await deps.conversations.appendMessage({
          messageId: deps.ids.messageId(),
          conversationId,
          role: 'user',
          text: request.objective,
          createdAt: now,
        });
      } catch {
        await deps.tasks.updateFenced({
          taskId: task.taskId,
          token,
          patch: {
            state: 'failed',
            updatedAt: deps.clock.iso(),
            failure: {
              code: 'server_unavailable',
              detail: 'The task transcript could not be recorded.',
              retryable: true,
            },
          },
        });
        await deps.lease.release({ key, token }).catch(() => false);
        await deps.budget.release(budgetReservationId);
        return fail('internal_error', 'The task transcript could not be recorded.');
      }
      await deps.events.hydrate(created.task.taskId).catch(() => 0);

      publish(created.task, 'task.queued');
      await audit({
        actor: principal.ownerId,
        action: 'work.accepted',
        taskId: task.taskId,
        conversationId,
        outcome: 'accepted',
        mode: task.mode,
        detail: `agent=${agentId} model=${modelKey(model.value.ref)}`,
      });

      const accepted: TaskAccepted = {
        taskId: task.taskId,
        conversationId,
        state: 'queued',
        generation: 1,
        eventsPath: `/v1/work/${task.taskId}/events`,
      };
      if (idempotencyKey) {
        await deps.idempotency
          .complete({
            ownerId: principal.ownerId,
            key: idempotencyKey,
            response: accepted,
            now: deps.clock.iso(),
            expiresAt: new Date(
              deps.clock.now().getTime() + deps.config.retention.idempotencyMs,
            ).toISOString(),
          })
          .catch(() => undefined);
      }

      deps.scheduler.enqueue(() => execute(task.taskId, token));

      return ok(accepted);
    },

    task: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const reconciled = await reconcile(found.value);
      // A client that observes a terminal state must be able to replay the
      // terminal event immediately: repair the stream before answering.
      await ensureTerminalEvent(reconciled);
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
      await releaseBudget(applied.task);
      await deps.events.hydrate(applied.task.taskId).catch(() => 0);
      publish(applied.task, 'task.interrupted', {
        detail: 'The run had already stopped; it was retired as interrupted.',
      });
      await deps.events.flush(applied.task.taskId).catch(() => undefined);
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

      // A resume is a new admitted attempt, so it takes a shared request slot
      // before the generation is reissued. The id is deterministic, so a replay
      // of this control request cannot reserve twice.
      const budgetReservationId = `budget_${taskId}_${task.generation + 1}`;
      const budgetReservation = await deps.budget.reserve({
        ownerId: task.ownerId,
        at: now,
        inputTokens: task.budget?.maxInputTokens ?? deps.config.models.reservationInputTokens,
        outputTokens: task.budget?.maxOutputTokens ?? deps.config.models.reservationOutputTokens,
        reservationId: budgetReservationId,
      });
      if (!budgetReservation.allowed) {
        await deps.lease.release({ key: workRunKey(scopeOf(task)), token }).catch(() => false);
        return fail('budget_exhausted', budgetReservation.detail);
      }

      const applied = await deps.tasks.reissue({
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) {
        await deps.lease.release({ key: workRunKey(scopeOf(task)), token }).catch(() => false);
        await deps.budget.release(budgetReservationId);
        return fail('conflict', 'That task cannot be resumed.');
      }
      await deps.events.hydrate(taskId).catch(() => 0);
      publish(applied.task, 'task.queued');
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

      const budgetReservationId = `budget_${taskId}_${task.generation + 1}`;
      const budgetReservation = await deps.budget.reserve({
        ownerId: task.ownerId,
        at: now,
        inputTokens: task.budget?.maxInputTokens ?? deps.config.models.reservationInputTokens,
        outputTokens: task.budget?.maxOutputTokens ?? deps.config.models.reservationOutputTokens,
        reservationId: budgetReservationId,
      });
      if (!budgetReservation.allowed) {
        await deps.lease.release({ key: workRunKey(scopeOf(task)), token }).catch(() => false);
        return fail('budget_exhausted', budgetReservation.detail);
      }

      const applied = await deps.tasks.reissue({
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) {
        await deps.lease.release({ key: workRunKey(scopeOf(task)), token }).catch(() => false);
        await deps.budget.release(budgetReservationId);
        return fail('conflict', 'That task cannot be retried.');
      }
      await deps.events.hydrate(taskId).catch(() => 0);
      publish(applied.task, 'task.queued');
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

      const executionId = deps.ids.executionId();
      const reservationId = `budget_${executionId}`;
      const reservation = await deps.budget.reserve({
        ownerId: principal.ownerId,
        at: deps.clock.now(),
        // A chat turn has no caller-declared ceiling, so it holds the configured
        // per-request allowance until it settles. A zero-token reservation would
        // let every replica spend the same remaining allowance at once.
        inputTokens: deps.config.models.reservationInputTokens,
        outputTokens: deps.config.models.reservationOutputTokens,
        reservationId,
      });
      if (!reservation.allowed) {
        return fail('budget_exhausted', reservation.detail);
      }
      const workspace = await resolveEngineWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
      });
      if (!workspace.ok) {
        await deps.budget.release(reservationId);
        return workspace;
      }

      if (request.conversationId) {
        const existing = await existingConversation(
          principal,
          request.conversationId,
          request.mode,
        );
        if (!existing.ok) return existing;
      }

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
      const identity: ExecutionIdentity = {
        executionId,
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
      const supervised = await deps.supervisor
        .run({
          identity,
          adapter: adapter.value,
          workspaceRoot: workspace.value.root,
          scopes: CHAT_SCOPES,
          launch: async (execution) => {
            const result = await adapter.value.run(
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
              },
              execution.report,
            );
            return {
              outcome: result.ok
                ? {
                    kind: 'completed' as const,
                    summary: result.summary,
                    ...(result.usage ? { usage: result.usage } : {}),
                  }
                : result.code === 'cancelled'
                  ? { kind: 'cancelled' as const }
                  : {
                      kind: 'failed' as const,
                      code: result.code,
                      detail: result.detail,
                      retryable: result.retryable,
                    },
            };
          },
        })
        .catch(() => null);
      if (!supervised || !supervised.admitted) {
        await deps.budget.release(reservationId, { dispatched: false });
        return fail(
          'engine_unavailable',
          supervised ? supervised.detail : 'The execution supervisor could not admit this chat turn.',
          true,
        );
      }
      const outcome = supervised.outcome;
      if (outcome.kind !== 'completed') {
        await deps.budget.release(reservationId, { dispatched: true });
        return fail(
          outcome.kind === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          outcome.kind === 'cancelled' ? 'The chat turn was cancelled.' : outcome.detail,
          outcome.kind === 'failed' ? outcome.retryable : true,
        );
      }
      await deps.budget.settle(reservationId, outcome.usage ?? {});
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

    listTasks: async (principal, query) => {
      if (query.cursor && !decodeCursor(query.cursor)) {
        return fail('validation_failed', 'The pagination cursor is invalid.');
      }
      const page = await deps.tasks.listPage({
        ownerId: principal.ownerId,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        ...(query.agent ? { agent: query.agent } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
      });
      return ok({
        tasks: page.tasks.map(toSummary),
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    },

    conversations: async (principal, query) => {
      if (query.cursor && !decodeCursor(query.cursor)) {
        return fail('validation_failed', 'The pagination cursor is invalid.');
      }
      const page = await deps.conversations.listPage({
        ownerId: principal.ownerId,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
        ...(query.agent ? { agent: query.agent } : {}),
        ...(query.isWork === undefined ? {} : { isWork: query.isWork === 'true' }),
      });
      return ok({
        conversations: page.conversations,
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    },

    conversation: async (principal, conversationId) => {
      const record = await deps.conversations.get(principal.ownerId, conversationId);
      if (!record) return fail('not_found', 'That conversation does not exist for this owner.');
      return ok(await deps.conversations.toContract(record));
    },

    deleteConversation: async (principal, conversationId) => {
      const record = await deps.conversations.get(principal.ownerId, conversationId);
      if (!record) return fail('not_found', 'That conversation does not exist for this owner.');
      const tasks = await deps.tasks.listByConversation(conversationId);
      if (tasks.some((task) => task.ownerId === principal.ownerId && !isTerminalState(task.state))) {
        return fail(
          'conflict',
          'That conversation still has a live Work task; cancel it before deleting the conversation.',
        );
      }
      const ownedTaskIds = tasks
        .filter((task) => task.ownerId === principal.ownerId)
        .map((task) => task.taskId);
      const removed = await deps.conversations.delete(principal.ownerId, conversationId);
      if (!removed.deleted) {
        return fail('not_found', 'That conversation does not exist for this owner.');
      }
      const tasksDeleted = await deps.tasks.deleteByConversation(
        principal.ownerId,
        conversationId,
      );
      await deps.notifications
        .deleteByConversation(principal.ownerId, conversationId)
        .catch(() => 0);
      await deps.permissions.deleteByTaskIds(ownedTaskIds).catch(() => 0);
      await deps.checkpoints.deleteByTaskIds(ownedTaskIds).catch(() => 0);
      await deps.events.deleteTasks(ownedTaskIds).catch(() => 0);
      await deps.audit.deleteByTaskIds(ownedTaskIds).catch(() => 0);
      await deps.idempotency
        .deleteByConversation(principal.ownerId, conversationId)
        .catch(() => 0);
      await audit({
        actor: principal.ownerId,
        action: 'conversation.deleted',
        conversationId,
        outcome: 'accepted',
        mode: record.mode,
        detail: `messages=${removed.messages} tasks=${tasksDeleted}`,
      });
      return ok({
        conversationId,
        deleted: true,
        messagesDeleted: removed.messages,
        tasksDeleted,
      });
    },

    memory: (principal, mode, query = {}) =>
      deps.memory.list({
        ownerId: principal.ownerId,
        mode,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),

    deleteMemory: async (principal, key, mode) => {
      const trimmed = key.trim();
      const deleted = await deps.memory.delete({
        ownerId: principal.ownerId,
        mode,
        key: trimmed,
      });
      return { key: trimmed, mode, deleted };
    },

    permissions: async (principal, taskId, query) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      if (query?.cursor && !decodeCursor(query.cursor)) {
        return fail('validation_failed', 'The pagination cursor is invalid.');
      }
      return ok(await deps.permissions.list(principal.ownerId, taskId, query));
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

    notifications: async (principal, query) => {
      if (query.cursor && !decodeCursor(query.cursor)) {
        return fail('validation_failed', 'The pagination cursor is invalid.');
      }
      return ok(
        await deps.notifications.list({
          ownerId: principal.ownerId,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly === 'true' }),
        }),
      );
    },

    markNotificationsRead: async (principal, taskIds) => {
      await deps.notifications.markRead(principal.ownerId, taskIds);
      return deps.notifications.list({ ownerId: principal.ownerId });
    },

    receipts: async (principal, taskId, query) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      if (query.cursor && !decodeCursor(query.cursor)) {
        return fail('validation_failed', 'The pagination cursor is invalid.');
      }
      return ok(
        await deps.audit.list({
          actor: principal.ownerId,
          taskId,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }),
      );
    },

    metrics: async (principal) => {
      const [byState, auditPage, persistence] = await Promise.all([
        deps.tasks.countByState(),
        deps.audit.list({ actor: principal.ownerId, limit: 1 }),
        deps.persistencePing().catch(() => ({
          driver: deps.config.persistence.driver,
          durable: deps.config.persistence.driver === 'mongo',
          ok: false,
          latencyMs: 0,
          detail: 'The persistence ping did not complete.',
        })),
      ]);
      const counters = deps.metrics.counters();
      const total = Object.values(byState).reduce((sum, count) => sum + count, 0);
      return {
        startedAt: deps.metrics.startedAt,
        uptimeMs: deps.metrics.uptimeMs(),
        requests: counters.requests,
        queue: {
          active: deps.scheduler.active(),
          pending: deps.scheduler.pending(),
          maxConcurrent: deps.config.execution.maxConcurrentTasks,
        },
        tasks: { total, byState },
        events: { dropped: deps.events.dropped() },
        leases: counters.leases,
        audit: { receipts: auditPage.total },
        persistence: {
          driver: persistence.driver === 'mongo' ? 'mongo' : 'in_memory',
          durable: persistence.durable,
          ok: persistence.ok,
          latencyMs: persistence.latencyMs,
          checkedAt: deps.clock.iso(),
          detail: persistence.detail,
        },
      };
    },

    handshake: () => ({
      engineName: 'coderax-workflow-engine',
      engineVersion: ENGINE_VERSION,
      contractVersion: CONTRACT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      chatStreamSchemaVersion: CHAT_STREAM_SCHEMA_VERSION,
      minSdkVersion: MIN_SDK_VERSION,
      sdkVersion: SDK_VERSION,
      apiPrefix: API_PREFIX,
      ...(deps.deploymentRevision ? { deploymentRevision: deps.deploymentRevision } : {}),
      capabilities: {
        chat: capability('available', 'One Chat turn with the explicitly selected agent.'),
        chatStreaming: capability('available', 'Typed SSE frames; JSON remains available.'),
        work: capability('available', 'Durable Work tasks with fenced settlement.'),
        durableEvents: capability(
          'available',
          `Execution events are persisted and replayable in the ${deps.config.persistence.driver} store.`,
        ),
        eventReplay: capability('available', 'Replay and tail from a per-task sequence cursor.'),
        scheduling: capability(
          'available',
          `Durable schedules are stored in the ${deps.config.persistence.driver} store.`,
        ),
        artifacts: capability('available', 'Owner-scoped bytes with sha256 verification.'),
        permissions: capability(
          'available',
          `Scoped approvals are stored in the ${deps.config.persistence.driver} store.`,
        ),
        memory: capability('available', 'Exact owner- and mode-partitioned key/value memory.'),
        rag: capability('unsupported', 'No embedding provider or vector retrieval is configured.'),
        multimodal: capability('unsupported', 'No image or audio input is implemented.'),
        multiAgent: capability(
          'unsupported',
          'One explicitly selected agent per task; there is no multi-agent collaboration.',
        ),
        idempotency: capability('available', 'Owner-scoped submission keys replay one task.'),
        reasoningPlanner: capability(
          'available',
          'Deterministic native step planner; no model-driven planner is wired here yet.',
        ),
        modelRouter: capability(
          'available',
          `Configured zero-cost route with allowPaid=false; ${deps.config.models.route.length} candidate(s).`,
        ),
        executionSupervisor: capability(
          'available',
          'Attempts are admitted through one supervisor with durable execution identity, scoped capability revocation and termination evidence; unverified termination quarantines the workspace in the shared store.',
        ),
      },
      operations: ROUTES.map((route) => ({
        operationId: route.operationId,
        method: route.method,
        path: route.path,
        tags: [...route.tags],
        auth: route.auth,
        stream: route.stream === true,
      })),
    }),

    putMemory: async (principal, request) => {
      await deps.memory.put({
        ownerId: principal.ownerId,
        tenantId: null,
        mode: request.mode,
        key: request.key,
        value: request.value,
      });
      return {
        key: request.key,
        value: request.value,
        mode: request.mode,
        updatedAt: deps.clock.iso(),
      };
    },

    pendingPermissions: (principal, query = {}) =>
      deps.permissions.listPending(principal.ownerId, query),

    listSchedules: async (principal) => ({
      schedules: (await deps.schedules.list(principal.ownerId)).map(toSchedule),
    }),

    createSchedule: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;
      const model = deps.models.resolve(request.model ?? null, request.mode);
      if (!model.ok) return model;
      const now = deps.clock.iso();
      // Normalise an offset date so due-time comparisons are against the same
      // UTC representation the clock and the durable store use.
      const runAt = new Date(request.runAt).toISOString();
      const record: ScheduleRecord = {
        scheduleId: deps.ids.scheduleId(),
        ownerId: principal.ownerId,
        objective: request.objective,
        agent: agentId,
        mode: request.mode,
        model: model.value.ref,
        requireApproval: request.requireApproval,
        budget: request.budget ?? null,
        state: 'scheduled',
        runAt,
        intervalMs: request.intervalMs ?? null,
        createdAt: now,
        updatedAt: now,
        nextRunAt: runAt,
        lastTaskId: null,
        lastError: null,
      };
      const created = await deps.schedules.create(record);
      if (!created.ok) {
        return fail('conflict', 'The maximum number of active schedules is reached.');
      }
      return ok(toSchedule(record));
    },

    schedule: async (principal, scheduleId) => {
      const record = await deps.schedules.get(principal.ownerId, scheduleId);
      return record
        ? ok(toSchedule(record))
        : fail('not_found', 'That schedule does not exist for this owner.');
    },

    cancelSchedule: async (principal, scheduleId) => {
      const record = await deps.schedules.get(principal.ownerId, scheduleId);
      if (!record) return fail('not_found', 'That schedule does not exist for this owner.');
      if (record.state !== 'scheduled') {
        return ok({ scheduleId, state: record.state, outcome: 'already_terminal' });
      }
      const updated: ScheduleRecord = {
        ...record,
        state: 'cancelled',
        nextRunAt: null,
        updatedAt: deps.clock.iso(),
      };
      const applied = await deps.schedules.update(updated);
      if (!applied) {
        return fail('conflict', 'That schedule changed before it could be cancelled.');
      }
      return ok({ scheduleId, state: 'cancelled', outcome: 'accepted' });
    },

    tickSchedules,

    listArtifacts: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return ok({
        artifacts: (await deps.artifacts.list(principal.ownerId, taskId)).map(toArtifact),
      });
    },

    uploadArtifact: async (principal, taskId, request) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const content = decodeBase64(request.contentBase64);
      if (!content) {
        return fail('validation_failed', 'The artifact content is not valid base64.');
      }
      if (content.length > deps.config.artifacts.maxBytes) {
        return fail(
          'validation_failed',
          `An artifact may contain at most ${deps.config.artifacts.maxBytes} bytes.`,
        );
      }
      const artifactId = deps.ids.artifactId();
      let stored: { bytes: number; digest: string };
      try {
        stored = await deps.artifactStorage.write({
          mode: found.value.mode,
          artifactId,
          content,
        });
      } catch {
        return fail('internal_error', 'The artifact bytes could not be stored.');
      }
      const row: ArtifactRow = {
        artifactId,
        ownerId: principal.ownerId,
        taskId,
        path: request.path,
        mediaType: request.mediaType,
        bytes: stored.bytes,
        digest: stored.digest,
        mode: found.value.mode,
        createdAt: deps.clock.iso(),
      };
      try {
        await deps.artifacts.insert(row);
      } catch {
        await deps.artifactStorage
          .remove({ mode: found.value.mode, artifactId })
          .catch(() => undefined);
        return fail('internal_error', 'The artifact could not be recorded.');
      }
      return ok(toArtifact(row));
    },

    artifact: async (principal, artifactId) => {
      const row = await deps.artifacts.get(principal.ownerId, artifactId);
      return row
        ? ok(toArtifact(row))
        : fail('not_found', 'That artifact does not exist for this owner.');
    },

    artifactContent: async (principal, artifactId) => {
      const row = await deps.artifacts.get(principal.ownerId, artifactId);
      if (!row) return fail('not_found', 'That artifact does not exist for this owner.');
      try {
        const content = await deps.artifactStorage.read({
          mode: row.mode,
          artifactId: row.artifactId,
          digest: row.digest,
        });
        return ok({
          artifactId: row.artifactId,
          mediaType: row.mediaType,
          bytes: row.bytes,
          digest: row.digest,
          contentBase64: content.toString('base64'),
        });
      } catch {
        return fail('not_found', 'The artifact bytes are unavailable.');
      }
    },

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      await ensureTerminalEvent(found.value);
      // The durable read is what makes a reconnect after a restart replay the
      // events the previous process wrote, not just this process's window.
      return ok({
        replay: await deps.events.read(taskId, after),
        subscribe: (listener) => deps.events.subscribe(taskId, after, listener),
        lastSeq: deps.events.lastSeq(taskId),
        generation: found.value.generation,
      });
    },

    budget: async (principal) => {
      const now = deps.clock.now();
      const used = await deps.budget.snapshot(principal.ownerId, now);
      const budget = {
        maxRequests: deps.config.models.dailyRequestBudget,
        maxInputTokens: deps.config.models.dailyTokenBudget,
        maxOutputTokens: deps.config.models.dailyTokenBudget,
      };
      const resets = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      );
      return {
        budget,
        used: {
          requests: used.requests,
          usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens },
        },
        remaining: {
          requests: Math.max(0, budget.maxRequests - used.requests),
          inputTokens: Math.max(0, budget.maxInputTokens - used.inputTokens),
          outputTokens: Math.max(0, budget.maxOutputTokens - used.outputTokens),
        },
        exhausted: used.requests >= budget.maxRequests,
        period: 'day',
        resetsAt: resets.toISOString(),
      };
    },

    recoverInterrupted: async () => {
      // Retire attempts whose owning process stopped heartbeating before the
      // task sweep, so an old execution cannot look live and its workspace is
      // durably quarantined on every replica.
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
      // (not `cancelled`), and give them a bounded window to unwind. Unsettled
      // tasks are reconciled on the next startup.
      await deps.supervisor.shutdown();
      deps.scheduler.stop();
      controllers.clear();
      executionsByTask.clear();
      // Flush before the process releases the database, so a shutdown does not
      // lose the tail of a run that already reported it.
      await deps.events.close().catch(() => undefined);
    },
  };

  return service;
}
