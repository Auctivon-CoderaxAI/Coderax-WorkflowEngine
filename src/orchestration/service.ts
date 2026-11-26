import type {
  AgentId,
  AgentList,
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
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { GameRunSpec, TaskRecord } from '../domain.js';
import type { GameStudio } from '../games/studio.js';
import type { GameSessionService, GamingAgent } from '../games/session.js';
import { createGameCapabilityReport } from '../games/capability.js';
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
  scheduler: TaskScheduler;
  health: HealthService;
  studio: GameStudio;
  sessions: GameSessionService;
  gaming: GamingAgent;
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

  /**
   * The gaming workload is a Native capability, not a fourth agent identity. It
   * borrows the supervisor's lease, fencing, cancellation and event path through
   * the same adapter port; only the run body differs.
   */
  function gamingAdapter(task: TaskRecord): AgentAdapter {
    return {
      agent: task.agent,
      engine: 'native',
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
        ...(modelRef ? { model: modelRef } : {}),
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

  type AdmitInput = {
    principal: Principal;
    agentId: AgentId;
    objective: string;
    mode: DataMode;
    model: ModelRef | null;
    budget: TaskRecord['budget'];
    requireApproval: boolean;
    conversationId?: string;
    kind: 'work' | 'game';
    game: GameRunSpec | null;
  };

  /**
   * The single admission path for both workloads.
   *
   * It resolves the engine and model, reserves budget only for model-backed work,
   * claims the conversation lease, creates the fenced task, publishes the queued
   * event and writes the audit receipt. It deliberately does not enqueue: the game
   * caller must create and approve the session grant first, so the run can never
   * start ahead of the authority it needs.
   */
  async function admitTask(
    input: AdmitInput,
  ): Promise<ServiceResult<{ task: TaskRecord; token: string; conversationId: string }>> {
    let engine: TaskRecord['engine'] = 'native';
    if (input.kind === 'work') {
      const adapter = deps.agents.resolve(input.agentId);
      if (!adapter.ok) return adapter;
      engine = adapter.value.engine;
    } else if (input.agentId !== 'coderax') {
      return fail('forbidden', 'A game session is a Coderax Native capability.');
    }

    let model: ModelRef | null = null;
    if (input.kind === 'work') {
      const resolved = deps.models.resolve(input.model, input.mode);
      if (!resolved.ok) return resolved;
      model = resolved.value.ref;
      const reservation = deps.budget.reserve(input.principal.ownerId, deps.clock.now());
      if (!reservation.allowed) {
        return fail(
          'budget_exhausted',
          'The daily zero-cost request budget is exhausted; the task was refused rather than queued on a paid path.',
        );
      }
    }

    const now = deps.clock.iso();
    const conversationId = input.conversationId ?? deps.ids.conversationId();
    await deps.conversations.ensure({
      conversationId,
      ownerId: input.principal.ownerId,
      tenantId: null,
      title: input.objective.slice(0, 120),
      mode: input.mode,
      isWork: true,
      agent: input.agentId,
      createdAt: now,
      updatedAt: now,
    });
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
      engine,
      mode: input.mode,
      kind: input.kind,
      game: input.game,
      objective: input.objective,
      model,
      state: 'queued',
      generation: 1,
      runToken: null,
      steps: [],
      checkpoint: { completedSteps: [], text: '' },
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: null,
      cancelRequested: false,
      requireApproval: input.requireApproval,
      budget: input.budget,
      usage: null,
      result: null,
      failure: null,
    };

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
      actor: input.principal.ownerId,
      action: input.kind === 'game' ? 'game.session.accepted' : 'work.accepted',
      taskId: task.taskId,
      conversationId,
      outcome: 'accepted',
      detail: `agent=${input.agentId} kind=${input.kind} model=${model ? modelKey(model) : 'none'}`,
    });

    return ok({ task: created.task, token, conversationId });
  }

  const service: ApplicationService = {
    health: () => deps.health.report(),
    readiness: () => deps.health.readiness(),
    agents: () => deps.agents.list(),
    models: () => deps.models.list(),

    submitWork: async (principal, request) => {
      const admitted = await admitTask({
        principal,
        agentId: request.agent ?? deps.agents.defaultAgent,
        objective: request.objective,
        mode: request.mode,
        model: request.model ?? null,
        budget: request.budget ?? null,
        requireApproval: request.requireApproval,
        kind: 'work',
        game: null,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      });
      if (!admitted.ok) return admitted;
      deps.scheduler.enqueue(() => execute(admitted.value.task.taskId, admitted.value.token));
      return ok({
        taskId: admitted.value.task.taskId,
        conversationId: admitted.value.conversationId,
        state: 'queued',
        generation: 1,
        eventsPath: `/v1/work/${admitted.value.task.taskId}/events`,
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

    gameCapabilities: () => {
      const modelReady = deps.models
        .list()
        .models.some((model) => model.availability.available);
      return createGameCapabilityReport({
        now: deps.clock.iso(),
        studioEnabled: deps.config.games.enabled,
        agentEnabled: deps.config.games.enabled && deps.config.games.agentEnabled,
        sandboxReady: deps.config.games.enabled,
        modelAssisted: modelReady,
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
