import type {
  AgentId,
  AgentList,
  BudgetState,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  CreativeArtifact,
  CreativeValidation,
  CreativeValidationRequest,
  DataMode,
  MediaCapabilities,
  MediaDownload,
  MediaUploadRequest,
  MediaUploadResult,
  EngineHandshake,
  MemoryEntry,
  MemoryList,
  MemoryPutRequest,
  ModelList,
  NotificationList,
  PermissionDecisionRequest,
  PermissionList,
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleList,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
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
import type { ScheduleRecord, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
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
import type { PermissionStore } from '../permissions/store.js';
import type { MediaService } from '../media/service.js';
import type { CreativeService } from '../creative/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { AuditLog } from '../observability/audit.js';
import type { HealthService } from '../observability/health.js';
import type { EventBus, Replay, Unsubscribe } from '../events/bus.js';
import type { TaskScheduler } from '../scheduling/scheduler.js';
import type { ScheduleRepository } from '../persistence/schedules.js';
import type { ArtifactService } from '../artifacts/service.js';
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
  media: MediaService;
  creative: CreativeService;
  notifications: NotificationStore;
  schedules: ScheduleRepository;
  artifactService: ArtifactService;
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
  generation: number;
};

export type ApplicationService = {
  health: () => ReturnType<HealthService['report']>;
  readiness: () => ReturnType<HealthService['readiness']>;
  agents: () => AgentList;
  models: () => ModelList;
  artifacts: ArtifactService;
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
  markNotificationsRead: (principal: Principal, taskIds: string[]) => Promise<NotificationList>;
  handshake: () => EngineHandshake;
  listTasks: (principal: Principal, query: { state?: string; limit?: number }) => Promise<TaskList>;
  putMemory: (principal: Principal, request: MemoryPutRequest) => Promise<MemoryEntry>;
  pendingPermissions: (principal: Principal) => Promise<PermissionList>;
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
  mediaCapabilities: () => MediaCapabilities;
  uploadMedia: (
    principal: Principal,
    request: MediaUploadRequest,
  ) => Promise<ServiceResult<MediaUploadResult>>;
  mediaItem: (principal: Principal, mediaId: string) => Promise<ServiceResult<MediaDownload>>;
  validateCreative: (
    principal: Principal,
    request: CreativeValidationRequest,
  ) => Promise<CreativeValidation>;
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

/** Strict base64: a lenient decode would store bytes the client did not send. */
function capability(state: 'available' | 'unsupported' | 'unconfigured', detail: string) {
  return { state, detail };
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
              ...(task.result.creative ? { creative: task.result.creative } : {}),
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

  /**
   * Media is resolved at the point of use, under the request's data mode and the
   * owner's identity. External agents are denied outright rather than handed
   * owner content: their isolation contract is `conversations: none` and
   * `memory: none`, so media would widen it silently.
   */
  async function resolveAttachments(input: {
    principal: Principal;
    mode: DataMode;
    agent: AgentId;
    mediaIds: readonly string[] | undefined;
  }): Promise<ServiceResult<{ mediaIds: string[]; images: string[] }>> {
    const ids = input.mediaIds ?? [];
    if (ids.length === 0) return ok({ mediaIds: [], images: [] });
    if (input.agent !== 'coderax') {
      return fail(
        'forbidden',
        'External agents never receive owner media; attachments are available only to Coderax Native.',
      );
    }
    const resolved = await deps.media.resolve({
      ownerId: input.principal.ownerId,
      mode: input.mode,
      mediaIds: ids,
    });
    if (!resolved.ok) return resolved;
    return ok({
      mediaIds: [...ids],
      images: resolved.value.map((entry) => entry.dataUrl),
    });
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
    creative?: CreativeArtifact[],
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
              ...(creative && creative.length > 0 ? { creative } : {}),
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

    const attachments = await deps.media.resolve({
      ownerId: task.ownerId,
      mode: task.mode,
      mediaIds: task.attachments ?? [],
    });
    if (!attachments.ok) {
      await settle(task, token, {
        kind: 'failed',
        code: 'media_unsupported',
        detail: attachments.detail,
        retryable: false,
      });
      return;
    }
    const images = attachments.value.map((entry) => entry.dataUrl);

    const routing = inferRoutingMode({
      objective: task.objective,
      ...(images.length > 0 ? { imageCount: images.length } : {}),
    });
    const pinned = task.modelPinned === true && task.model !== null;
    const model = deps.models.resolve(pinned ? task.model : null, task.mode, {
      // A provider grant for work is not a grant to process the owner's images.
      operation: images.length > 0 ? 'multimodal' : 'work',
      routing,
      estimatedInputTokens: estimateTokens([task.objective]) + images.length * 1_024,
      requireVision: images.length > 0,
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

    const history = await historyFor(task.conversationId, task.objective);
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
    const result = await deps.runner.run({
      scope: scopeOf(started.task),
      token,
      adapter: adapter.value as AgentAdapter,
      request: {
        ownerId: task.ownerId,
        tenantId: task.tenantId,
        conversationId: task.conversationId,
        objective: task.objective,
        ...(images.length > 0 ? { images } : {}),
        history,
        model: model.value.ref,
        routing,
        allowFallback: !pinned,
        mode: task.mode,
        operation: images.length > 0 ? 'multimodal' : 'work',
        workspaceRoot: workspace.value.root,
        maxSteps: deps.config.engines.native.maxSteps,
        budget: task.budget,
        signal: controller.signal,
      },
      report,
    });
    // Budget ownership is independent of task-ownership fences; release the
    // reservation before any guard that can return early.
    if (held) {
      if (result.outcome.kind === 'completed') {
        deps.budget.settle(held.id, result.outcome.usage ?? {});
      } else {
        // The external engine may have dispatched before failing; retain the
        // request charge while returning its unused token allowance.
        deps.budget.release(held.id, { dispatched: true });
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
    const creative = outcome.kind === 'completed' ? deps.creative.extract(outcome.summary) : [];
    await settle(
      started.task,
      token,
      outcome,
      { completedSteps: completed, text: safeText },
      creative.length > 0 ? creative : undefined,
    );
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

  function acceptedFor(task: TaskRecord): TaskAccepted {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      generation: task.generation,
      eventsPath: `/v1/work/${task.taskId}/events`,
    };
  }

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

  const service: ApplicationService = {
    health: () => deps.health.report(),
    readiness: () => deps.health.readiness(),
    agents: () => deps.agents.list(),
    models: () => deps.models.list(),
    artifacts: deps.artifactService,

    submitWork: async (principal, request) => {
      if (request.idempotencyKey) {
        const existing = await deps.tasks.findByIdempotencyKey(
          principal.ownerId,
          request.idempotencyKey,
        );
        if (existing) return ok(acceptedFor(existing));
      }

      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;

      const attachments = await resolveAttachments({
        principal,
        mode: request.mode,
        agent: agentId,
        mediaIds: request.attachments,
      });
      if (!attachments.ok) return attachments;
      const images = attachments.value.images;

      const routing = inferRoutingMode({
        objective: request.objective,
        ...(images.length > 0 ? { imageCount: images.length } : {}),
      });
      const model = deps.models.resolve(request.model, request.mode, {
        operation: images.length > 0 ? 'multimodal' : 'work',
        routing,
        estimatedInputTokens: estimateTokens([request.objective]) + images.length * 1_024,
        requireVision: images.length > 0,
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
        ...(attachments.value.mediaIds.length > 0
          ? { attachments: attachments.value.mediaIds }
          : {}),
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
        attachments: attachments.value.mediaIds,
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

      const applied = await deps.tasks.reissue({
        taskId,
        token,
        now: deps.clock.iso(),
        leaseExpiresAt: new Date(now.getTime() + deps.config.execution.leaseTtlMs).toISOString(),
      });
      if (!applied.applied) return fail('conflict', 'That task cannot be retried.');
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
      const attachments = await resolveAttachments({
        principal,
        mode: request.mode,
        agent: request.agent,
        mediaIds: request.attachments,
      });
      if (!attachments.ok) return attachments;
      const images = attachments.value.images;
      const routing = inferRoutingMode({
        objective: request.message,
        ...(images.length > 0 ? { imageCount: images.length } : {}),
      });
      const model = deps.models.resolve(request.model, request.mode, {
        operation: images.length > 0 ? 'multimodal' : 'chat',
        routing,
        estimatedInputTokens: estimateTokens([request.message]) + images.length * 1_024,
        requireVision: images.length > 0,
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
        ...(attachments.value.mediaIds.length > 0
          ? { attachments: attachments.value.mediaIds }
          : {}),
      });

      const history = await historyFor(conversationId, request.message);
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
      let outcome: AgentRunOutcome;
      try {
        outcome = await adapter.value.run(
          {
            ownerId: principal.ownerId,
            tenantId: conversation.tenantId,
            conversationId,
            objective: request.message,
            ...(images.length > 0 ? { images } : {}),
            history,
            model: model.value.ref,
            routing,
            allowFallback: request.model === undefined,
            mode: request.mode,
            operation: images.length > 0 ? 'multimodal' : 'chat',
            workspaceRoot: workspace.value.root,
            maxSteps: 1,
            budget: null,
            signal: controller.signal,
          },
          () => undefined,
        );
      } catch (error) {
        if (held) deps.budget.release(held.id, { dispatched: true });
        throw error;
      }
      if (!outcome.ok) {
        if (held) deps.budget.release(held.id, { dispatched: true });
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
      if (held) deps.budget.settle(held.id, outcome.usage ?? {});
      const messageId = deps.ids.messageId();
      // A model can echo a credential into generated markup; the same redaction
      // that covers the summary also covers what becomes a renderable artifact.
      const chatCreative = deps.creative.extract(redactContent(outcome.summary));
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
        ...(chatCreative.length > 0 ? { creative: chatCreative } : {}),
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

    markNotificationsRead: async (principal, taskIds) => {
      for (const taskId of taskIds) {
        await deps.notifications.markRead(principal.ownerId, taskId);
      }
      return deps.notifications.list(principal.ownerId);
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
      capabilities: {
        chat: capability('available', 'One Chat turn with the explicitly selected agent.'),
        chatStreaming: capability('available', 'Typed SSE frames; JSON remains available.'),
        work: capability('available', 'Durable Work tasks with fenced settlement.'),
        durableEvents: capability(
          'unconfigured',
          'Event replay is process-local; persistent event storage is owned by the unmerged durable-events branch.',
        ),
        eventReplay: capability('available', 'Replay and tail from a per-task sequence cursor.'),
        scheduling: capability(
          'available',
          `Durable schedules are stored in the ${deps.config.persistence.driver} store.`,
        ),
        artifacts: capability('available', 'Durable owner-scoped artifacts with immutable versions and sha256 verification.'),
        permissions: capability(
          'available',
          `Scoped approvals are stored in the ${deps.config.persistence.driver} store.`,
        ),
        memory: capability('available', 'Exact owner- and mode-partitioned key/value memory.'),
        rag: capability('unsupported', 'No embedding provider or vector retrieval is configured.'),
        multimodal: capability('available', 'Owner-scoped image upload and vision routing are available; private-mode off-device attachment stays off by default.'),
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

    listTasks: async (principal, query) => {
      const all = await deps.tasks.listByOwner(principal.ownerId);
      const filtered = query.state
        ? all.filter((task) => task.state === query.state)
        : all;
      filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const limit = query.limit ?? 50;
      return { tasks: filtered.slice(0, limit).map(toSummary), total: filtered.length };
    },

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

    pendingPermissions: (principal) => deps.permissions.listPending(principal.ownerId),

    listSchedules: async (principal) => ({
      schedules: (await deps.schedules.list(principal.ownerId)).map(toSchedule),
    }),

    createSchedule: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;
      const model = deps.models.resolve(request.model ?? null, request.mode, { operation: 'work' });
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

    mediaCapabilities: () => {
      const vision = deps.models
        .list()
        .models.find(
          (model) =>
            model.costClass === 'free' &&
            model.availability.available &&
            model.inputModalities?.includes('image') === true,
        );
      return deps.media.capabilities(
        vision
          ? {
              available: true,
              detail: 'A verified zero-cost model with image input is routable.',
            }
          : {
              available: false,
              detail:
                'No verified zero-cost model with image input is currently routable; image requests are refused rather than sent to a text-only or paid endpoint.',
            },
      );
    },

    uploadMedia: (principal, request) => deps.media.upload(principal.ownerId, request),

    mediaItem: (principal, mediaId) => deps.media.get(principal.ownerId, mediaId),

    validateCreative: async (_principal, request) =>
      deps.creative.validate({ format: request.format, content: request.content }),

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      return ok({
        replay: deps.events.replay(taskId, after),
        subscribe: (listener) => deps.events.subscribe(taskId, after, listener),
        lastSeq: deps.events.lastSeq(taskId),
        generation: found.value.generation,
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
