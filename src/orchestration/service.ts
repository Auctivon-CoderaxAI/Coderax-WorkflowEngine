import { scheduledConversationId } from '../scheduling/identity.js';
import type {
  AgentId,
  AgentList,
  BrowserAction,
  BrowserActionResult,
  BrowserArtifactContent,
  BrowserAuthorizationRequest,
  BrowserCapabilities,
  BrowserCloseRequest,
  BrowserReceiptList,
  BrowserSession,
  BrowserSessionCreateRequest,
  BrowserSessionList,
  BrowserTakeoverRequest,
  BrowserTakeoverResult,
  ArtifactGenerationRequest,
  ArtifactGenerationResult,
  BudgetState,
  BuildGameRequest,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  CreateGameRequest,
  CreateGameSessionRequest,
  DataMode,
  GameBuildList,
  GameCapabilityReport,
  GameExport,
  GameIteration,
  GameObservation,
  GameProject,
  GameProjectList,
  GameSession,
  GameSessionControlRequest,
  GameSessionList,
  GameSessionLogs,
  GameSessionVerification,
  IterateGameRequest,
  MemoryList,
  ModelList,
  ModelRef,
  NotificationList,
  PermissionDecisionRequest,
  PermissionList,
  RestoreGameBuildRequest,
  SaveGameSpecRequest,
  PermissionRequest,
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
  Usage,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { isTerminalExecution, isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type {
  ConversationRecord,
  GameRunSpec,
  ScheduleExecutionRecord,
  ScheduleRecord,
  TaskEvidence,
  TaskPatch,
  TaskPlan,
  TaskRecord,
  TaskStep,
} from '../domain.js';
import type { GameStudio } from '../games/studio.js';
import type { GameSessionService, GamingAgent } from '../games/session.js';
import { createGameCapabilityReport } from '../games/capability.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { ScheduleNoticeStore, ScheduleRepository } from '../persistence/schedules.js';
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
import { createScheduleEngine } from '../scheduling/engine.js';
import type { SchedulePort, ScheduleTickReport } from '../scheduling/engine.js';
import { nextOccurrence, previewOccurrences } from '../scheduling/calendar.js';
import { scheduleSideEffectRefusal } from '../scheduling/policy.js';
import type { AuthService, Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import {
  createRunWorkspace,
  removeRunWorkspaceIfEmpty,
  workspaceRoots,
} from '../execution/workspace.js';
import type { ArtifactService } from '../artifacts/service.js';
import type { ArtifactGenerator } from '../artifacts/generate.js';
import { buildTranscript } from './transcript.js';
import type { BrowserService } from './browser.js';
import { resolveReasoningMode } from '../agents/native/reason.js';

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
  artifactService: ArtifactService;
  artifactGenerator: ArtifactGenerator;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  studio: GameStudio;
  sessions: GameSessionService;
  gaming: GamingAgent;
  browser: BrowserService;
  supervisor: RunSupervisor;
};

export type EventStream = {
  /** The first page at the caller's cursor, with the durable log's own metadata. */
  replay: Replay;
  /** Tails strictly after the last replayed event, so the hand-off loses nothing. */
  subscribe: (listener: (event: unknown) => void) => Unsubscribe;
};

export type ApplicationService = {
  health: () => ReturnType<HealthService['report']>;
  readiness: () => ReturnType<HealthService['readiness']>;
  agents: () => AgentList;
  models: () => ModelList;
  browserCapabilities: () => Promise<BrowserCapabilities>;
  browserSessions: (principal: Principal) => Promise<BrowserSessionList>;
  browserSession: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<BrowserSession>>;
  createBrowserSession: (
    principal: Principal,
    request: BrowserSessionCreateRequest,
  ) => Promise<ServiceResult<BrowserSession>>;
  browserAction: (
    principal: Principal,
    sessionId: string,
    action: BrowserAction,
  ) => Promise<ServiceResult<BrowserActionResult>>;
  pauseBrowserSession: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<BrowserSession>>;
  resumeBrowserSession: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<BrowserSession>>;
  takeoverBrowserSession: (
    principal: Principal,
    sessionId: string,
    request: BrowserTakeoverRequest,
  ) => Promise<ServiceResult<BrowserTakeoverResult>>;
  closeBrowserSession: (
    principal: Principal,
    sessionId: string,
    request: BrowserCloseRequest,
  ) => Promise<ServiceResult<BrowserSession>>;
  authorizeBrowserSession: (
    principal: Principal,
    sessionId: string,
    request: BrowserAuthorizationRequest,
  ) => Promise<ServiceResult<PermissionRequest>>;
  decideBrowserAuthorization: (
    principal: Principal,
    sessionId: string,
    request: PermissionDecisionRequest,
  ) => Promise<ServiceResult<PermissionList>>;
  browserReceipts: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<BrowserReceiptList>>;
  browserArtifact: (
    principal: Principal,
    artifactId: string,
  ) => Promise<ServiceResult<BrowserArtifactContent>>;
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
  notifications: (principal: Principal, includeSchedules?: boolean) => Promise<NotificationList>;
  /** Durable artifact storage; the only path that returns artifact bytes. */
  artifacts: ArtifactService;
  /** Renders a deliverable and persists it through the artifact tree adapter. */
  generateArtifact: (
    principal: Principal,
    request: ArtifactGenerationRequest,
  ) => Promise<ServiceResult<ArtifactGenerationResult>>;
  events: (
    principal: Principal,
    taskId: string,
    after: number,
  ) => Promise<ServiceResult<EventStream>>;
  budget: (principal: Principal) => BudgetState;
  gameCapabilities: (principal: Principal) => GameCapabilityReport;
  listGames: (
    principal: Principal,
    query: { cursor?: string; limit?: number },
  ) => Promise<GameProjectList>;
  createGame: (
    principal: Principal,
    request: CreateGameRequest,
  ) => Promise<ServiceResult<GameProject>>;
  getGame: (principal: Principal, gameId: string) => Promise<ServiceResult<GameProject>>;
  saveGameSpec: (
    principal: Principal,
    gameId: string,
    request: SaveGameSpecRequest,
  ) => Promise<ServiceResult<GameProject>>;
  buildGame: (
    principal: Principal,
    gameId: string,
    request: BuildGameRequest,
  ) => Promise<ServiceResult<import('@coderax/contracts').GameBuild>>;
  listGameBuilds: (
    principal: Principal,
    gameId: string,
  ) => Promise<ServiceResult<GameBuildList>>;
  restoreGameBuild: (
    principal: Principal,
    gameId: string,
    buildId: string,
    request: RestoreGameBuildRequest,
  ) => Promise<ServiceResult<GameProject>>;
  iterateGame: (
    principal: Principal,
    gameId: string,
    request: IterateGameRequest,
  ) => Promise<ServiceResult<GameIteration>>;
  gamePreview: (principal: Principal, gameId: string) => Promise<ServiceResult<string>>;
  exportGame: (principal: Principal, gameId: string) => Promise<ServiceResult<GameExport>>;
  createGameSession: (
    principal: Principal,
    gameId: string,
    request: CreateGameSessionRequest,
  ) => Promise<ServiceResult<GameSession>>;
  listGameSessions: (principal: Principal) => Promise<GameSessionList>;
  getGameSession: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<GameSession>>;
  observeGameSession: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<GameObservation>>;
  controlGameSession: (
    principal: Principal,
    sessionId: string,
    request: GameSessionControlRequest,
  ) => Promise<ServiceResult<GameSession>>;
  gameSessionLogs: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<GameSessionLogs>>;
  gameSessionVerification: (
    principal: Principal,
    sessionId: string,
  ) => Promise<ServiceResult<GameSessionVerification>>;
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
  markNotificationsRead: (principal: Principal, includeSchedules?: boolean) => Promise<NotificationList>;
  /** The background loop that discharges schedules without a client connected. */
  startSchedules: () => void;
  stopSchedules: () => Promise<void>;
  tickSchedules: () => Promise<ScheduleTickReport>;
  /** Startup ownership verification: retires runs whose lease is gone. */
  recoverInterrupted: () => Promise<{ interrupted: number }>;
  /** Stop admitting new execution work before the listener is closed. */
  beginShutdown: () => void;
  /** Abort active work, drain the scheduler and settle its writes. */
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
  const admissions = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  function unavailable(): ServiceResult<never> {
    return fail('not_ready', 'The engine is shutting down.');
  }

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

  /**
   * Appends one event to the durable log for the generation that owns the task.
   * Callers that can be told about a failure await it, so a settlement never
   * announces state the stream has not recorded. A refused append means this
   * generation no longer holds the fence, and writing nothing is the outcome.
   */
  async function publish(
    task: TaskRecord,
    type: Parameters<EventBus['publish']>[0]['type'],
    payload?: unknown,
    /** Present for run-origin events: a revoked generation may not publish. */
    token?: string,
  ): Promise<void> {
    if (token !== undefined && !deps.supervisor.isLive(task.taskId, token)) return;
    await deps.events.publish({
      taskId: task.taskId,
      runToken: task.runToken ?? '',
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
      ...(task.reasoning ? { reasoning: task.reasoning } : {}),
      steps: task.steps.map((step) => ({
        id: step.id,
        title: step.title,
        state: step.state,
        ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
        ...(step.attempts !== undefined ? { attempts: step.attempts } : {}),
      })),
      ...(task.result
        ? {
            result: {
              ...(task.result.summary ? { summary: task.result.summary } : {}),
              artifacts: task.result.artifacts,
              ...(task.result.verification
                ? {
                    verification: {
                      passed: task.result.verification.passed,
                      reason: redactText(task.result.verification.reason, [], 1000),
                      evidence: task.result.verification.evidence
                        .slice(0, 20)
                        .map((entry) => redactText(entry, [], 500)),
                    },
                  }
                : {}),
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

  /** Usage is cumulative across a suspend/resume boundary, never reset by it. */
  function mergeUsage(previous: Usage | null, next: Usage | undefined): Usage | null {
    if (!previous && !next) return null;
    const inputTokens = (previous?.inputTokens ?? 0) + (next?.inputTokens ?? 0);
    const outputTokens = (previous?.outputTokens ?? 0) + (next?.outputTokens ?? 0);
    return {
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
    };
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
    steps?: TaskRecord['steps'],
  ): Promise<void> {
    if (outcome.kind === 'interrupted') {
      return;
    }
    const now = deps.clock.iso();
    const failureDetail = outcome.kind === 'failed' ? redactText(outcome.detail, [], 1000) : undefined;
    const generationUsage = 'usage' in outcome ? outcome.usage : undefined;
    const mergedUsage = mergeUsage(task.usage, generationUsage);
    let partialSaved = false;

    // Escalation is a suspended state, not a failure: the plan, its checkpoint
    // and any partial text stay durable so an approved resume continues exactly
    // where authorization stopped. No completion notification is emitted because
    // nothing completed.
    if (outcome.kind === 'failed' && outcome.code === 'approval_required') {
      // Save partial text before another generation can start.
      const partial = checkpoint?.text ?? '';
      if (partial.length > 0) {
        partialSaved = await deps.conversations
          .appendMessage({
            messageId: deps.ids.messageId(),
            conversationId: task.conversationId,
            role: 'assistant',
            text: partial,
            createdAt: now,
            unfinished: true,
            agent: task.agent,
          })
          .then(() => true, () => false);
      }
      // Persist the suspension under the old fence before releasing ownership.
      // A restart between these operations can resume from the saved checkpoint
      // once the old lease expires.
      const applied = await deps.tasks.updateFenced({
        taskId: task.taskId,
        token,
        guard: 'not_cancel_requested',
        patch: {
          state: 'awaiting_approval',
          updatedAt: now,
          leaseExpiresAt: null,
          failure: {
            code: outcome.code,
            detail: failureDetail,
            retryable: false,
          },
          ...(checkpoint ? { checkpoint } : {}),
          ...(steps ? { steps } : {}),
          ...(checkpoint?.plan ? { reasoning: checkpoint.plan.mode } : {}),
          ...(mergedUsage ? { usage: mergedUsage } : {}),
        },
      });
      if (!applied.applied && applied.reason === 'guard_rejected') {
        // The cancellation flag won the task write after the runner stopped.
        outcome = { kind: 'cancelled' };
      } else {
        try {
          if (applied.applied) {
            // Suspension settles this generation's usage even though the task is not
            // terminal. The resumed generation is charged separately, so the daily
            // ledger matches the cumulative usage the owner sees.
            if (generationUsage) {
              deps.budget.consume(task.ownerId, generationUsage, new Date(now));
            }
            deps.audit.record({
              actor: task.ownerId,
              action: 'work.awaiting_approval',
              taskId: task.taskId,
              conversationId: task.conversationId,
              outcome: 'accepted',
              detail: outcome.code,
            });
          }
        } finally {
          await releaseLease(task, token);
        }
        return;
      }
    }

    const patch =
      outcome.kind === 'completed'
        ? {
            state: 'completed' as const,
            updatedAt: now,
            result: {
              summary: outcome.summary.slice(0, 20_000),
          artifacts: task.kind === 'game'
            ? (outcome.artifacts ?? [])
          : [],
              ...(outcome.verification
                ? {
                    verification: {
                      passed: outcome.verification.passed,
                      reason: redactText(outcome.verification.reason, [], 1000),
                      evidence: outcome.verification.evidence
                        .slice(0, 20)
                        .map((entry) => redactText(entry, [], 500)),
                    },
                  }
                : {}),
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
                // Provider text is redacted before it is stored, not only on read.
                detail: failureDetail,
                retryable: outcome.retryable,
              },
            };

    const statePatch = {
      ...patch,
      ...(checkpoint ? { checkpoint } : {}),
      ...(steps ? { steps } : {}),
      ...(checkpoint?.plan ? { reasoning: checkpoint.plan.mode } : {}),
      ...(mergedUsage ? { usage: mergedUsage } : {}),
    };
    const applied = await deps.tasks.updateFenced({
      taskId: task.taskId,
      token,
      patch: statePatch,
    });
    if (!applied.applied) {
      if (applied.reason === 'terminal' || applied.reason === 'superseded') {
        await releaseLease(task, token);
      }
      return;
    }

    const settled = applied.task;
    // Charge the usage produced by this generation, not the merged task total:
    // the previous generation was already charged when it settled.
    if (generationUsage) {
      deps.budget.consume(task.ownerId, generationUsage, new Date(now));
    }
    try {
      if (outcome.kind === 'completed') {
        await publish(settled, 'task.completed', {
          summary: outcome.summary.slice(0, 20_000),
          ...(task.model ? { model: task.model } : {}),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
      } else if (outcome.kind === 'cancelled') {
        await publish(settled, 'task.cancelled', {});
      } else {
        await publish(settled, 'task.failed', {
          code: outcome.code, detail: failureDetail, retryable: outcome.retryable,
        });
      }

      const text = checkpoint?.text ?? '';
      if (text.length > 0 && !partialSaved) {
        await deps.conversations.appendMessage({
          messageId: deps.ids.messageId(),
          conversationId: task.conversationId,
          role: 'assistant',
          text,
          createdAt: now,
          agent: task.agent,
        }).catch(() => undefined);
      }
      const detail = outcome.kind === 'completed' ? outcome.summary : failureDetail;
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

  /**
   * The gaming workload is a Native capability, not a fourth agent identity. It
   * borrows the supervisor's lease, fencing, cancellation and event path through
   * the same adapter port; only the run body differs.
   */
  function gamingAdapter(task: TaskRecord): AgentAdapter {
    return {
      agent: task.agent,
      engine: 'native',
      sideEffects: 'gated',
      capabilities: {
        streaming: false,
        tools: false,
        cancellation: true,
        resume: true,
        modelSelection: false,
        durable: true,
      },
      isolation: {
        workspace: 'isolated',
        memory: 'granted',
        credentials: 'none',
        conversations: 'none',
      },
      availability: () => ({
        available: true,
        reason: 'ready',
        detail: 'The Native gaming workload is ready inside the isolated runtime.',
      }),
      run: (request, report) => {
        if (!request.game) {
          return Promise.resolve({
            ok: false as const,
            code: 'protocol_error' as const,
            detail: 'A game task has no session payload.',
            retryable: false,
          });
        }
        return deps.gaming.run({
          ownerId: request.ownerId,
          taskId: request.taskId ?? task.taskId,
          game: request.game,
          signal: request.signal,
          report,
          loadBuild: (ownerId, gameId, buildId) =>
            deps.studio.readVerifiedBuild({ ownerId, gameId, buildId }),
          isApproved: (taskId, scope, resource) =>
            deps.permissions.isApproved(taskId, scope, resource),
        });
      },
    };
  }
  // Earlier tasks have no explicit marker. Their accounting write or persisted
  // execution steps are evidence of admission; an interrupted claim alone is not.
  async function canRunScheduled(task: TaskRecord): Promise<boolean> {
    const admission = task.scheduleAdmission;
    if (!admission) {
      if (!/^task_sched_[0-9a-f]{40}$/.test(task.taskId)) return true;
      // Older scheduled retry tasks had no schedule pointer. Their conversation
      // still identifies the schedule; never reissue an unproven interrupted run.
      const schedules = await deps.schedules.listByOwner(task.ownerId);
      const legacy = schedules.find(record => scheduledConversationId(record.scheduleId) === task.conversationId);
      return !!legacy && legacy.state !== 'cancelled' && task.steps.length > 0;
    }
    const schedule = await deps.schedules.get(admission.scheduleId);
    if (!schedule || schedule.state === 'cancelled') return false;
    return admission.complete ?? (schedule.lastExecutionId === admission.executionId || task.steps.length > 0);
  }

  async function rejectUnscheduledRun(task: TaskRecord, token: string): Promise<ServiceResult<never>> {
    await settle(task, token, {
      kind: 'failed',
      code: 'server_unavailable',
      detail: 'The engine shut down before the run could be scheduled.',
      retryable: true,
    });
    return unavailable();
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
    if (lease.token !== token) return;
    if (task.cancelRequested || lease.cancelRequested) {
      await settle(task, token, { kind: 'cancelled' });
      return;
    }

    const workload = task.kind ?? 'work';
    let adapter: AgentAdapter;
    let modelRef: ModelRef | null = null;
    if (workload === 'game') {
      adapter = gamingAdapter(task);
    } else {
      const resolved = deps.agents.resolve(task.agent);
      if (!resolved.ok) {
        await settle(task, token, {
          kind: 'failed',
          code: 'not_configured',
          detail: resolved.detail,
          retryable: false,
        });
        return;
      }
      adapter = resolved.value;
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
      modelRef = model.value.ref;
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
        ...(task.handoffPending && { handoffPending: false }),
        updatedAt: deps.clock.iso(),
        leaseExpiresAt: lease.expiresAt.toISOString(),
        ...(modelRef ? { model: modelRef } : {}),
      },
    });
    if (!started.applied) return;
    await deps.supervisor.begin({
      taskId,
      token,
      generation: started.task.generation,
      workspaceRoot: workspace.value.root,
    });
    await publish(started.task, 'task.started');

    const controller = new AbortController();
    controllers.set(taskId, controller);

    /**
     * A report arrives synchronously but the append is asynchronous. Chaining the
     * appends preserves the order the adapter produced, and `drain` makes the run
     * wait for the log before it settles, so a replay can never show a settlement
     * whose deltas were not written.
     */
    let emitted: Promise<void> = Promise.resolve();
    let emitFailure: { error: unknown } | null = null;
    const emit = (
      type: Parameters<EventBus['publish']>[0]['type'],
      payload?: unknown,
    ): void => {
      emitted = emitted
        .then(() => publish(started.task, type, payload, token))
        .then(
          () => undefined,
          (error: unknown) => {
            emitFailure ??= { error };
          },
        );
    };
    const drain = async (): Promise<void> => {
      await emitted;
      const failed = emitFailure;
      emitFailure = null;
      if (failed) throw failed.error;
    };

    const steps = [...started.task.steps];
    const completed: string[] = [...started.task.checkpoint.completedSteps];
    const evidence: TaskEvidence[] = [...(started.task.checkpoint.evidence ?? [])];
    let plan: TaskPlan | null = started.task.checkpoint.plan ?? null;
    let iterations = started.task.checkpoint.iterations ?? 0;
    let text = '';
    let visible = text;
    // Report patches are snapshots of mutable local arrays. Serialize them in
    // issue order so a delayed plan.ready cannot overwrite a later completed
    // checkpoint on a replica that applies writes out of order.
    let writeChain: Promise<void> = Promise.resolve();
    const persist = (patch: TaskPatch): void => {
      const snapshot = structuredClone(patch);
      writeChain = writeChain
        .then(async () => {
          await deps.tasks.updateFenced({ taskId, token, patch: snapshot });
        })
        .catch(() => undefined);
    };
    const emitText = (next: string, replace = false): void => {
      if (replace || !next.startsWith(visible)) {
        emit('text.replace', { text: next });
      } else if (next !== visible) {
        emit('text.delta', { text: next.slice(visible.length) });
      }
      visible = next;
    };

    const report = (event: AgentReportEvent): void => {
      if (controllers.get(taskId) !== controller || controller.signal.aborted) return;

      // The controller is replaced by a resume; the supervisor is the durable
      // answer to "may this generation still act". Both must agree.
      if (!deps.supervisor.isLive(taskId, token)) return;

      if (event.type === 'budget') {
        iterations = event.iterations;
        return;
      }

      /**
       * A plan is persisted before its first step starts, so the owner can see
       * the dependency graph and a resume executes the plan that was shown, not
       * a different one produced by a second model call.
       */
      if (event.type === 'plan.ready') {
        plan = event.plan;
        const previous = new Map(steps.map((step) => [step.id, step]));
        const next: TaskStep[] = event.plan.steps.map((step) => {
          const existing = previous.get(step.id);
          const state = existing?.state ?? (completed.includes(step.id) ? 'completed' : 'queued');
          return {
            id: step.id,
            title: step.title,
            state,
            dependsOn: [...step.dependsOn],
            ...(existing?.attempts !== undefined ? { attempts: existing.attempts } : {}),
          };
        });
        for (const step of steps) {
          if (step.state === 'completed' && !next.some((entry) => entry.id === step.id)) {
            next.unshift(step);
          }
        }
        steps.length = 0;
        steps.push(...next);
        persist({
          steps,
          reasoning: event.plan.mode,
          checkpoint: {
            completedSteps: [...completed],
            text: visible,
            plan: event.plan,
            evidence,
            iterations,
          },
          updatedAt: deps.clock.iso(),
        });
        return;
      }

      if (event.type === 'step.started') {
        const planned = plan?.steps.find((step) => step.id === event.stepId);
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) {
          existing.state = 'running';
          if (planned) existing.dependsOn = [...planned.dependsOn];
        } else {
          steps.push({
            id: event.stepId,
            title: event.title,
            state: 'running',
            ...(planned ? { dependsOn: [...planned.dependsOn] } : {}),
          });
        }
        emit('step.started', { stepId: event.stepId, title: event.title });
        persist({ steps, updatedAt: deps.clock.iso() });
        return;
      }
      if (event.type === 'step.completed') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) {
          existing.state = 'completed';
          if (event.attempts !== undefined) existing.attempts = event.attempts;
        }
        if (!completed.includes(event.stepId)) completed.push(event.stepId);
        if (event.evidence) {
          // Evidence is persisted, so it is scrubbed before it reaches the
          // checkpoint: the transcript path already redacts, and a durable
          // record must not become the one place a credential survives.
          const safeEvidence: TaskEvidence = {
            ...event.evidence,
            citation: redactText(event.evidence.citation, [], 500),
            output: redactContent(event.evidence.output).slice(0, 20_000),
          };
          const index = evidence.findIndex((entry) => entry.stepId === event.stepId);
          if (index === -1) evidence.push(safeEvidence);
          else evidence[index] = safeEvidence;
        }
        emit('step.completed', { stepId: event.stepId, title: event.title });
        persist({
          steps,
          checkpoint: { completedSteps: [...completed], text: visible, plan, evidence, iterations },
          updatedAt: deps.clock.iso(),
        });
        return;
      }
      if (event.type === 'step.failed') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'failed';
        persist({ steps, updatedAt: deps.clock.iso() });
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
        emit('tool.call', {
          callId: event.callId,
          tool: event.tool,
          ...(event.input === undefined ? {} : { input: redactToolInput(event.input) }),
        });
        return;
      }
      if (event.type === 'tool.result') {
        emit('tool.result', {
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
        emit('file.edit', { path: event.path });
        return;
      }
      /**
       * An approval is published, not granted: the permission store is the only
       * authority that can approve a resource, and the adapter must have created
       * that request before reporting it.
       */
      emit('approval.required', {
        requestId: event.requestId,
        tool: event.tool,
        description: redactText(event.description, [], 2000),
      });
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
      adapter,
    );

    let result: RunResult;
    try {
      result = await deps.runner.run({
        scope: scopeOf(started.task),
        ...((task.scheduleAdmission ||
          task.taskId.startsWith('task_sched_')) && {
          cancellationRequested: async () =>
            !(await canRunScheduled(task)),
        }),
        token,
        adapter,
        request: {
          ownerId: task.ownerId,
          tenantId: task.tenantId,
          conversationId: task.conversationId,
          taskId: task.taskId,
          workload,
          game: task.game ?? null,
          objective: task.objective,
          history,
          model: modelRef,
          mode: task.mode,
          workspaceRoot: workspace.value.root,
          maxSteps: deps.config.engines.native.maxSteps,
          budget: task.budget,
          signal: controller.signal,
          reasoning: task.reasoning ?? 'auto',
          completedSteps: [...started.task.checkpoint.completedSteps],
          plan: started.task.checkpoint.plan ?? null,
          evidence: [...(started.task.checkpoint.evidence ?? [])],
          iterationsUsed: started.task.checkpoint.iterations ?? 0,
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

    const current = controllers.get(taskId);
    const superseded = current !== undefined && current !== controller;
    if (!superseded) controllers.delete(taskId);
    await writeChain.catch(() => undefined);

    const verified = result.terminated;
    try {
      if (superseded || result.ownershipLost) {
        return;
      }
      const safeText = redactContent(text);
      emitText(safeText);
      await drain();
      const outcome = result.outcome.kind === 'completed'
        ? { ...result.outcome, summary: redactContent(result.outcome.summary) }
        : result.outcome;
      await settle(
        started.task,
        token,
        outcome,
        {
          completedSteps: completed,
          text: safeText,
          plan,
          evidence,
          iterations,
        },
        steps,
      );
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
        await publish(applied.task, 'task.interrupted', {
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

  async function cancelSuspended(task: TaskRecord): Promise<ServiceResult<TaskControlResult>> {
    const applied = await deps.tasks.updateFenced({
      taskId: task.taskId,
      token: task.runToken ?? '',
      patch: {
        state: 'cancelled',
        updatedAt: deps.clock.iso(),
        cancelRequested: true,
      },
    });
    if (applied.applied) {
      await publish(applied.task, 'task.cancelled', {});
      await notifyTerminal(applied.task, 'cancelled');
      deps.audit.record({
        actor: task.ownerId,
        action: 'work.cancelled',
        taskId: task.taskId,
        conversationId: task.conversationId,
        outcome: 'cancelled',
      });
      return ok({
        taskId: task.taskId,
        state: 'cancelled',
        generation: task.generation,
        outcome: 'accepted',
      });
    }
    return lostCancellation(task);
  }

  async function admitTask(input: {
    principal: Principal;
    agentId: 'coderax';
    objective: string;
    mode: 'cloud';
    model: null;
    budget: null;
    requireApproval: boolean;
    kind: 'game';
    game: GameRunSpec;
  }): Promise<ServiceResult<{
    task: TaskRecord;
    token: string;
    conversationId: string;
  }>> {
    const now = deps.clock.iso();

    const bound = await bindConversation({
      principal: input.principal,
      mode: input.mode,
      isWork: true,
      agent: input.agentId,
      title: input.objective.slice(0, 120),
    });
    if (!bound.ok) return bound;

    const conversationId = bound.value.conversationId;

    await deps.conversations.appendMessage({
      messageId: deps.ids.messageId(),
      conversationId,
      role: 'user',
      text: input.objective,
      createdAt: now,
    });

    const task: TaskRecord = {
      taskId: deps.ids.taskId(),
      ownerId: input.principal.ownerId,
      tenantId: null,
      conversationId,
      agent: input.agentId,
      engine: 'native',
      mode: input.mode,
      kind: input.kind,
      game: input.game,
      objective: input.objective,
      model: null,
      state: 'queued',
      generation: 1,
      runToken: null,
      eventSeq: 0,
      reasoning: null,
      steps: [],
      checkpoint: {
        completedSteps: [],
        text: '',
        plan: null,
        evidence: [],
      },
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: null,
      cancelRequested: false,
      requireApproval: input.requireApproval,
      budget: null,
      usage: null,
      result: null,
      failure: null,
    };

    const token = deps.ids.runToken();
    const claimedAt = deps.clock.now();
    const key = workRunKey(scopeOf(task));
    const expiresAt = new Date(
      claimedAt.getTime() +
        deps.config.execution.leaseTtlMs,
    );

    const claimed = await deps.lease.claim({
      key,
      owner: task.ownerId,
      token,
      now: claimedAt,
      expiresAt,
    });

    if (!claimed) {
      return fail(
        'busy',
        'This conversation already has a live Work run.',
      );
    }

    const created = await deps.tasks.create({
      ...task,
      runToken: token,
      leaseExpiresAt: expiresAt.toISOString(),
    });

    if (!created.ok) {
      await deps.lease.release({ key, token })
        .catch(() => false);
      return fail(
        'busy',
        'This conversation already has an active Work task.',
      );
    }

    await publish(created.task, 'task.queued');

    deps.audit.record({
      actor: input.principal.ownerId,
      action: 'game.session.accepted',
      taskId: task.taskId,
      conversationId,
      outcome: 'accepted',
    });

    return ok({
      task: created.task,
      token,
      conversationId,
    });
  }
  
  async function lostCancellation(task: TaskRecord): Promise<ServiceResult<TaskControlResult>> {
    const current = await deps.tasks.get(task.taskId);
    const cancelled = current?.runToken === task.runToken && current?.state === 'cancelled';
    return ok({
      taskId: task.taskId,
      state: current?.state ?? task.state,
      generation: current?.generation ?? task.generation,
      outcome: cancelled ? 'accepted' : 'superseded',
    });
  }

  function trackAdmission<Args extends unknown[], Reply>(
    admit: (...args: Args) => Promise<ServiceResult<Reply>>,
  ): (...args: Args) => Promise<ServiceResult<Reply>> {
    return async (...args) => {
      if (shuttingDown) return unavailable();
      // Register before admission can call any collaborator.
      const admission = Promise.resolve().then(() => admit(...args));
      admissions.add(admission);
      try {
        return await admission;
      } finally {
        admissions.delete(admission);
      }
    };
  }



  type SubmitOptions = { scheduleAdmission?: TaskRecord['scheduleAdmission']; eligible?: () => Promise<boolean>; taskId?: string; conversationId?: string };

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

    const reasoning = resolveReasoningMode({ requested: request.reasoning, objective: request.objective });

    const now = deps.clock.iso();
    // Bind before reserving: a conversation owned by another principal, bound to
    // another data mode or opened by the other surface is refused here, without
    // spending the daily budget or letting private history into a cloud run.
    const target = options.conversationId ?? request.conversationId;
    const bound = await bindConversation({
      principal,
      ...(target ? { conversationId: target } : {}),
      mode: request.mode,
      isWork: true,
      agent: agentId,
      title: request.objective.slice(0, 120),
    });
    if (!bound.ok) return bound;
    const conversationId = bound.value.conversationId;

    const reserve = () => deps.budget.reserve(principal.ownerId, deps.clock.now()).allowed;
    if (!(options.taskId ? deps.budget.available(principal.ownerId, deps.clock.now()) : reserve())) {
      return fail(
        'budget_exhausted',
        'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
      );
    }
    const appendObjective = () => deps.conversations.appendMessage({
      messageId: options.taskId ? `msg_${options.taskId}` : deps.ids.messageId(),
      conversationId,
      role: 'user',
      text: request.objective,
      createdAt: now,
    });

    if (!options.taskId) await appendObjective();

    const task: TaskRecord = {
      ...(options.scheduleAdmission ? { scheduleAdmission: options.scheduleAdmission, handoffPending: true } : {}),
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
      eventSeq: 0,
      reasoning,
      steps: [],
      checkpoint: { completedSteps: [], text: '', plan: null, evidence: [] },
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

    if (options.taskId) {
      // A lost append acknowledgement can be retried with the same message ID.
      // No task exists or budget is reserved until its objective is durable.
      try {
        if (!(await appendObjective())) {
          const messages = await deps.conversations.messages({
            ownerId: principal.ownerId,
            conversationId,
            mode: request.mode,
          }) ?? [];
          if (!messages.some(message => message.messageId === `msg_${options.taskId}`)) {
            throw new Error('The scheduled objective was not persisted.');
          }
        }
      } catch (error) {
        await deps.lease.release({ key, token });
        throw error;
      }
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

    if (options.taskId) {
      // The unique task insert elects the only writer of admission effects.
      // The task is now visible to cancellation, but cannot execute until enqueue.
      const reservation = deps.budget.reserve(principal.ownerId, deps.clock.now());
      if (!reservation.allowed) {
        await settle(created.task, token, { kind: 'failed', code: 'budget_exhausted', detail: 'The daily request budget is exhausted.', retryable: false });
        return fail('budget_exhausted', 'The daily request budget is exhausted.');
      }
      let admitted: boolean;
      try {
        admitted = !options.eligible || await options.eligible();
      } catch (error) {
        reservation.release();
        await settle(created.task, token, { kind: 'cancelled' });
        throw error;
      }
      if (!admitted) {
        reservation.release();
        await settle(created.task, token, { kind: 'cancelled' });
        return fail('validation_failed', 'That occurrence is no longer eligible.');
      }
      if (options.scheduleAdmission) {
        let marked;
        try {
          marked = await deps.tasks.updateFenced({
            taskId: task.taskId, token,
            patch: { scheduleAdmission: { ...options.scheduleAdmission, complete: true } },
          });
        } catch (error) {
          // An acknowledgement can be lost after the write committed. Only the
          // original owner may finish this delivery or roll back its reservation.
          const durable = await deps.tasks.get(task.taskId);
          if (!durable?.scheduleAdmission?.complete && durable?.runToken === token) {
            await settle(created.task, token, { kind: 'cancelled' });
            const cancelled = await deps.tasks.get(task.taskId);
            if (cancelled?.runToken === token && cancelled.state === 'cancelled') reservation.release();
            throw error;
          }
          if (durable?.runToken !== token || durable.state !== 'queued') throw error;
          marked = { applied: true };
        }
        if (!marked.applied) {
          const durable = await deps.tasks.get(task.taskId);
          if (durable && durable.runToken !== token) return fail('conflict', 'Another generation owns this handoff.');
          reservation.release();
          return fail('validation_failed', 'Scheduled Work lost ownership before enqueue.');
        }
      }
    }

    await publish(created.task, 'task.queued');
    deps.audit.record({
      actor: principal.ownerId,
      action: 'work.accepted',
      taskId: task.taskId,
      conversationId,
      outcome: 'accepted',
      detail: `agent=${agentId} model=${modelKey(model.value.ref)}`,
    });

    if (!deps.scheduler.enqueue(() => execute(task.taskId, token))) {
      return rejectUnscheduledRun(created.task, token);
    }

    return ok({
      taskId: task.taskId,
      conversationId,
      state: 'queued',
      generation: 1,
      eventsPath: `/v1/work/${task.taskId}/events`,
    });
  }

  const schedulePort: SchedulePort = {
    dispatch: async ({ schedule, scheduleVersion, taskId, conversationId, trigger, selectedTimingRevision, occurrenceKey, executionId, accept }) => {
      // A dispatch can race an owner edit, pause, cancellation or an event-rule
      // change. The occurrence was selected from an exact revision, timing rule
      // and occurrence key; a newer schedule must be re-evaluated, never
      // submitted with the stale plan it was admitted under.
      const current = await deps.schedules.get(schedule.scheduleId);
      if (!current) {
        return { ok: false, reason: 'refused', detail: 'That schedule no longer exists.' };
      }
      if (current.state === 'cancelled') {
        return { ok: false, reason: 'refused', detail: 'That schedule is cancelled.' };
      }
      const eligible = (record: ScheduleRecord | null) => !!record && record.state !== 'cancelled' &&
        (trigger === 'manual' || trigger === 'retry' ||
          (record.state === 'active' && (record.timingRevision ?? 0) === selectedTimingRevision &&
            (trigger !== 'schedule' || record.nextRunAt === occurrenceKey)));
      if (!eligible(current)) return { ok: false, reason: 'refused', detail: 'That occurrence is no longer eligible.' };
      if (current.version !== scheduleVersion) {
        return {
          ok: false,
          reason: 'refused',
          detail: 'The schedule changed while this occurrence was being prepared.',
        };
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
        { ownerId: current.ownerId, isOwner: true },
        {
          objective: current.objective,
          agent: current.agent,
          ...(current.model ? { model: current.model } : {}),
          mode: current.mode,
          ...(current.limits.budget ? { budget: current.limits.budget } : {}),
          // A schedule never widens autonomy: every side effect still needs a
          // scoped owner decision from the permission store.
          requireApproval: true,
          conversationId,
        },
        { taskId, conversationId, scheduleAdmission: { scheduleId: current.scheduleId, executionId, complete: false }, eligible: () => accept(eligible) },
      );
      if (accepted.ok) return { ok: true };
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

    recoverHandoff: async (receipt, admit) => {
      if (!receipt.taskId) return;
      const task = await deps.tasks.get(receipt.taskId);
      const admission = task?.scheduleAdmission;
      if (!task?.handoffPending || !admission || admission.executionId !== receipt.executionId ||
          (task.state !== 'queued' && task.state !== 'interrupted')) return;
      const key = workRunKey(scopeOf(task));
      const now = deps.clock.now();
      const expiresAt = new Date(now.getTime() + deps.config.execution.leaseTtlMs);
      const token = deps.ids.runToken();
      if (!await deps.lease.claim({ key, owner: task.ownerId, token, now, expiresAt })) return;
      const claim = await deps.schedules.getExecution(receipt.executionId);
      if (!claim || (claim.state !== 'claimed' && claim.state !== 'dispatched') ||
          claim.taskId !== task.taskId || claim.claimGeneration !== receipt.claimGeneration) {
        await releaseLease(task, token);
        return;
      }
      const owned = await deps.tasks.takeHandoff(task.taskId, task.generation, token, expiresAt.toISOString());
      if (!owned) { await releaseLease(task, token); return; }
      const current = await deps.schedules.get(receipt.scheduleId);
      // admissionStarted proves the insert won and reserved its request. A stop
      // before that point has no durable acceptance to deliver.
      const admitted = owned.scheduleAdmission?.complete || (claim.admissionStarted &&
        (current?.lastExecutionId === receipt.executionId || await admit()));
      if (!admitted || owned.cancelRequested || !current || current.state === 'cancelled') {
        await settle(owned, token, { kind: 'cancelled' });
        return;
      }
      const marked = await deps.tasks.updateFenced({ taskId: task.taskId, token,
        patch: { scheduleAdmission: { ...admission, complete: true } } });
      if (marked.applied) deps.scheduler.enqueue(() => execute(task.taskId, token));
    },
    claimScheduledRetry: (taskId, generation) => deps.tasks.claimScheduledRetry(taskId, generation),
    taskSnapshot: async (taskId) => {
      const task = await deps.tasks.get(taskId);
      if (!task) return null;
      const reconciled = await reconcile(task);
      return {
        ...(task.scheduleAdmission && { admissionPending:
          !(task.scheduleAdmission.complete ??
            ((await deps.schedules.get(task.scheduleAdmission.scheduleId))?.lastExecutionId === task.scheduleAdmission.executionId || task.steps.length > 0)) }),
        generation: reconciled.generation,

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

    browserCapabilities: () => deps.browser.capabilities(),
    browserSessions: (principal) => deps.browser.list(principal.ownerId),
    browserSession: (principal, sessionId) =>
      deps.browser.get(principal.ownerId, sessionId),
    createBrowserSession: (principal, request) =>
      deps.browser.create(principal.ownerId, request),
    browserAction: (principal, sessionId, action) =>
      deps.browser.act(principal.ownerId, sessionId, action),
    pauseBrowserSession: (principal, sessionId) =>
      deps.browser.pause(principal.ownerId, sessionId),
    resumeBrowserSession: (principal, sessionId) =>
      deps.browser.resume(principal.ownerId, sessionId),
    takeoverBrowserSession: (principal, sessionId, request) =>
      deps.browser.takeover(principal.ownerId, sessionId, request),
    closeBrowserSession: (principal, sessionId, request) =>
      deps.browser.close(principal.ownerId, sessionId, request),
    authorizeBrowserSession: (principal, sessionId, request) =>
      deps.browser.authorize(principal.ownerId, sessionId, request),
    decideBrowserAuthorization: (principal, sessionId, request) =>
      deps.browser.decide(principal.ownerId, sessionId, request),
    browserReceipts: (principal, sessionId) =>
      deps.browser.receipts(principal.ownerId, sessionId),
    browserArtifact: (principal, artifactId) =>
      deps.browser.artifact(principal.ownerId, artifactId),

    submitWork: trackAdmission<[Principal, WorkSubmitRequest], TaskAccepted>(
      (principal, request) => acceptTask(principal, request),
    ),


    task: async (principal, taskId) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const task = await reconcile(found.value);
      if (task.state === 'awaiting_approval') {
        const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
        // A durable suspension is ready to expose only after its run no longer
        // holds the lease. An owner who sees it can immediately claim a resume.
        if (lease?.live && lease.token === task.runToken) {
          return ok(toStatus({
            ...task,
            state: 'running',
            failure: null,
            leaseExpiresAt: lease.expiresAt.toISOString(),
          }));
        }
      }
      const status = toStatus(task);
      // Result artifacts are read from the artifact service rather than copied
      // into the fenced task row. The task remains the authority on state; the
      // artifact store is the authority on files, and a download can be made
      // from exactly the descriptors reported here.
      const listed = await deps.artifactService.list(principal, {
        mode: task.mode,
        taskId: task.taskId,
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

      // Once suspended, the task can be cancelled even without a live lease.
      if (task.state === 'awaiting_approval') return cancelSuspended(task);

      const outcome = await deps.lease.cancel({
        key: workRunKey(scopeOf(task)),
        now: deps.clock.now(),
      });
      if (outcome === 'none') {
        const current = await deps.tasks.get(taskId);
        if (current?.runToken === task.runToken && current?.state === 'awaiting_approval') {
          return cancelSuspended(current);
        }
        return fail('not_found', 'No live run exists for that task.');
      }

      if (outcome === 'requested') {
        const applied = await deps.tasks.updateFenced({
          taskId: task.taskId,
          token: task.runToken ?? '',
          guard: 'not_awaiting_approval',
          patch: { cancelRequested: true, updatedAt: deps.clock.iso() },
        });
        if (!applied.applied && applied.reason === 'guard_rejected') return cancelSuspended(task);
        if (!applied.applied) return lostCancellation(task);
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
        guard: 'not_awaiting_approval',
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
      if (!applied.applied && applied.reason === 'guard_rejected') return cancelSuspended(task);
      if (!applied.applied) return lostCancellation(task);
      await publish(applied.task, 'task.interrupted', {
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

    resumeTask: trackAdmission<[Principal, string, number], TaskControlResult>(async (principal, taskId, generation) => {
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
      if (!(await canRunScheduled(task))) {
        return fail('conflict', 'Scheduled Work was not admitted or its schedule was cancelled.');
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
        // A concurrent cancel may land between the read above and this write.
        // Only the two suspending states may be revived; a cancelled task stays
        // cancelled.
        from: ['interrupted', 'awaiting_approval'],
      });
      if (!applied.applied) {
        await releaseLease(task, token);
        return fail('conflict', 'That task cannot be resumed.');
      }
      await publish(applied.task, 'task.queued', {});
      await publish(applied.task, 'text.replace', { text: '' });
      if (!deps.scheduler.enqueue(() => execute(taskId, token))) {
        return rejectUnscheduledRun(applied.task, token);
      }
      return ok({
        taskId,
        state: 'queued',
        generation: applied.task.generation,
        outcome: 'accepted',
      });
    }),

    retryTask: trackAdmission<[Principal, string, number], TaskControlResult>(async (principal, taskId, generation) => {
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
      if (!(await canRunScheduled(task))) {
        return fail('conflict', 'Scheduled Work was not admitted or its schedule was cancelled.');
      }
      const token = deps.ids.runToken();
      const now = deps.clock.now();
      if (task.failure?.code === 'budget_exhausted') {
        return fail('budget_exhausted', 'This task was refused before admission; submit a new request.');
      }
      const reservation = deps.budget.reserve(principal.ownerId, now);
      if (!reservation.allowed) return fail('budget_exhausted', 'The daily request budget is exhausted.');
      let accepted = false;
      try {
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
          from: ['failed', 'interrupted'],
        });
        if (!applied.applied) {
          await releaseLease(task, token);
          return fail('conflict', 'That task cannot be retried.');
        }
        await publish(applied.task, 'task.queued', {});
        await publish(applied.task, 'text.replace', { text: '' });
        if (!deps.scheduler.enqueue(() => execute(taskId, token))) {
          return rejectUnscheduledRun(applied.task, token);
        }
        accepted = true;
        return ok({
          taskId,
          state: 'queued',
          generation: applied.task.generation,
          outcome: 'accepted',
        });
      } finally {
        if (!accepted) reservation.release();
      }
    }),

    chat: trackAdmission<[Principal, ChatRequest], ChatReply>(async (principal, request) => {
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
            workload: 'work',
            game: null,
            objective: request.message,
            history,
            model: model.value.ref,
            mode: request.mode,
            workspaceRoot: workspace.value.root,
            maxSteps: 1,
            budget: null,
            signal: controller.signal,
            reasoning: 'fast',
            completedSteps: [],
            plan: null,
          },
          () => undefined,
        );
      } finally {
        await removeRunWorkspaceIfEmpty(workspace.value.root);
      }
      if (!outcome.ok) {
        return fail(
          outcome.code === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          redactText(outcome.detail, [], 1000),
          outcome.retryable,
        );
      }
      deps.budget.consume(principal.ownerId, outcome.usage ?? {}, deps.clock.now());
      // Chat output is adapter text too: scrub it before storage and before it is
      // returned, so a provider echoing a credential cannot persist it.
      const reply = redactContent(outcome.summary);
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
    }),

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

    notifications: async (principal, includeSchedules = true) => {
      if (!includeSchedules) return deps.notifications.list(principal.ownerId);
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

    markNotificationsRead: async (principal, includeSchedules = true) => {
      const work = await deps.notifications.list(principal.ownerId);
      for (const notification of work.notifications) {
        if (!notification.read) {
          await deps.notifications.markRead(principal.ownerId, notification.taskId);
        }
      }
      if (includeSchedules) await deps.scheduleNotices.markAllRead(principal.ownerId);
      return service.notifications(principal, includeSchedules);
    },

    artifacts: deps.artifactService,

    generateArtifact: (principal, request) =>
      deps.artifactGenerator.generate(principal, {
        projectId: request.projectId,
        request: request.deliverable,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.retentionDays !== undefined
          ? { retentionDays: request.retentionDays }
          : {}),
      }),

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      const replay = await deps.events.replay(taskId, after);
      // Tail strictly after what was replayed; a poll re-reads the log from that
      // cursor, so an event that lands between the read and the subscription is
      // picked up instead of falling into the gap a listener-only bus had.
      const cursor = replay.events.at(-1)?.seq ?? after;
      return ok({
        replay,
        subscribe: (listener) => deps.events.subscribe(taskId, cursor, listener),
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

    gameCapabilities: () => {
      const modelReady = deps.models
        .list()
        .models.some((model) => model.availability.available);
      return createGameCapabilityReport({
        now: deps.clock.iso(),
        studioEnabled: deps.config.games.enabled,
        agentEnabled: deps.config.games.enabled && deps.config.games.agentEnabled,
        sandboxReady: deps.config.games.enabled,
        modelAssisted: modelReady && deps.studio.modelAssisted,
        studioMessage: deps.config.games.enabled
          ? 'Builds are generated and verified in the cloud engine; no owner device runs a game or a model.'
          : 'Native Game Studio is disabled in this deployment.',
        agentMessage:
          deps.config.games.enabled && deps.config.games.agentEnabled
            ? `Sessions run in the engine's isolated runtime with a ${deps.config.games.maxSessionTicks} tick ceiling; nothing executes on the owner device.`
            : 'Native Gaming Agent is disabled in this deployment.',
      });
    },

    listGames: async (principal, query) =>
      deps.studio.list(principal.ownerId, {
        limit: query.limit ?? 20,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),

    createGame: async (principal, request) => {
      if (!deps.config.games.enabled) {
        return fail('engine_not_configured', 'Native Game Studio is disabled in this deployment.');
      }
      return deps.studio.create(principal.ownerId, request);
    },

    getGame: async (principal, gameId) => deps.studio.get(principal.ownerId, gameId),

    saveGameSpec: async (principal, gameId, request) =>
      deps.studio.saveSpec({
        ownerId: principal.ownerId,
        gameId,
        spec: request.spec,
        expectedRevision: request.expectedRevision,
      }),
    buildGame: async (principal, gameId, request) => {
      if (!deps.config.games.enabled) {
        return fail('engine_not_configured', 'Native Game Studio is disabled in this deployment.');
      }
      return deps.studio.build({
        ownerId: principal.ownerId,
        gameId,
        ...(request.expectedSpecRevision !== undefined
          ? { expectedSpecRevision: request.expectedSpecRevision }
          : {}),
      });
    },

    listGameBuilds: async (principal, gameId) =>
      deps.studio.listBuilds(principal.ownerId, gameId),

    restoreGameBuild: async (principal, gameId, buildId, request) => {
      if (!deps.config.games.enabled) {
        return fail('engine_not_configured', 'Native Game Studio is disabled in this deployment.');
      }
      return deps.studio.restore({
        ownerId: principal.ownerId,
        gameId,
        buildId,
        expectedRevision: request.expectedRevision,
      });
    },

    iterateGame: async (principal, gameId, request) =>
      deps.studio.iterate({
        ownerId: principal.ownerId,
        gameId,
        instruction: request.instruction,
        expectedRevision: request.expectedRevision,
      }),

    gamePreview: async (principal, gameId) => deps.studio.preview(principal.ownerId, gameId),

    exportGame: async (principal, gameId) => deps.studio.export(principal.ownerId, gameId),

    createGameSession: async (principal, gameId, request) => {
      if (!deps.config.games.enabled || !deps.config.games.agentEnabled) {
        return fail('engine_not_configured', 'Native Gaming Agent is disabled in this deployment.');
      }
      if (request.maxTicks > deps.config.games.maxSessionTicks) {
        return fail(
          'validation_failed',
          `The tick budget exceeds this deployment's ceiling of ${deps.config.games.maxSessionTicks}.`,
        );
      }
      const project = await deps.studio.get(principal.ownerId, gameId);
      if (!project.ok) return project;
      if (!project.value.spec || !project.value.build) {
        return fail('conflict', 'Build and verify this game before starting a session.');
      }
      const buildId = request.buildId ?? project.value.build.buildId;
      const loaded = await deps.studio.readVerifiedBuild({
        ownerId: principal.ownerId,
        gameId,
        buildId,
      });
      if (!loaded.ok) return loaded;
      const created = await deps.sessions.create({
        ownerId: principal.ownerId,
        project: { gameId, spec: project.value.spec },
        build: loaded.value.build,
        request,
      });
      if (!created.ok) return created;
      const session = created.value;
      const admitted = await admitTask({
        principal,
        agentId: 'coderax',
        objective: `Play ${project.value.name}: ${request.objective.kind}`,
        mode: 'cloud',
        model: null,
        budget: null,
        requireApproval: false,
        kind: 'game',
        game: {
          sessionId: session.sessionId,
          gameId,
          buildId,
          objective: request.objective,
          allowedActions: request.allowedActions,
          maxTicks: request.maxTicks,
        },
      });
      if (!admitted.ok) {
        await deps.sessions.fail(session.sessionId, admitted.code, admitted.detail);
        return admitted;
      }
      const grant = await deps.permissions.request({
        ownerId: principal.ownerId,
        taskId: admitted.value.task.taskId,
        agent: 'coderax',
        scope: 'command.execute',
        description: `Bounded control of game session ${session.sessionId}.`,
        resource: `game-session:${session.sessionId}`,
        ttlMs: 60 * 60_000,
      });
      const decided = await deps.permissions.decide({
        ownerId: principal.ownerId,
        taskId: admitted.value.task.taskId,
        requestId: grant.requestId,
        decision: 'approved',
        reason: 'Owner authorized the session when creating it.',
      });
      if (!decided.ok) {
        await deps.sessions.fail(session.sessionId, decided.code, decided.detail);
        return decided;
      }
      await deps.sessions.attachTask(session.sessionId, admitted.value.task.taskId, 1);
      deps.scheduler.enqueue(() => execute(admitted.value.task.taskId, admitted.value.token));
      return deps.sessions.get(principal.ownerId, session.sessionId);
    },

    listGameSessions: async (principal) => deps.sessions.list(principal.ownerId),

    getGameSession: async (principal, sessionId) => {
      const found = await deps.sessions.get(principal.ownerId, sessionId);
      if (!found.ok) return found;
      const taskId = found.value.taskId;
      if (!taskId) return found;
      const task = await deps.tasks.get(taskId);
      return ok({ ...found.value, generation: task?.generation ?? found.value.generation });
    },

    observeGameSession: async (principal, sessionId) =>
      deps.sessions.observation(principal.ownerId, sessionId),

    controlGameSession: async (principal, sessionId, request) => {
      const controlled = await deps.sessions.control({
        ownerId: principal.ownerId,
        sessionId,
        request,
      });
      if (!controlled.ok) return controlled;
      const taskId = controlled.value.taskId;
      if (request.action === 'cancel' && taskId) {
        await service
          .cancelTask(principal, taskId, request.reason)
          .catch(() => undefined);
      }
      return controlled;
    },

    gameSessionLogs: async (principal, sessionId) =>
      deps.sessions.logs(principal.ownerId, sessionId),

    gameSessionVerification: async (principal, sessionId) =>
      deps.sessions.verification(principal.ownerId, sessionId),
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
          timingRevision: record.version + 1,
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
          timingRevision: record.version + 1,
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
      const alreadyCancelled = record.state === 'cancelled';

      const now = deps.clock.iso();
      const applied = alreadyCancelled ? { applied: true, schedule: record } : await deps.schedules.update({
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
        if (latest.state === 'cancelled') return service.cancelSchedule(principal, scheduleId);
        return fail('conflict', 'The schedule changed while it was being cancelled; retry.');
      }
      const cancelled = applied.schedule ?? record;

      // A live run is stopped through the durable lease, not by writing its task
      // record here: only the generation that holds the token may settle it.
      const executions = await deps.schedules.listPending(scheduleId);
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
      return ok(control(cancelled, alreadyCancelled ? 'already_terminal' : 'accepted'));
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
          ...(timingChanged || enabledChanged ? { timingRevision: record.version + 1 } : {}),
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

    beginShutdown: () => {
      shuttingDown = true;
      deps.scheduler.stop();
    },

    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      deps.scheduler.stop();
      shutdownPromise = (async () => {
        await scheduleEngine.stop();
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        // Wait for the runner's grace bound to turn every aborted run into a
        // settled outcome, then revoke whatever is still registered. The second
        // step is the verified part: no capability survives shutdown.
        await Promise.race([
          Promise.all([deps.scheduler.idle(), Promise.allSettled(admissions)]),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.config.execution.cancelGraceMs + 1_000);
            timer.unref();
          }),
        ]);
        await deps.supervisor.shutdown();
        // Release cloud browsers rather than letting them run until their TTL.
        await deps.browser.shutdown();
      })();
      return shutdownPromise;
    },
  };

  return service;
}
