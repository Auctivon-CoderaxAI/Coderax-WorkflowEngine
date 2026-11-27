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
  PermissionRequest,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  Usage,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { isTerminalState, modelKey } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { TaskEvidence, TaskPatch, TaskPlan, TaskRecord, TaskStep } from '../domain.js';
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
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  browser: BrowserService;
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
            detail: outcome.detail,
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
              artifacts: [] as Array<{ path: string; bytes?: number; digest?: string }>,
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
                detail: outcome.detail,
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
      if (replace || !next.startsWith(visible)) publish(started.task, 'text.replace', { text: next });
      else if (next !== visible) publish(started.task, 'text.delta', { text: next.slice(visible.length) });
      visible = next;
    };

    const report = (event: AgentReportEvent): void => {
      if (controllers.get(taskId) !== controller || controller.signal.aborted) return;

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
        publish(started.task, 'step.started', { stepId: event.stepId, title: event.title });
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
        publish(started.task, 'step.completed', { stepId: event.stepId, title: event.title });
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
        taskId: task.taskId,
        objective: task.objective,
        history,
        model: model.value.ref,
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
    });
    if (controllers.get(taskId) !== controller) return;
    controllers.delete(taskId);
    await writeChain.catch(() => undefined);

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
      publish(applied.task, 'task.cancelled', {});
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

    submitWork: async (principal, request) => {
      const agentId: AgentId = request.agent ?? deps.agents.defaultAgent;
      const adapter = deps.agents.resolve(agentId);
      if (!adapter.ok) return adapter;

      const model = deps.models.resolve(request.model, request.mode);
      if (!model.ok) return model;

      // Reasoning mode is resolved once, from the objective and the owner's
      // explicit choice, and persisted. A resume does not silently change it.
      const reasoning = resolveReasoningMode({
        requested: request.reasoning,
        objective: request.objective,
      });

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
      return ok(toStatus(task));
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
        from: ['failed', 'interrupted'],
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
          reasoning: 'fast',
          completedSteps: [],
          plan: null,
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
      // Release cloud browsers rather than letting them run until their TTL.
      await deps.browser.shutdown();
    },
  };

  return service;
}
