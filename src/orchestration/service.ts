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
import { isTerminalEvent, isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineFailureCode, ExecutionEvent } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { TaskPatch, TaskRecord } from '../domain.js';
import type { EngineRunArbiter } from '../execution/arbiter.js';
import {
  canRetryWithin,
  isRetryableStartFailure,
  normalizeRetryPolicy,
  wait,
  type RetryPolicy,
} from '../execution/retry.js';
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
  /** In-process admission for one execution of one generation. */
  arbiter: EngineRunArbiter;
  health: HealthService;
};

export type EventStream = {
  generation: number;
  replay: Replay;
  subscribe: (listener: (event: unknown) => void) => Unsubscribe;
  close: () => void;
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
  /**
   * Startup recovery: retires runs whose lease is gone, repairs the derived
   * records of settled tasks, and applies bounded retention.
   */
  recoverInterrupted: () => Promise<{ interrupted: number; repaired: number }>;
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
  // Runs this process accepted, whether queued or executing. Shutdown may only
  // reclaim these: another replica's live run has its own token, and writing an
  // interrupt under that token would stop work this process does not own.
  const checkpointWrites = new Map<string, Promise<void>>();
  const localRuns = new Map<string, string>();
  /** Bounded repair window: the most recent settled tasks checked at startup. */
  const REPAIR_WINDOW = 100;
  const PRUNE_BOUND = 100;
  /**
   * True while the process is stopping. An abort during shutdown is not an owner
   * cancellation, so the run is retired as `interrupted` by the reclaim pass
   * instead of being recorded as `cancelled`.
   */
  let stopping = false;

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
   * Publishes on behalf of one generation. A superseded generation is refused by
   * the bus before it consumes a sequence, so a late report from an abandoned
   * adapter cannot create a hole in the durable stream.
   */
  function publish(
    task: TaskRecord,
    type: Parameters<EventBus['publish']>[0]['type'],
    payload?: unknown,
  ): ExecutionEvent | null {
    return deps.events.publish({
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

  /**
   * Automatic retry is the same generation and the same engine. It is allowed
   * only when the adapter proved the start never dispatched, because replaying a
   * run that already produced effects would duplicate them.
   */
  function shouldRetry(
    outcome: RunOutcome,
    attempt: number,
    policy: RetryPolicy,
  ): boolean {
    if (outcome.kind !== 'failed' || !outcome.adapterRetryableStart) return false;
    if (attempt >= policy.maxAttempts) return false;
    return isRetryableStartFailure({
      code: outcome.code,
      retryable: outcome.retryable,
      hasCleanup: false,
    });
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
      generation: task.generation,
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      agent: task.agent,
      mode: task.mode,
      state,
      // The summary can carry a provider or adapter detail, so it is scrubbed
      // here for every caller rather than only on the settlement path.
      ...(summary ? { summary: redactText(summary, [], 500) } : {}),
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
  /**
   * Completes the derived records of an already settled task.
   *
   * The task record is authoritative; the terminal event, the transcript message
   * and the notification are derived. A crash can therefore leave a completed
   * task whose stream never ended or whose blue dot was never written, and this
   * restores them from the record alone. Every write here is idempotent: the
   * message id is derived from the task and generation, the notification is an
   * upsert, and the terminal event carries a stable repair id.
   */
  async function repair(task: TaskRecord): Promise<boolean> {
    if (!isTerminalState(task.state)) return false;
    let repaired = false;
    const terminal = task.state as 'completed' | 'failed' | 'cancelled' | 'interrupted';
    const checkpoint = task.checkpoint ?? { completedSteps: [], text: '' };

    try {
      await deps.events.hydrate(task.taskId, task.generation);
      // The ending is the newest event. Inspecting the first page would miss a
      // terminal event on a stream longer than one page and append a duplicate.
      const existing = await deps.events.tail(task.taskId, 1);
      // The ending must belong to the current generation. An older generation's
      // terminal event must not suppress repair after a resume.
      if (
        !existing.some(
          (event) => isTerminalEvent(event.type) && event.generation === task.generation,
        )
      ) {
        const base = {
          taskId: task.taskId,
          agent: task.agent,
          generation: task.generation,
          at: task.updatedAt,
          eventId: `repair_${task.taskId}_g${task.generation}`,
        };
        if (task.state === 'completed') {
          deps.events.publish({
            ...base,
            type: 'task.completed',
            payload: {
              ...(task.result?.summary ? { summary: task.result.summary } : {}),
              ...(task.model ? { model: task.model } : {}),
              ...(task.usage ? { usage: task.usage } : {}),
            },
          });
        } else if (task.state === 'cancelled') {
          deps.events.publish({ ...base, type: 'task.cancelled', payload: {} });
        } else if (task.state === 'failed') {
          deps.events.publish({
            ...base,
            type: 'task.failed',
            payload: {
              code: (task.failure?.code ?? 'provider_error') as EngineFailureCode,
              // The repair path bypasses the settlement helper, so it applies
              // the same scrubbing the live path does.
              ...(task.failure?.detail
                ? { detail: redactText(task.failure.detail, [], 1000) }
                : {}),
              retryable: task.failure?.retryable === true,
            },
          });
        } else {
          deps.events.publish({
            ...base,
            type: 'task.interrupted',
            payload: { detail: 'The run stopped before it settled; the record was repaired.' },
          });
        }
        repaired = true;
      }
      await deps.events.flush(task.taskId).catch(() => undefined);
    } catch {
      // A repair that cannot reach the event log is retried by the next pass.
    }

    // Only answer text belongs in the transcript. A failure detail is diagnostic
    // state, not an assistant answer, and the summary is already on the result.
    const answer = checkpoint.resumeText || checkpoint.text || '';
    const text = answer.slice(0, 20_000);
    if (text.length > 0) {
      try {
        const messageId = `${task.taskId}:g${task.generation}:assistant`;
        const messages = await deps.conversations.messages(task.conversationId);
        // Legacy settlement used a random id but wrote the same timestamp as
        // the terminal task update. Text alone can recur in unrelated turns.
        const exists = messages.some(message => message.messageId === messageId || (
          message.role === 'assistant' && message.agent === task.agent &&
          message.createdAt === task.updatedAt && message.text === answer
        ));
        if (!exists) {
          const appended = await deps.conversations.appendMessage({
            messageId, conversationId: task.conversationId, role: 'assistant',
            text, createdAt: task.updatedAt, agent: task.agent,
          });
          repaired = appended || repaired;
        }
      } catch {
        // A transcript write is retried, never allowed to fail a settled run.
      }
    }

    try {
      if (!await deps.notifications.matches(task.ownerId, task.taskId, task.generation, terminal)) {
        await notifyTerminal(
          task,
          terminal,
          task.result?.summary ?? task.failure?.detail,
        );
        repaired = true;
      }
    } catch {
      // Same rule: the notification is repaired on the next pass.
    }
    return repaired;
  }

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
                adapterRetryableStart: outcome.adapterRetryableStart === true,
              },
            };

    // The task record is written first and is the source of truth. A crash after
    // this point is repaired from the record by `repair`, so no derived write can
    // leave a task saying it finished without a recoverable trace.
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

      // Durability barrier: the terminal event is stored before the settlement
      // is announced and before the lease can be reissued. A failure here is not
      // fatal because the record already lets the next pass repair the stream.
      await deps.events.flush(settled.taskId).catch(() => undefined);

      const text = checkpoint?.text ?? '';
      if (text.length > 0) {
        await deps.conversations.appendMessage({
          // Deterministic so a repair or a duplicate settlement cannot append the
          // same answer twice.
          messageId: `${settled.taskId}:g${settled.generation}:assistant`,
          conversationId: task.conversationId,
          role: 'assistant',
          text,
          createdAt: now,
          agent: task.agent,
        }).catch(() => false);
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
    try {
      await executeClaimed(taskId, token);
    } finally {
      await checkpointWrites.get(token);
      checkpointWrites.delete(token);
      if (localRuns.get(taskId) === token) localRuns.delete(taskId);
    }
  }

  async function executeClaimed(taskId: string, token: string): Promise<void> {
    const task = await deps.tasks.get(taskId);
    if (!task || task.runToken !== token) return;

    // Sequence numbers continue the durable watermark, so a run that starts after
    // a restart cannot reset a client's cursor to one. The generation is part of
    // the read: another replica may have advanced the sequence in between.
    try {
      await deps.events.hydrate(taskId, task.generation);
    } catch {
      await settle(task, token, {
        kind: 'failed',
        code: 'server_unavailable',
        detail: 'The execution event log is unavailable; the run was not started.',
        retryable: true,
      });
      return;
    }

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

    // One execution per generation in this process. The lease is the authority
    // across replicas; this is the local admission that refuses a double start of
    // the same generation (a scheduler retry, for example). A newer generation
    // has its own key and is therefore never blocked by an abandoned predecessor.
    const arbitrationKey = `${workRunKey(scopeOf(task))}:${token}`;
    const arbitration = deps.arbiter.acquire(arbitrationKey, adapter.value.engine);
    if (!arbitration.ok) return;

    try {
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
    localRuns.set(taskId, token);

    const steps = [...started.task.steps];
    const completed: string[] = [...(started.task.checkpoint?.completedSteps ?? [])];
    const priorText = started.task.checkpoint?.resumeText ?? '';
    let text = '';
    let visible = text;
    // Checkpoint writes are serialized: a later `step.started` cannot land before
    // an earlier `step.completed`, and the chain is awaited before settlement so
    // the durable checkpoint is at least as new as the terminal record.
    let checkpointChain: Promise<void> = Promise.resolve();
    const persistCheckpoint = (patch: TaskPatch): void => {
      checkpointChain = checkpointChain
        .then(async () => {
          await deps.tasks.updateFenced({ taskId, token, patch });
        })
        .catch(() => undefined);
      checkpointWrites.set(token, checkpointChain);
    };
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
        persistCheckpoint({ steps, updatedAt: deps.clock.iso() });
        return;
      }
      if (event.type === 'step.completed') {
        const existing = steps.find((step) => step.id === event.stepId);
        if (existing) existing.state = 'completed';
        completed.push(event.stepId);
        publish(started.task, 'step.completed', { stepId: event.stepId, title: event.title });
        // A step boundary is a complete unit of text, so the whole redacted
        // output is safe to persist; the streaming path holds the trailing token
        // back only because a later delta could still complete a credential.
        const stepText = redactContent(priorText + text);
        persistCheckpoint({
          steps,
          checkpoint: {
            completedSteps: [...completed],
            text: stepText,
            resumeText: stepText,
          },
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

    const history = await historyFor(task.conversationId, task.objective);
    const policy = normalizeRetryPolicy({
      maxAttempts: deps.config.execution.maxAttempts,
      delayMs: deps.config.execution.retryDelayMs,
    });
    const claimedAt = deps.clock.now().getTime();
    const runOnce = (): ReturnType<TaskRunner['run']> =>
      deps.runner.run({
        scope: scopeOf(started.task),
        token,
        adapter: adapter.value as AgentAdapter,
        generation: started.task.generation,
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
          // A resume continues the plan instead of replaying it. `priorText` is
          // the output of the steps that already completed, kept out of the
          // client stream but available so the run does not rebuild it by
          // repeating work.
          resume: {
            completedSteps: [...completed],
            priorText: started.task.checkpoint?.resumeText ?? '',
          },
        },
        report,
      });

    let attempt = 1;
    let result = await runOnce();
    while (
      !stopping &&
      !controller.signal.aborted &&
      shouldRetry(result.outcome, attempt, policy) &&
      // A retry must fit comfortably inside the lease this run already holds;
      // another replica may claim an expired lease at any moment.
      canRetryWithin(claimedAt, policy.delayMs, deps.config.execution.leaseTtlMs)
    ) {
      attempt += 1;
      // The failed attempt produced no durable effect, but it may have streamed
      // text. Clear it so the replay does not render the same answer twice.
      if (text.length > 0) {
        text = '';
        emitText('', true);
      }
      await wait(policy.delayMs);
      if (controller.signal.aborted) break;
      result = await runOnce();
    }
    if (controllers.get(taskId) !== controller) return;
    controllers.delete(taskId);

    // Settlement must never observe a checkpoint older than the work it reports.
    await checkpointChain;

    if (stopping && result.outcome.kind === 'cancelled') {
      // The shutdown reclaim pass writes `interrupted` under the same fence and
      // releases the lease; writing `cancelled` here would misreport an engine
      // restart as an owner cancellation.
      return;
    }

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
    await settle(started.task, token, outcome, { completedSteps: completed, text: redactContent(priorText + text) });
    } finally {
      deps.arbiter.release(arbitrationKey, adapter.value.engine);
    }
  }

  /**
   * Retires a run that no longer has a live lease.
   *
   * A missing lease row is treated exactly like an expired one: retention may
   * have removed it after the process died, and "no row" must not mean "still
   * running forever". The write is fenced, so a newer generation that claimed
   * the conversation after the read wins and this pass writes nothing.
   */
  async function reconcile(task: TaskRecord): Promise<TaskRecord> {
    if (isTerminalState(task.state) || task.state === 'awaiting_approval') {
      return task;
    }
    const lease = await deps.lease.read({ key: workRunKey(scopeOf(task)), now: deps.clock.now() });
    if (lease && lease.live) return task;

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
    if (!applied.applied) return task;

    await deps.events.hydrate(applied.task.taskId, applied.task.generation).catch(() => undefined);
    publish(applied.task, 'task.interrupted', {
      detail: 'Execution ownership was lost; the task is safe to resume.',
    });
    await deps.events.flush(applied.task.taskId).catch(() => undefined);
    await notifyTerminal(applied.task, 'interrupted').catch(() => undefined);
    deps.audit.record({
      actor: task.ownerId,
      action: 'work.interrupted',
      taskId: task.taskId,
      conversationId: task.conversationId,
      outcome: 'failed',
    });
    return applied.task;
  }

  const admissions = new Set<Promise<unknown>>();
  function admit<T>(work: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    if (stopping) return Promise.resolve(fail('not_ready', 'The engine is stopping.', true));
    const pending = work();
    admissions.add(pending);
    return pending.finally(() => admissions.delete(pending));
  }

  const service: ApplicationService = {
    health: () => deps.health.report(),
    readiness: () => deps.health.readiness(),
    agents: () => deps.agents.list(),
    models: () => deps.models.list(),

    submitWork: async (principal, request) => admit<TaskAccepted>(async () => {
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

      // The prompt is written after the lease and the task record exist. A
      // submission refused as busy or duplicate therefore leaves no user turn in
      // a conversation that has no task to answer it. The id is derived from the
      // task, so a retried submit cannot duplicate the prompt either.
      // Best effort: the task record is authoritative and already carries the
      // objective, so a transcript failure must not strand a created task and
      // its lease without ever scheduling it.
      await deps.conversations.appendMessage({
        messageId: `${created.task.taskId}:user`,
        conversationId,
        role: 'user',
        text: request.objective,
        createdAt: now,
      }).catch(() => false);

      publish(created.task, 'task.queued');
      deps.audit.record({
        actor: principal.ownerId,
        action: 'work.accepted',
        taskId: task.taskId,
        conversationId,
        outcome: 'accepted',
        detail: `agent=${agentId} model=${modelKey(model.value.ref)}`,
      });

      localRuns.set(task.taskId, token);
      deps.scheduler.enqueue(() => execute(task.taskId, token));

      return ok({
        taskId: task.taskId,
        conversationId,
        state: 'queued',
        generation: 1,
        eventsPath: `/v1/work/${task.taskId}/events`,
      });
    }),

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

    resumeTask: async (principal, taskId, generation) => admit<TaskControlResult>(async () => {
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
        // A resume continues the plan: completed steps are not repeated.
        keepCompletedSteps: true,
      });
      if (!applied.applied) return fail('conflict', 'That task cannot be resumed.');
      await deps.events.hydrate(taskId, applied.task.generation).catch(() => undefined);
      publish(applied.task, 'task.queued', {});
      publish(applied.task, 'text.replace', { text: '' });
      localRuns.set(taskId, token);
      deps.scheduler.enqueue(() => execute(taskId, token));
      return ok({
        taskId,
        state: 'queued',
        generation: applied.task.generation,
        outcome: 'accepted',
      });
    }),

    retryTask: async (principal, taskId, generation) => admit<TaskControlResult>(async () => {
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
      // Retry replays the run, so it requires the adapter's explicit pre-dispatch
      // proof: the failure is retryable and there is nothing to clean up. A
      // `retryable` flag written by a provider after it accepted work is not
      // proof, which is why the code set is checked as well.
      if (
        task.state !== 'failed' || !task.failure?.adapterRetryableStart ||
        !isRetryableStartFailure({
          code: task.failure?.code ?? '',
          retryable: task.failure?.retryable === true,
          hasCleanup: false,
        })
      ) {
        return fail(
          'conflict',
          'That failure is not safe to retry: only a start the adapter marked retryable, with nothing to clean up, may be replayed.',
        );
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
        // A retry replays the whole run, so no step is carried over as done.
        keepCompletedSteps: false,
      });
      if (!applied.applied) return fail('conflict', 'That task cannot be retried.');
      await deps.events.hydrate(taskId, applied.task.generation).catch(() => undefined);
      publish(applied.task, 'task.queued', {});
      publish(applied.task, 'text.replace', { text: '' });
      localRuns.set(taskId, token);
      deps.scheduler.enqueue(() => execute(taskId, token));
      return ok({
        taskId,
        state: 'queued',
        generation: applied.task.generation,
        outcome: 'accepted',
      });
    }),

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

    notifications: (principal) => deps.notifications.list(principal.ownerId),

    events: async (principal, taskId, after) => {
      const found = ownedTask(await deps.tasks.get(taskId), principal);
      if (!found.ok) return found;
      // Replay and subscription are opened together: an event published between
      // them is buffered and delivered first instead of being skipped.
      const opened = await deps.events.open(
        taskId,
        after,
        deps.config.execution.eventBufferSize,
      );
      return ok({
        generation: found.value.generation,
        replay: opened.replay,
        subscribe: (listener) =>
          opened.subscribe(listener as (event: ExecutionEvent) => void),
        close: opened.close,
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

      // Derived-record repair: a crash between the authoritative task write and
      // the event, transcript or notification write is recoverable because the
      // task record is checked directly instead of trusting the last process.
      let repaired = 0;
      for (const task of await deps.tasks.listSettled(REPAIR_WINDOW)) {
        if (await repair(task)) repaired += 1;
      }

      // Retention. Both sweeps are bounded and never remove a lease that is
      // still live or a task's newest event.
      const before = new Date(deps.clock.now().getTime() - deps.config.execution.retentionMs);
      await deps.lease.prune({ before, limit: PRUNE_BOUND }).catch(() => 0);
      await deps.events.prune({ before: before.toISOString(), limit: PRUNE_BOUND }).catch(() => 0);
      return { interrupted, repaired };
    },

    shutdown: async () => {
      stopping = true;
      deps.scheduler.stop();
      await Promise.allSettled(admissions);
      // Snapshot the runs this process owns before aborting them. A graceful stop
      // settles its own work; it must never enumerate the shared database and
      // interrupt a run another replica is executing.
      const owned = [...localRuns.entries()];
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();

      // Wait for the aborted runs to observe the signal and settle, so a graceful
      // stop releases its lease instead of leaving an adapter active behind a
      // closed process. The bound matches the runner's own cancellation grace.
      await Promise.race([
        deps.scheduler.idle(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deps.config.execution.cancelGraceMs + 1_000);
          timer.unref();
        }),
      ]);

      // Anything still non-terminal cannot be resumed here: retire it under the
      // token this process was given and release the lease, so a restart sees
      // `interrupted` rather than a task stuck in `running`. The token check is
      // what keeps this pass local: a task a newer generation now owns, or one
      // another replica is running, is left untouched. Approval-suspended work
      // is left alone too; it is waiting for the owner, not for this process.
      for (const [taskId, token] of owned) {
        await checkpointWrites.get(token);
        const task = await deps.tasks.get(taskId);
        if (!task || task.runToken !== token) continue;
        if (isTerminalState(task.state) || task.state === 'awaiting_approval') continue;
        const applied = await deps.tasks.updateFenced({
          taskId,
          token,
          patch: {
            state: 'interrupted',
            updatedAt: deps.clock.iso(),
            failure: {
              code: 'server_unavailable',
              detail: 'The engine stopped while this run was active.',
              retryable: true,
            },
          },
        });
        if (!applied.applied) continue;
        publish(applied.task, 'task.interrupted', {
          detail: 'The engine stopped while this run was active.',
        });
        await deps.events.flush(applied.task.taskId).catch(() => undefined);
        await notifyTerminal(applied.task, 'interrupted').catch(() => undefined);
        await releaseLease(applied.task, token);
      }
      localRuns.clear();
      await deps.events.close();
    },
  };

  return service;
}
