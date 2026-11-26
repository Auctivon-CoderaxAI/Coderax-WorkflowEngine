import type {
  ScheduleDispatch,
  ScheduleExecutionState,
  TaskState,
} from '@coderax/contracts';
import type { ScheduleExecutionRecord, ScheduleRecord } from '../domain.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ScheduleNoticeStore, ScheduleRepository } from '../persistence/schedules.js';
import {
  ONGOING_EXECUTION_STATES,
  RUN_EXECUTION_STATES,
} from '../persistence/schedules.js';
import {
  decideDue,
  evaluateCondition,
  nextOccurrence,
  nextScheduleRun,
  nextUtcDayStart,
  utcDayStart,
} from './calendar.js';
import { scheduledConversationId, scheduledTaskId } from './identity.js';

/**
 * The durable schedule engine.
 *
 * There is one loop per process, and it is owned by the engine rather than by a
 * request: the web UI and the CLI can disconnect without pausing a schedule. The
 * loop only *proposes* work. Every proposal becomes a receipt with a unique key
 * before any Work task is created, and the task id is derived from the schedule,
 * the occurrence and the attempt. Two replicas waking at the same instant
 * therefore produce one receipt and one task, not two executions.
 *
 * The authority for a run's state stays the task record: this engine reconciles
 * receipts against the task repository instead of duplicating settlement rules.
 */

export type ScheduleEngineSettings = {
  enabled: boolean;
  tickMs: number;
  batchSize: number;
  maxConcurrentRuns: number;
  missedGraceMs: number;
  dispatchTimeoutMs: number;
  pauseAfterFailures: number;
};

export type ScheduleTaskSnapshot = {
  state: TaskState;
  summary: string | null;
  failure: { code: string; retryable: boolean } | null;
};

export type ScheduleDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'budget' | 'refused' | 'duplicate'; detail: string };

export type SchedulePort = {
  /** Submits Work through the authoritative orchestration service. */
  dispatch: (input: {
    schedule: ScheduleRecord;
    taskId: string;
    conversationId: string;
    attempt: number;
  }) => Promise<ScheduleDispatchOutcome>;
  taskSnapshot: (taskId: string) => Promise<ScheduleTaskSnapshot | null>;
};

export type ScheduleTickReport = {
  at: string;
  due: number;
  dispatched: number;
  retried: number;
  missed: number;
  refused: number;
  reconciled: number;
};

export type ScheduleEngine = {
  /** One bounded pass. Serialized: an overlapping call returns an empty report. */
  tick: () => Promise<ScheduleTickReport>;
  /** An explicit occurrence that does not move the recurrence. */
  trigger: (input: {
    schedule: ScheduleRecord;
    occurrenceKey: string;
    trigger: 'manual' | 'event';
  }) => Promise<ScheduleDispatch>;
  start: () => void;
  stop: () => Promise<void>;
  running: () => boolean;
  lastTick: () => { at: string | null; error: string | null };
};

type OccurrencePlan = {
  schedule: ScheduleRecord;
  occurrenceKey: string;
  scheduledFor: Date;
  trigger: 'schedule' | 'manual' | 'event' | 'retry';
  /** Scheduled occurrences move the recurrence; explicit ones do not. */
  advance: boolean;
  /** An explicit occurrence records a skipped receipt instead of nothing. */
  recordSkip: boolean;
};

const FAILURE_DETAIL_LIMIT = 1_000;
const NOTICE_SUMMARY_LIMIT = 500;

export function createScheduleEngine(input: {
  store: ScheduleRepository;
  notices: ScheduleNoticeStore;
  port: SchedulePort;
  settings: ScheduleEngineSettings;
  clock: Clock;
  ids: IdGenerator;
}): ScheduleEngine {
  const { store, notices, port, settings, clock, ids } = input;
  let timer: NodeJS.Timeout | null = null;
  let inTick = false;
  let current: Promise<ScheduleTickReport> | null = null;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;

  const iso = (): string => clock.iso();

  function emptyReport(): ScheduleTickReport {
    return {
      at: iso(),
      due: 0,
      dispatched: 0,
      retried: 0,
      missed: 0,
      refused: 0,
      reconciled: 0,
    };
  }

  function truncate(text: string | null | undefined, limit: number): string | null {
    if (!text) return null;
    // The ellipsis is part of the field's contract maximum, not an extra byte.
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  }

  async function recordNotice(input: {
    noticeId: string;
    schedule: ScheduleRecord;
    executionId: string;
    kind: 'completed' | 'failed' | 'missed' | 'refused';
    summary: string;
  }): Promise<void> {
    await notices.record({
      noticeId: input.noticeId,
      scheduleId: input.schedule.scheduleId,
      executionId: input.executionId,
      ownerId: input.schedule.ownerId,
      kind: input.kind,
      summary: input.summary.slice(0, NOTICE_SUMMARY_LIMIT),
      createdAt: iso(),
      read: false,
    });
  }

  /**
   * Counters are best-effort under a concurrent writer: a lost compare-and-swap
   * means another replica already changed the record, so this re-reads once and
   * applies the patch to the latest version rather than overwriting it.
   */
  async function patchSchedule(
    scheduleId: string,
    patchFor: (current: ScheduleRecord) => Partial<ScheduleRecord> | null,
  ): Promise<ScheduleRecord | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await store.get(scheduleId);
      if (!current) return null;
      const patch = patchFor(current);
      if (!patch) return current;
      const applied = await store.update({
        scheduleId,
        expectedVersion: current.version,
        patch: { ...patch, updatedAt: iso() },
      });
      if (applied.applied) return applied.schedule;
    }
    return null;
  }

  /**
   * Moves the durable next run past `from`; a lost swap means it already moved.
   *
   * The latest record is re-read because dispatch increments the run counter
   * first. Advancing from a stale version would fail every time and leave the
   * same occurrence due forever.
   */
  async function advance(
    schedule: ScheduleRecord,
    from: Date,
    patch: Partial<ScheduleRecord> = {},
  ): Promise<boolean> {
    const current = await store.get(schedule.scheduleId);
    if (!current || current.state !== 'active') return false;
    const next = nextScheduleRun(current, from);
    const applied = await store.update({
      scheduleId: schedule.scheduleId,
      expectedVersion: current.version,
      patch: {
        ...patch,
        nextRunAt: next ? next.toISOString() : null,
        updatedAt: iso(),
        ...(next ? {} : { state: 'exhausted' as const }),
      },
    });
    return applied.applied;
  }

  function executionFor(plan: OccurrencePlan, fields: {
    executionId: string;
    state: ScheduleExecutionState;
    attempt: number;
    taskId: string | null;
    conversationId: string;
    detail: string | null;
    nextAttemptAt: string | null;
    condition: 'not_evaluated' | 'met' | 'unmet';
    finishedAt: string | null;
  }): ScheduleExecutionRecord {
    const now = iso();
    return {
      executionId: fields.executionId,
      executionKey: `${plan.schedule.scheduleId}:${plan.occurrenceKey}:${fields.attempt}`,
      scheduleId: plan.schedule.scheduleId,
      ownerId: plan.schedule.ownerId,
      occurrenceKey: plan.occurrenceKey,
      trigger: plan.trigger,
      scheduledFor: plan.scheduledFor.toISOString(),
      state: fields.state,
      attempt: fields.attempt,
      maxAttempts: plan.schedule.retry.maxAttempts,
      taskId: fields.taskId,
      conversationId: fields.conversationId,
      priority: plan.schedule.priority,
      detail: fields.detail,
      nextAttemptAt: fields.nextAttemptAt,
      condition: fields.condition,
      createdAt: now,
      updatedAt: now,
      finishedAt: fields.finishedAt,
    };
  }

  function toDispatch(
    execution: ScheduleExecutionRecord,
    duplicate: boolean,
  ): ScheduleDispatch {
    return {
      scheduleId: execution.scheduleId,
      executionId: execution.executionId,
      duplicate,
      state: execution.state,
      taskId: execution.taskId,
    };
  }

  async function refuseOccurrence(
    plan: OccurrencePlan,
    detail: string,
  ): Promise<ScheduleDispatch> {
    const executionId = ids.executionId();
    const execution = executionFor(plan, {
      executionId,
      state: 'refused',
      attempt: 1,
      taskId: null,
      conversationId: scheduledConversationId(plan.schedule.scheduleId),
      detail,
      nextAttemptAt: null,
      condition: 'not_evaluated',
      finishedAt: iso(),
    });
    const created = await store.createExecution(execution);
    if (!created.created) return toDispatch(created.execution, true);
    await recordNotice({
      noticeId: `ntc_${executionId}_refused`,
      schedule: plan.schedule,
      executionId,
      kind: 'refused',
      summary: `Scheduled run "${plan.schedule.name}" was refused: ${detail}`,
    });
    return toDispatch(execution, false);
  }

  async function skipOccurrence(
    plan: OccurrencePlan,
    detail: string,
  ): Promise<ScheduleDispatch | null> {
    if (!plan.recordSkip) return null;
    const executionId = ids.executionId();
    const execution = executionFor(plan, {
      executionId,
      state: 'skipped',
      attempt: 1,
      taskId: null,
      conversationId: scheduledConversationId(plan.schedule.scheduleId),
      detail,
      nextAttemptAt: null,
      condition: 'not_evaluated',
      finishedAt: iso(),
    });
    const created = await store.createExecution(execution);
    return toDispatch(created.created ? execution : created.execution, !created.created);
  }

  type Admission =
    | { kind: 'proceed' }
    | { kind: 'skip'; detail: string }
    | { kind: 'refuse'; dispatch: ScheduleDispatch };

  /** Enforces both resource ceilings before any Work is submitted. */
  async function admission(plan: OccurrencePlan, now: Date): Promise<Admission> {
    const { schedule } = plan;
    if (
      schedule.limits.maxRunsTotal !== undefined &&
      schedule.runsTotal >= schedule.limits.maxRunsTotal
    ) {
      // Only an active schedule may exhaust. A concurrent cancellation is
      // terminal and must never be overwritten by an in-flight admission.
      await patchSchedule(schedule.scheduleId, (current) =>
        current.state !== 'active'
          ? null
          : { state: 'exhausted', nextRunAt: null, updatedAt: iso() },
      );
      return {
        kind: 'refuse',
        dispatch: await refuseOccurrence(
          plan,
          'The total run limit for this schedule is reached.',
        ),
      };
    }

    const used = await store.countExecutionsSince(
      schedule.scheduleId,
      utcDayStart(now).toISOString(),
      RUN_EXECUTION_STATES,
    );
    if (used >= schedule.limits.maxRunsPerDay) {
      if (plan.advance) {
        // Park past the current UTC day. One refusal per day, not one per
        // recurrence: a one-second schedule must not create a receipt storm.
        const resumeAt = nextOccurrence(
          schedule.timing,
          nextUtcDayStart(now),
          new Date(schedule.createdAt),
        );
        await store.update({
          scheduleId: schedule.scheduleId,
          expectedVersion: schedule.version,
          patch: {
            nextRunAt: resumeAt ? resumeAt.toISOString() : null,
            updatedAt: iso(),
            ...(resumeAt ? {} : { state: 'exhausted' as const }),
          },
        });
      }
      return {
        kind: 'refuse',
        dispatch: await refuseOccurrence(
          plan,
          `The daily run limit (${schedule.limits.maxRunsPerDay}) is reached.`,
        ),
      };
    }

    if ((await store.countActiveExecutions(schedule.scheduleId)) > 0) {
      return {
        kind: 'skip',
        detail: 'A previous run of this schedule is still active; overlapping occurrences are skipped.',
      };
    }

    if ((await store.countActive()) >= settings.maxConcurrentRuns) {
      return {
        kind: 'skip',
        detail: 'The engine concurrency limit for scheduled runs is reached.',
      };
    }

    return { kind: 'proceed' };
  }

  /**
   * Records the occurrence, then submits Work. The receipt is inserted before the
   * task so a crash in between is recoverable; the task id is deterministic so a
   * recovery cannot create a second task for the same occurrence.
   */
  async function dispatchOccurrence(plan: OccurrencePlan, now: Date): Promise<{
    dispatch: ScheduleDispatch | null;
    created: boolean;
    submitted: boolean;
    /** Admission already parked the schedule, so the caller must not advance it. */
    advanceHandled: boolean;
  }> {
    const admitted = await admission(plan, now);
    if (admitted.kind === 'refuse') {
      return {
        dispatch: admitted.dispatch,
        created: !admitted.dispatch.duplicate,
        submitted: false,
        advanceHandled: true,
      };
    }
    if (admitted.kind === 'skip') {
      const dispatch = await skipOccurrence(plan, admitted.detail);
      return {
        dispatch,
        created: dispatch !== null,
        submitted: false,
        advanceHandled: false,
      };
    }

    const attempt = 1;
    const executionId = ids.executionId();
    const conversationId = scheduledConversationId(plan.schedule.scheduleId);
    const taskId = scheduledTaskId(plan.schedule.scheduleId, plan.occurrenceKey, attempt);
    const execution = executionFor(plan, {
      executionId,
      state: 'claimed',
      attempt,
      taskId,
      conversationId,
      detail: null,
      nextAttemptAt: null,
      condition: 'not_evaluated',
      finishedAt: null,
    });
    const created = await store.createExecution(execution);
    if (!created.created) {
      // Another replica owns this occurrence. It also owns the schedule advance;
      // this caller must not submit a second run.
      return {
        dispatch: toDispatch(created.execution, true),
        created: false,
        submitted: false,
        advanceHandled: false,
      };
    }

    const outcome = await port.dispatch({
      schedule: plan.schedule,
      taskId,
      conversationId,
      attempt,
    });
    if (outcome.ok) {
      const moved = await store.updateExecution({
        executionId,
        from: ONGOING_EXECUTION_STATES,
        patch: { state: 'dispatched', updatedAt: iso() },
      });
      await patchSchedule(plan.schedule.scheduleId, (current) => ({
        runsTotal: current.runsTotal + 1,
        lastRunAt: iso(),
        lastExecutionId: executionId,
        updatedAt: iso(),
      }));
      return {
        dispatch: toDispatch(moved ?? execution, false),
        created: true,
        submitted: true,
        advanceHandled: false,
      };
    }

    if (outcome.reason === 'duplicate') {
      // The deterministic task id already exists (a previous dispatch landed).
      // Reconciliation will link the receipt to that task; never submit twice.
      return {
        dispatch: toDispatch(execution, false),
        created: true,
        submitted: false,
        advanceHandled: false,
      };
    }

    const state: ScheduleExecutionState = outcome.reason === 'busy' ? 'skipped' : 'refused';
    const moved = await store.updateExecution({
      executionId,
      from: ['claimed'],
      patch: {
        state,
        detail: truncate(outcome.detail, FAILURE_DETAIL_LIMIT),
        updatedAt: iso(),
        finishedAt: iso(),
      },
    });
    if (state === 'refused') {
      await recordNotice({
        noticeId: `ntc_${executionId}_refused`,
        schedule: plan.schedule,
        executionId,
        kind: 'refused',
        summary: `Scheduled run "${plan.schedule.name}" was refused: ${outcome.detail}`,
      });
    }
    return {
      dispatch: toDispatch(moved ?? execution, false),
      created: true,
      submitted: false,
      advanceHandled: false,
    };
  }

  async function createTerminalReceipt(input: {
    plan: OccurrencePlan;
    state: 'missed';
    detail: string;
  }): Promise<ScheduleExecutionRecord> {
    const executionId = ids.executionId();
    const execution = executionFor(input.plan, {
      executionId,
      state: input.state,
      attempt: 1,
      taskId: null,
      conversationId: scheduledConversationId(input.plan.schedule.scheduleId),
      detail: truncate(input.detail, FAILURE_DETAIL_LIMIT),
      nextAttemptAt: null,
      condition: 'not_evaluated',
      finishedAt: iso(),
    });
    const created = await store.createExecution(execution);
    return created.created ? execution : created.execution;
  }

  async function handleDue(
    schedule: ScheduleRecord,
    now: Date,
    report: ScheduleTickReport,
  ): Promise<void> {
    const decision = decideDue({ schedule, now, missedGraceMs: settings.missedGraceMs });
    if (decision.kind === 'none') return;

    if (decision.kind === 'missed' && schedule.missedRunPolicy === 'skip') {
      const plan: OccurrencePlan = {
        schedule,
        occurrenceKey: decision.dueAt.toISOString(),
        scheduledFor: decision.dueAt,
        trigger: 'schedule',
        advance: true,
        recordSkip: false,
      };
      const execution = await createTerminalReceipt({
        plan,
        state: 'missed',
        detail: `Missed by ${Math.round(decision.lateMs / 1_000)}s; the next occurrence will run instead of replaying a backlog.`,
      });
      if (execution.state === 'missed') {
        await recordNotice({
          noticeId: `ntc_${execution.executionId}_missed`,
          schedule,
          executionId: execution.executionId,
          kind: 'missed',
          summary: `Scheduled run "${schedule.name}" was missed by ${Math.round(decision.lateMs / 1_000)}s; later occurrences were not stormed.`,
        });
        report.missed += 1;
      }
      await advance(schedule, now, {});
      return;
    }

    const plan: OccurrencePlan = {
      schedule,
      occurrenceKey: decision.dueAt.toISOString(),
      scheduledFor: decision.dueAt,
      trigger: 'schedule',
      advance: true,
      recordSkip: false,
    };
    const outcome = await dispatchOccurrence(plan, now);
    if (outcome.submitted) report.dispatched += 1;
    if (outcome.dispatch?.state === 'refused') report.refused += 1;

    // A catch-up run advances from now, not from the missed instant, so the
    // backlog is discharged by at most one run. Admission may already have
    // parked the schedule (daily or total limit); advancing again would undo it.
    if (!outcome.advanceHandled) {
      await advance(schedule, decision.kind === 'missed' ? now : decision.dueAt, {});
    }
  }

  async function reconcileExecution(
    execution: ScheduleExecutionRecord,
    now: Date,
    report: ScheduleTickReport,
  ): Promise<void> {
    // A receipt without a Work task id is already terminal (missed, refused or
    // skipped) and has nothing to reconcile.
    const taskId = execution.taskId;
    if (!taskId) return;

    const snapshot = await port.taskSnapshot(taskId);
    if (!snapshot) {
      if (execution.state !== 'claimed') return;
      const age = now.getTime() - new Date(execution.createdAt).getTime();
      if (age <= settings.dispatchTimeoutMs) return;
      if (age > settings.dispatchTimeoutMs * 5) {
        const schedule = await store.get(execution.scheduleId);
        const missed = await store.updateExecution({
          executionId: execution.executionId,
          from: ['claimed'],
          patch: {
            state: 'missed',
            detail: 'Dispatch created no task before the recovery window closed.',
            updatedAt: iso(),
            finishedAt: iso(),
          },
        });
        if (missed && schedule) {
          await recordNotice({
            noticeId: `ntc_${execution.executionId}_missed`,
            schedule,
            executionId: execution.executionId,
            kind: 'missed',
            summary: `A scheduled run of "${schedule.name}" could not be dispatched in time.`,
          });
          report.missed += 1;
        }
        return;
      }
      // Recovery is safe: the task id is deterministic, so a submit that lands
      // late is refused by the task repository instead of running twice.
      const schedule = await store.get(execution.scheduleId);
      if (!schedule) return;
      if (schedule.state === 'cancelled') {
        await store.updateExecution({
          executionId: execution.executionId,
          from: ['claimed'],
          patch: {
            state: 'cancelled',
            detail: 'The schedule was cancelled before dispatch.',
            updatedAt: iso(),
            finishedAt: iso(),
          },
        });
        return;
      }
      const outcome = await port.dispatch({
        schedule,
        taskId,
        conversationId: execution.conversationId,
        attempt: execution.attempt,
      });
      const account = async (): Promise<void> => {
        // The original dispatch may have crashed after creating the task but
        // before accounting. Recovery applies the same counter once, on the
        // receipt transition that proves the task exists.
        await patchSchedule(execution.scheduleId, (current) => ({
          runsTotal: current.runsTotal + 1,
          lastRunAt: iso(),
          lastExecutionId: execution.executionId,
          updatedAt: iso(),
        }));
      };
      if (outcome.ok) {
        const moved = await store.updateExecution({
          executionId: execution.executionId,
          from: ['claimed'],
          patch: { state: 'dispatched', updatedAt: iso() },
        });
        if (moved) {
          await account();
          report.dispatched += 1;
        }
      } else if (outcome.reason === 'duplicate') {
        const landed = await port.taskSnapshot(taskId);
        if (landed) {
          const moved = await store.updateExecution({
            executionId: execution.executionId,
            from: ['claimed'],
            patch: { state: 'dispatched', updatedAt: iso() },
          });
          if (moved) await account();
        }
      }
      return;
    }
    if (execution.state === 'claimed') {
      await store.updateExecution({
        executionId: execution.executionId,
        from: ['claimed'],
        patch: { state: 'dispatched', updatedAt: iso() },
      });
    }

    if (snapshot.state !== 'completed' && snapshot.state !== 'failed' && snapshot.state !== 'interrupted' && snapshot.state !== 'cancelled') {
      return;
    }

    const schedule = await store.get(execution.scheduleId);
    if (!schedule) return;

    if (snapshot.state === 'cancelled') {
      await store.updateExecution({
        executionId: execution.executionId,
        from: ONGOING_EXECUTION_STATES,
        patch: { state: 'cancelled', detail: 'The Work task was cancelled.', updatedAt: iso(), finishedAt: iso() },
      });
      report.reconciled += 1;
      return;
    }

    if (snapshot.state === 'completed') {
      const summary = snapshot.summary ?? '';
      const condition = evaluateCondition(schedule.condition, summary);
      if (condition === 'met') {
        await recordNotice({
          noticeId: `ntc_${execution.executionId}_completed`,
          schedule,
          executionId: execution.executionId,
          kind: 'completed',
          summary: summary.length > 0
            ? `Scheduled run "${schedule.name}" completed: ${summary}`
            : `Scheduled run "${schedule.name}" completed.`,
        });
      }
      const moved = await store.updateExecution({
        executionId: execution.executionId,
        from: ONGOING_EXECUTION_STATES,
        patch: {
          state: 'completed',
          condition,
          detail: truncate(summary, FAILURE_DETAIL_LIMIT),
          updatedAt: iso(),
          finishedAt: iso(),
        },
      });
      if (moved) {
        await patchSchedule(schedule.scheduleId, (current) =>
          current.consecutiveFailures === 0 ? null : { consecutiveFailures: 0, updatedAt: iso() },
        );
        report.reconciled += 1;
      }
      return;
    }

    const failureCode = snapshot.failure?.code ?? 'provider_error';
    // Only an adapter-confirmed retryable *failure* may be replayed as a new
    // task. An interrupted run may already have performed work and has a
    // resumable checkpoint; replacing it would discard that checkpoint and
    // repeat steps. The owner resumes it through the Work resume operation.
    const interrupted = snapshot.state === 'interrupted';
    const retryable = !interrupted && snapshot.failure?.retryable === true;
    if (retryable && execution.attempt < execution.maxAttempts) {
      const delayMs = schedule.retry.delaySeconds * 1_000;
      const moved = await store.updateExecution({
        executionId: execution.executionId,
        from: ONGOING_EXECUTION_STATES,
        patch: {
          state: 'retry_wait',
          attempt: execution.attempt + 1,
          taskId: scheduledTaskId(
            execution.scheduleId,
            execution.occurrenceKey,
            execution.attempt + 1,
          ),
          detail: `Attempt ${execution.attempt} failed with ${failureCode}.`,
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          updatedAt: iso(),
        },
      });
      if (moved) report.retried += 1;
      return;
    }

    const moved = await store.updateExecution({
      executionId: execution.executionId,
      from: ONGOING_EXECUTION_STATES,
      patch: {
        state: 'failed',
        detail: truncate(
          interrupted
            ? `Attempt ${execution.attempt} was interrupted and is resumable; it was not replayed as a new task.`
            : `Failed with ${failureCode}.`,
          FAILURE_DETAIL_LIMIT,
        ),
        updatedAt: iso(),
        finishedAt: iso(),
      },
    });
    if (!moved) return;
    const updated = await patchSchedule(schedule.scheduleId, (current) => {
      const failures = current.consecutiveFailures + 1;
      const shouldPause =
        current.state === 'active' && failures >= settings.pauseAfterFailures;
      return {
        consecutiveFailures: failures,
        ...(shouldPause
          ? { state: 'paused' as const, pausedAt: iso(), nextRunAt: null }
          : {}),
        updatedAt: iso(),
      };
    });
    const pausedForFailures = updated?.state === 'paused';
    await recordNotice({
      noticeId: `ntc_${execution.executionId}_failed`,
      schedule,
      executionId: execution.executionId,
      kind: 'failed',
      summary: interrupted
        ? `Scheduled run "${schedule.name}" was interrupted after ${execution.attempt} attempt(s); the Work task is resumable and was not replayed automatically.`
        : pausedForFailures
          ? `Scheduled run "${schedule.name}" failed with ${failureCode} after ${execution.attempt} attempt(s); the schedule was paused to prevent a runaway.`
          : `Scheduled run "${schedule.name}" failed with ${failureCode} after ${execution.attempt} attempt(s).`,
    });
    report.reconciled += 1;
  }

  /** A retry waits durably; it is admitted only when its backoff has elapsed. */
  async function dispatchRetries(now: Date, report: ScheduleTickReport): Promise<void> {
    const waiting = await store.listExecutionsByState(['retry_wait'], settings.batchSize);
    for (const execution of waiting) {
      if (!execution.nextAttemptAt) continue;
      if (new Date(execution.nextAttemptAt).getTime() > now.getTime()) continue;
      const schedule = await store.get(execution.scheduleId);
      if (!schedule) continue;
      if (schedule.state === 'cancelled') {
        await store.updateExecution({
          executionId: execution.executionId,
          from: ['retry_wait'],
          patch: { state: 'cancelled', detail: 'The schedule was cancelled.', updatedAt: iso(), finishedAt: iso() },
        });
        continue;
      }
      if ((await store.countActiveExecutions(schedule.scheduleId)) > 0) continue;
      if ((await store.countActive()) >= settings.maxConcurrentRuns) break;

      const claimed = await store.updateExecution({
        executionId: execution.executionId,
        from: ['retry_wait'],
        patch: { state: 'claimed', nextAttemptAt: null, updatedAt: iso() },
      });
      if (!claimed || !claimed.taskId) continue;

      const outcome = await port.dispatch({
        schedule,
        taskId: claimed.taskId,
        conversationId: claimed.conversationId,
        attempt: claimed.attempt,
      });
      if (outcome.ok) {
        await store.updateExecution({
          executionId: execution.executionId,
          from: ['claimed'],
          patch: { state: 'dispatched', updatedAt: iso() },
        });
        report.dispatched += 1;
        continue;
      }
      if (outcome.reason === 'duplicate') continue;
      const delayMs = Math.max(schedule.retry.delaySeconds * 1_000, 5_000);
      await store.updateExecution({
        executionId: execution.executionId,
        from: ['claimed'],
        patch: {
          state: 'retry_wait',
          detail: truncate(outcome.detail, FAILURE_DETAIL_LIMIT),
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          updatedAt: iso(),
        },
      });
    }
  }

  async function runTick(): Promise<ScheduleTickReport> {
    const report = emptyReport();
    const now = clock.now();

    const ongoing = await store.listExecutionsByState(ONGOING_EXECUTION_STATES, settings.batchSize);
    for (const execution of ongoing) {
      await reconcileExecution(execution, now, report);
    }

    await dispatchRetries(now, report);

    const due = await store.listDue({ now: now.toISOString(), limit: settings.batchSize });
    report.due = due.length;
    for (const schedule of due) {
      if ((await store.countActive()) >= settings.maxConcurrentRuns) break;
      await handleDue(schedule, now, report);
    }

    report.at = iso();
    return report;
  }

  const engine: ScheduleEngine = {
    tick: async () => {
      if (inTick) return emptyReport();
      inTick = true;
      try {
        const report = await runTick();
        lastTickAt = report.at;
        lastError = null;
        return report;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'scheduled tick failed';
        throw error;
      } finally {
        inTick = false;
      }
    },

    trigger: async ({ schedule, occurrenceKey, trigger }) => {
      const now = clock.now();
      const plan: OccurrencePlan = {
        schedule,
        occurrenceKey,
        scheduledFor: now,
        trigger,
        advance: false,
        recordSkip: true,
      };
      const outcome = await dispatchOccurrence(plan, now);
      // `dispatchOccurrence` always records an explicit occurrence because
      // `recordSkip` is true; the fallback keeps the return type honest.
      return outcome.dispatch ?? {
        scheduleId: schedule.scheduleId,
        executionId: ids.executionId(),
        duplicate: false,
        state: 'skipped',
        taskId: null,
      };
    },

    start: () => {
      if (!settings.enabled || timer) return;
      timer = setInterval(() => {
        if (current) return;
        current = engine
          .tick()
          .catch(() => emptyReport())
          .finally(() => {
            current = null;
          });
      }, settings.tickMs);
      timer.unref();
    },

    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (current) {
        await current.catch(() => undefined);
      }
    },

    running: () => timer !== null,
    lastTick: () => ({ at: lastTickAt, error: lastError }),
  };

  return engine;
}
