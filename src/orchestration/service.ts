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
  BudgetState,
  BuildGameRequest,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  CreateGameRequest,
  CreateGameSessionRequest,
  DataMode,
  Deliverable,
  DeliverableRequestInput,
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
  KnowledgeIngestRequest,
  KnowledgeIngestResult,
  KnowledgeList,
  KnowledgeSearchResult,
  RoutingMode,
  RoutingReport,
  ToolList,
  PermissionScope,
} from '@coderax/contracts';
import {
  DeliverableRequest,
  isTerminalExecution,
  isTerminalState,
  modelKey,
} from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { ConversationRecord, TaskApproval, TaskPatch, TaskRecord } from '../domain.js';
import type { TaskRepository } from '../persistence/tasks.js';
import { ConversationConflictError, type ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { ScheduleNoticeStore, ScheduleRepository } from '../persistence/schedules.js';
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
import type { ModelRouter } from '../models/router.js';
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
import { createScheduleEngine } from '../scheduling/engine.js';
import type { SchedulePort, ScheduleTickReport } from '../scheduling/engine.js';
import { nextOccurrence, previewOccurrences } from '../scheduling/calendar.js';
import { scheduleSideEffectRefusal } from '../scheduling/policy.js';
import type { AuthService, Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { resolveConversationWorkspace, workspaceRoots } from '../execution/workspace.js';
import { buildTranscript } from './transcript.js';
import type { ArtifactService } from '../artifacts/service.js';
import type { DeliverableService } from '../artifacts/deliver.js';
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
  externalPolicy: (engine: Exclude<AgentAdapter['engine'], 'native'>, mode: DataMode) => PolicyDecision;
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  permissions: PermissionStore;
  notifications: NotificationStore;
  artifactService: ArtifactService;
  deliverables: DeliverableService;
  schedules: ScheduleRepository;
  scheduleNotices: ScheduleNoticeStore;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  supervisor: ExecutionSupervisor;
  scheduler: TaskScheduler;
  health: HealthService;
  quarantine: QuarantineRegistry;
  tools: ToolRuntime;
  knowledge: KnowledgeStore;
  modelRouter: ModelRouter;
};

/**
 * A Work objective may declare one deliverable in a fenced block. The directive is
 * data: it is parsed against the published contract and produced by the same use
 * case the API uses, so a headless or scheduled run stores files exactly as an
 * explicit request does.
 */
export type DeliverableDirective =
  | { present: false }
  | { present: true; value: unknown; error?: string };

export function readDeliverableDirective(objective: string): DeliverableDirective {
  const match = /```deliverable\s*\n([\s\S]*?)^```/m.exec(objective);
  if (!match) return { present: false };
  try {
    return { present: true, value: JSON.parse(match[1] ?? '') as unknown };
  } catch {
    return { present: true, value: null, error: 'The deliverable directive is not valid JSON.' };
  }
}

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
  notifications: (principal: Principal, includeSchedules?: boolean) => Promise<NotificationList>;
  /** Durable artifact storage; the only path that returns artifact bytes. */
  artifacts: ArtifactService;
  /**
   * Generate, verify and durably persist a deliverable. The files it returns are
   * artifact descriptors owned by `artifacts`, not paths in a workspace.
   */
  deliver: (
    principal: Principal,
    request: DeliverableRequestInput,
    options?: { conversationId?: string; taskId?: string; signal?: AbortSignal },
  ) => Promise<ServiceResult<Deliverable>>;
  events: (
    principal: Principal,
    taskId: string,
    after: number,
  ) => Promise<ServiceResult<EventStream>>;
  budget: (principal: Principal) => Promise<BudgetState>;
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

  function checkExternal(engine: AgentAdapter['engine'], mode: DataMode): ServiceResult<void> {
    if (engine === 'native') return ok(undefined);
    const decision = deps.externalPolicy(engine, mode);
    return decision.allowed ? ok(undefined) : fail('model_missing', decision.detail);
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

  /**
   * A task's status lists the artifacts stored against it, so a client finds the
   * files it asked for through the task instead of scanning the whole catalogue.
   * The listing is bounded like every other listing.
   */
  async function statusWithArtifacts(principal: Principal, task: TaskRecord): Promise<TaskStatus> {
    const status = toStatus(task);
    const listed = await deps.artifactService.list(principal, {
      mode: task.mode,
      taskId: task.taskId,
      limit: 500,
    });
    if (listed.ok && status.result && task.kind !== 'game') {
      status.result = {
        ...(status.result ?? { artifacts: [] }),
        artifacts: listed.value.artifacts.map((artifact) => ({
          path: artifact.relativePath ?? artifact.filename,
          bytes: artifact.bytes,
          digest: artifact.sha256,
        })),
      };
    }
    return status;
  }

  /**
   * Produces the deliverable a Work objective declared, if any. A malformed or
   * mismatched directive produces nothing rather than substituting a different
   * deliverable, and a refused generation leaves the run's own result intact.
   */
  async function produceDeliverable(task: TaskRecord, signal: AbortSignal, authorizePersistence: () => Promise<boolean>): Promise<void> {
    const directive = readDeliverableDirective(task.objective);
    if (!directive.present || directive.error) return;
    const parsed = DeliverableRequest.safeParse(directive.value);
    if (!parsed.success || parsed.data.mode !== task.mode) return;
    await deps.deliverables.deliver(
      { ownerId: task.ownerId, isOwner: true },
      parsed.data,
      {
        conversationId: task.conversationId,
        taskId: task.taskId,
        signal,
        authorizePersistence,
      },
    );
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

  /**
   * A conversation may only be reused for the same owner, data mode and kind of
   * work. The repository is the authority; this maps its refusal onto a stable
   * problem and never confirms whether a foreign id exists.
   */
  async function ensureConversation(
    record: ConversationRecord,
  ): Promise<ServiceResult<ConversationRecord>> {
    try {
      return ok(await deps.conversations.ensure(record));
    } catch (error) {
      if (error instanceof ConversationConflictError) {
        return error.reason === 'owner'
          ? fail('not_found', 'That conversation does not exist for this owner.')
          : fail(
              'conflict',
              `That conversation belongs to a different ${error.reason === 'mode' ? 'data mode' : 'kind of work'}.`,
            );
      }
      throw error;
    }
  }

  /** The supervisor's hold and the abandoned-run quarantine are the only workspace authority. */
  function quarantineDetail(root: string): string | null {
    const held = deps.supervisor.held(root);
    if (held) {
      return `A previous execution could not be verified as terminated: ${held}`;
    }
    const entry = deps.quarantine.check(root, deps.clock.now().getTime());
    return entry
      ? `${entry.reason} The workspace is refused until the quarantine expires.`
      : null;
  }

  const APPROVAL_SCOPE = 'command.execute' as const;

  /** The one grant this task may hold, if it is still usable. */
  function executionGrant(task: TaskRecord): TaskApproval | null {
    const approval = task.approval;
    if (!approval || approval.decision !== 'approved' || approval.consumedAt) return null;
    if (approval.scope !== APPROVAL_SCOPE || approval.resource !== task.taskId) return null;
    return approval;
  }

  /**
   * Park a run until the owner decides. The task stays non-terminal and its lease
   * is released, so the conversation is not held by a run that is waiting, and a
   * resume claims a new generation after the decision.
   */
  async function suspendForApproval(task: TaskRecord, token: string): Promise<void> {
    const existing = await deps.permissions.list(task.ownerId, task.taskId);
    const pending = existing.requests.find(
      (entry) =>
        entry.decision === 'pending' &&
        entry.scope === APPROVAL_SCOPE &&
        entry.resource === task.taskId,
    );
    const request =
      pending ??
      (await deps.permissions.request({
        ownerId: task.ownerId,
        taskId: task.taskId,
        agent: task.agent,
        scope: APPROVAL_SCOPE,
        resource: task.taskId,
        description: `Run the ${task.agent} agent on this task.`,
      }));

    const applied = await deps.tasks.updateFenced({
      taskId: task.taskId,
      token,
      patch: {
        state: 'awaiting_approval',
        updatedAt: deps.clock.iso(),
        failure: {
          code: 'approval_required',
          detail: 'Owner approval is required before this agent may run.',
          retryable: true,
        },
      },
    });
    if (applied.applied) {
      publish(applied.task, 'approval.required', {
        requestId: request.requestId,
        tool: task.agent,
        description: `Run the ${task.agent} agent on this task.`,
      });
      deps.audit.record({
        actor: task.ownerId,
        action: 'work.awaiting_approval',
        taskId: task.taskId,
        conversationId: task.conversationId,
        outcome: 'accepted',
        detail: APPROVAL_SCOPE,
      });
    }
    await deps.events.flush(task.taskId).catch(() => undefined);
    await releaseLease(task, token);
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
      // Provider and adapter text reaches the notification store, so it is
      // scrubbed here as well as on the event stream.
      ...(summary ? { summary: redactText(summary, [], 500) } : {}),
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
    signal?: AbortSignal,
    lostOwnership?: () => boolean,
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
              artifacts: task.kind === 'game' ? (outcome.artifacts ?? []) : [],
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
            ...(outcome.model ? { model: outcome.model } : {}),
          }
        : outcome.kind === 'cancelled'
          ? { state: 'cancelled' as const, updatedAt: now }
          : {
              state: 'failed' as const,
              updatedAt: now,
              failure: {
                code: outcome.code,
                // Persisted, so it must already be scrubbed: a reader of the row
                // is not guaranteed to pass through `toStatus`.
                detail: redactText(outcome.detail, [], 1000),
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
    const commit = () => deps.tasks.updateFenced({
      taskId: task.taskId,
      token,
      patch: statePatch,
      ...(outcome.kind === 'completed' ? { guard: 'not_cancel_requested' as const } : {}),
    });
    let decision: ReturnType<typeof commit> | undefined;
    if (outcome.kind === 'completed' && signal) {
      // Only a completed generation is immutable. Authorize publication at the
      // last boundary before storage, after generation and validation finish.
      await produceDeliverable(task, signal, async () => {
        if (lostOwnership?.() || signal.aborted) return false;
        return (await (decision ??= commit())).applied;
      }).catch(() => undefined);
      if (!decision && lostOwnership?.()) return;
      if (!decision && signal.aborted) {
        return settle(task, token, { kind: 'cancelled' }, checkpoint, steps);
      }
    }
    const applied = await (decision ?? commit());
    if (!applied.applied) {
      if (applied.reason === 'guard_rejected' && outcome.kind === 'completed') {
        await settle(task, token, { kind: 'cancelled' }, checkpoint, steps);
        return;
      }
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
          ...(settled.model ? { model: settled.model } : {}),
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
      // The prompt list dies with the task; the durable decision stays on the row.
      deps.permissions.clear(settled.taskId);
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

    const workspace = await resolveConversationWorkspace({
      mode: task.mode,
      roots: workspaceRoots(deps.config.workspaces),
      conversationId: task.conversationId,
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
    const quarantined = quarantineDetail(workspace.value.root);
    if (quarantined) {
      await settle(task, token, {
        kind: 'failed',
        code: 'workspace_denied',
        detail: quarantined,
        retryable: true,
      });
      return;
    }

    // An external agent executes actions outside this process. When the owner
    // asked to approve actions, the engine cannot mediate them, so the run needs
    // an explicit, durable, single-use grant. Coderax Native acts only through
    // the engine's own tool runtime, so it is not gated here.
    if (task.requireApproval && task.agent !== 'coderax' && adapter.value.capabilities.tools) {
      const grant = executionGrant(task);
      const consumed = grant
        ? await deps.tasks.consumeApproval({
            taskId,
            requestId: grant.requestId,
            now: deps.clock.iso(),
          })
        : false;
      if (!consumed) {
        await suspendForApproval(task, token);
        return;
      }
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

    // Hand the transcript only to an agent whose isolation grants conversations.
    // An external agent's descriptor says `conversations: none`.
    // An agent whose isolation says `conversations: none` receives no history
    // field at all, not an empty array that suggests a transcript exists.
    const history =
      adapter.value.isolation.conversations === 'granted'
        ? await historyFor(task.conversationId, task.objective)
        : undefined;
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

    // External engines bypass the router, so their request slot is reserved
    // here. Native is charged by the router's own reservation.
    const externalReservation =
      started.task.engine === 'native'
        ? null
        : await deps.budget.reserve({
            ownerId: task.ownerId,
            at: deps.clock.now(),
            inputTokens: estimateTokens([task.objective]),
            outputTokens: task.budget?.maxOutputTokens ?? 1_024,
          });
    if (externalReservation !== null && !externalReservation.allowed) {
      if (executionsByTask.get(taskId) === identity.executionId) {
        executionsByTask.delete(taskId);
      }
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
            ...(history === undefined ? {} : { history }),
            model: model.value.ref,
            routing,
            allowFallback: !pinned,
            mode: task.mode,
            operation: 'work',
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
                      taskId,
                      token,
                      patch: {
                        pendingAction: pendingAction?.observations
                          ? { ...pendingAction, observations: pendingAction.observations.map(redactContent) }
                          : pendingAction,
                      },
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
          admitDispatch: () => {
            // Recheck provider authorization at the exact dispatch boundary: a
            // grant or policy that changed while the run was queued must not
            // send the request.
            dispatched = !execution.signal.aborted &&
              checkExternal(adapter.value.engine, task.mode).ok;
            return dispatched;
          },
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
    // Budget ownership is independent of task-ownership fences; release the
    // reservation before any guard that can return early.
    if (held) {
      if (dispatched) {
        // A dispatched attempt keeps its request charge even when it failed;
        // a completed call is settled with the usage the provider reported.
        const usage =
          supervised.admitted && supervised.outcome.kind === 'completed'
            ? supervised.outcome.usage ?? {}
            : {};
        await deps.budget.settle(held.id, usage);
      } else {
        await deps.budget.release(held.id);
      }
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
    // The run's own durable reports must land before settlement, and the final
    // checkpoint carries the step outputs the newer resume path depends on.
    await reports;
    await settle(started.task, token, outcome, { completedSteps: completed, text: safeText, outputs });
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
    const last = deps.events.lastSeq(task.taskId);
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

      if (!await deps.budget.available(principal.ownerId, deps.clock.now())) {
        return fail(
          'budget_exhausted',
          'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
        );
      }

      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      const ensured = await ensureConversation({
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
      if (!ensured.ok) return ensured;

      const workspace = await resolveConversationWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
        conversationId,
      });
      if (!workspace.ok) return workspace;
      const quarantined = quarantineDetail(workspace.value.root);
      if (quarantined) return fail('workspace_denied', quarantined);
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
        approval: null,
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

      await deps.events.hydrate(task.taskId).catch(() => 0);
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
      const task = await reconcile(found.value);
      if (task.state === 'completed' && readDeliverableDirective(task.objective).present) {
        const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
        if (lease?.live && lease.token === task.runToken) {
          return ok(toStatus({ ...task, state: 'running', result: null, leaseExpiresAt: lease.expiresAt.toISOString() }));
        }
      }
      if (task.state === 'awaiting_approval') {
        const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
        // A durable suspension is ready to expose only after its run no longer
        // holds the lease. An owner who sees it can immediately claim a resume.
        if (lease?.live && lease.token === task.runToken) {
          return ok(await statusWithArtifacts(principal, {
            ...task,
            state: 'running',
            failure: null,
            leaseExpiresAt: lease.expiresAt.toISOString(),
          }));
        }
      }
      return ok(await statusWithArtifacts(principal, task));
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
        // A suspended run holds no lease, so there is nothing to signal. The
        // owner's cancel still retires it under the same fence a live run uses.
        const applied = await deps.tasks.updateFenced({
          taskId: task.taskId,
          token: task.runToken ?? '',
          patch: {
            state: 'cancelled',
            updatedAt: deps.clock.iso(),
            cancelRequested: true,
          },
        });
        if (!applied.applied) {
          return fail('conflict', 'That task changed before it could be cancelled.');
        }
        publish(applied.task, 'task.cancelled', {});
        await deps.events.flush(applied.task.taskId).catch(() => undefined);
        await notifyTerminal(applied.task, 'cancelled');
        deps.permissions.clear(applied.task.taskId);
        return ok({
          taskId: task.taskId,
          state: 'cancelled',
          generation: task.generation,
          outcome: 'accepted',
        });
      }

      if (outcome === 'requested') {
        const applied = await deps.tasks.updateFenced({
          taskId: task.taskId,
          token: task.runToken ?? '',
          guard: 'not_awaiting_approval',
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
        expected: { state: task.state, generation },
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
      publish(applied.task, 'task.queued', {});
      publish(applied.task, 'text.replace', { text: '' });
      deps.scheduler.enqueue(() => execute(taskId, token));
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

    chat: trackAdmission<[Principal, ChatRequest], ChatReply>(async (principal, request) => {
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

      if (!await deps.budget.available(principal.ownerId, deps.clock.now())) {
        return fail('budget_exhausted', 'The daily zero-cost request budget is exhausted.');
      }
      const now = deps.clock.iso();
      const conversationId = request.conversationId ?? deps.ids.conversationId();
      const conversation = await ensureConversation({
        conversationId,
        ownerId: principal.ownerId,
        tenantId: null,
        mode: request.mode,
        isWork: false,
        agent: request.agent,
      });
      if (!conversation.ok) return conversation;

      const workspace = await resolveConversationWorkspace({
        mode: request.mode,
        roots: workspaceRoots(deps.config.workspaces),
        conversationId,
      });
      if (!workspace.ok) return workspace;
      const quarantined = quarantineDetail(workspace.value.root);
      if (quarantined) return fail('workspace_denied', quarantined);
      await deps.conversations.appendMessage({
        messageId: deps.ids.messageId(),
        conversationId,
        role: 'user',
        text: request.message,
        createdAt: now,
      });

      // Only an agent whose isolation grants conversations may see the transcript.
      const history = adapter.value.isolation.conversations === 'granted'
        ? await historyFor(conversationId, request.message)
        : undefined;
      const identity: ExecutionIdentity = {
        executionId: deps.ids.executionId(),
        kind: 'chat',
        taskId: null,
        conversationId,
        ownerId: principal.ownerId,
        tenantId: conversation.value.tenantId,
        agent: request.agent,
        mode: request.mode,
        generation: 0,
        token: null,
      };
      let dispatched = false;
      // The router reserves internally. An external engine does not pass through
      // it, so hold one request/token slot before dispatch and settle afterward.
      const reservation =
        adapter.value.engine === 'native'
          ? null
          : await deps.budget.reserve({
              ownerId: principal.ownerId,
              at: deps.clock.now(),
              inputTokens: estimateTokens([request.message]),
              outputTokens: 1_024,
            });
      if (reservation !== null && !reservation.allowed) {
        return fail('budget_exhausted', 'The daily zero-cost request budget is exhausted.');
      }
      const held = reservation?.allowed ? reservation.reservation : null;

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
              tenantId: conversation.value.tenantId,
              conversationId,
              objective: request.message,
              ...(history === undefined ? {} : { history }),
              model: model.value.ref,
              routing,
              allowFallback: request.model === undefined,
              mode: request.mode,
              operation: 'chat',
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
            () => {
              dispatched = !execution.signal.aborted &&
                checkExternal(adapter.value.engine, request.mode).ok;
              return dispatched;
            },
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
        if (held) {
          // A dispatched external call may already have been billed even when it
          // failed, so its reserved tokens stay charged; an undispatched one is
          // refunded in full.
          if (dispatched) await deps.budget.settle(held.id, {});
          else await deps.budget.release(held.id);
        }
        return fail('engine_unavailable', supervised.detail, supervised.code !== 'workspace_denied');
      }
      const outcome = supervised.outcome;
      if (outcome.kind !== 'completed') {
        if (held) {
          if (dispatched) await deps.budget.settle(held.id, {});
          else await deps.budget.release(held.id);
        }
        return fail(
          outcome.kind === 'cancelled' ? 'cancelled' : 'engine_unavailable',
          redactText(
            outcome.kind === 'cancelled'
              ? 'The chat turn was cancelled.'
              : outcome.kind === 'failed'
                ? outcome.detail
                : outcome.kind === 'suspended'
                  ? outcome.detail
                  : 'The chat turn lost execution authority.',
            [],
            1000,
          ),
          outcome.kind === 'failed' ? outcome.retryable : false,
        );
      }
      const summary = redactContent(outcome.summary);
      const usedModel = outcome.model ?? model.value.ref;
      if (held) await deps.budget.settle(held.id, outcome.usage ?? {});
      const messageId = deps.ids.messageId();
      await deps.conversations.appendMessage({
        messageId,
        conversationId,
        role: 'assistant',
        text: summary,
        createdAt: deps.clock.iso(),
        agent: request.agent,
      });
      return ok({
        conversationId,
        messageId,
        text: summary,
        agent: request.agent,
        model: usedModel,
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
      if (isTerminalState(found.value.state)) {
        return fail('conflict', 'That task is already settled; its permissions cannot change.');
      }
      const decided = await deps.permissions.decide({
        ownerId: principal.ownerId,
        taskId,
        requestId: body.requestId,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      if (!decided.ok) return decided;
      const request = decided.value.requests.find((entry) => entry.requestId === body.requestId);
      if (!request) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      // The durable copy is what an execution consults; the in-process request is
      // only the prompt. A later request may replace an undecided or denied one,
      // and a grant is consumed before the run it authorizes.
      const recorded = await deps.tasks.recordApproval({
        taskId,
        requestId: request.requestId,
        scope: request.scope,
        resource: request.resource,
        decision: request.decision === 'approved' ? 'approved' : 'denied',
        decidedAt: request.decidedAt ?? deps.clock.iso(),
      });
      if (!recorded.applied) {
        return fail('conflict', 'That task could not record the decision.');
      }
      deps.audit.record({
        actor: principal.ownerId,
        action: `permission.${request.decision}`,
        taskId,
        conversationId: found.value.conversationId,
        outcome: 'accepted',
        detail: request.scope,
      });
      return decided;
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
    artifacts: deps.artifactService,

    deliver: (principal, request, options) => deps.deliverables.deliver(principal, request, options),

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

    budget: async (principal) => {
      const used = await deps.budget.snapshot(principal.ownerId, deps.clock.now());
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
        exhausted: !await deps.budget.available(principal.ownerId, deps.clock.now()),
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
      // Flush before the process releases the database, so a shutdown does not
      // lose the tail of a run that already reported it.
      await deps.events.close().catch(() => undefined);
    },
  };

  return service;
}
