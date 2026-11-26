import { z } from 'zod';
import { Budget } from './models.js';
import {
  AgentId,
  DataMode,
  IsoDateTime,
  ModelRef,
  ScheduleId,
  TaskId,
} from './primitives.js';

/**
 * Scheduling is an engine capability, not a client timer.
 *
 * A schedule is a durable owner record that authorizes the engine to submit Work
 * on a recurrence. The client that created it may be closed, and a replica that
 * did not create it must still be able to discharge it. Every field below is part
 * of that record, so a restarted engine can resume without reconstructing intent
 * from a UI or a CLI.
 */

export const ScheduleState = z.enum(['active', 'paused', 'cancelled', 'exhausted']);
export type ScheduleState = z.infer<typeof ScheduleState>;

export const ScheduleTrigger = z.enum(['schedule', 'manual', 'event', 'retry']);
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

/**
 * `claimed` means a durable receipt exists but Work ownership was not yet
 * recorded; `dispatched` means a task exists. Both are recoverable after a
 * crash, and neither is terminal.
 */
export const ScheduleExecutionState = z.enum([
  'claimed',
  'dispatched',
  'retry_wait',
  'completed',
  'failed',
  'cancelled',
  'missed',
  'refused',
  'skipped',
]);
export type ScheduleExecutionState = z.infer<typeof ScheduleExecutionState>;

export const TERMINAL_EXECUTION_STATES: readonly ScheduleExecutionState[] = [
  'completed',
  'failed',
  'cancelled',
  'missed',
  'refused',
  'skipped',
];

export function isTerminalExecution(state: ScheduleExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(state);
}

/**
 * Time zones are IANA names validated at the contract boundary. A deployment
 * cannot store a schedule whose zone the runtime does not understand, because
 * that would silently shift an owner's execution window.
 */
export const TimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'unknown IANA time zone');
export type TimeZone = z.infer<typeof TimeZone>;

export const ScheduleOnceTiming = z
  .object({
    kind: z.literal('once'),
    /** A one-time schedule must be in the future when it is created. */
    at: IsoDateTime,
  })
  .strict();
export type ScheduleOnceTiming = z.infer<typeof ScheduleOnceTiming>;

export const ScheduleIntervalTiming = z
  .object({
    kind: z.literal('interval'),
    /** Minimum one second; the per-schedule daily limit bounds the rate. */
    everySeconds: z.number().int().min(1).max(2_592_000),
    /** Omitted means the creation instant; the anchor survives a restart. */
    anchor: IsoDateTime.optional(),
  })
  .strict();
export type ScheduleIntervalTiming = z.infer<typeof ScheduleIntervalTiming>;

export const ScheduleCalendarTiming = z
  .object({
    kind: z.literal('calendar'),
    timeZone: TimeZone,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    /** 0 is Sunday. Omitted means every day. Evaluated in `timeZone`. */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  })
  .strict();
export type ScheduleCalendarTiming = z.infer<typeof ScheduleCalendarTiming>;

export const ScheduleHourlyTiming = z
  .object({
    kind: z.literal('hourly'),
    timeZone: TimeZone,
    /** Every hour at this wall-clock minute in `timeZone`. */
    minute: z.number().int().min(0).max(59),
  })
  .strict();
export type ScheduleHourlyTiming = z.infer<typeof ScheduleHourlyTiming>;

/**
 * Monthly runs are limited to the first 28 days so every month has the day. A
 * rule for the 31st would silently skip February instead of telling the owner.
 */
export const ScheduleMonthlyTiming = z
  .object({
    kind: z.literal('monthly'),
    timeZone: TimeZone,
    dayOfMonth: z.number().int().min(1).max(28),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();
export type ScheduleMonthlyTiming = z.infer<typeof ScheduleMonthlyTiming>;

export const ScheduleEventTiming = z
  .object({
    kind: z.literal('event'),
    /** Fired by the owner through the schedule-event operation. */
    event: z.string().trim().min(1).max(120),
  })
  .strict();
export type ScheduleEventTiming = z.infer<typeof ScheduleEventTiming>;

export const ScheduleTiming = z.discriminatedUnion('kind', [
  ScheduleOnceTiming,
  ScheduleIntervalTiming,
  ScheduleCalendarTiming,
  ScheduleHourlyTiming,
  ScheduleMonthlyTiming,
  ScheduleEventTiming,
]);
export type ScheduleTiming = z.infer<typeof ScheduleTiming>;

/**
 * A condition turns a recurring run into a monitor: the Work task still runs, but
 * the owner is notified only when the produced summary satisfies the predicate.
 * `result_absent` is the alerting form ("tell me when this is no longer true").
 */
export const ScheduleCondition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z
    .object({
      kind: z.literal('result_contains'),
      text: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal('result_absent'),
      text: z.string().min(1).max(500),
    })
    .strict(),
]);
export type ScheduleCondition = z.infer<typeof ScheduleCondition>;
export type ScheduleConditionState = 'not_evaluated' | 'met' | 'unmet';

export const ScheduleConditionStateSchema = z.enum(['not_evaluated', 'met', 'unmet']);

/**
 * Schedule-level retry re-runs the occurrence as a new Work generation on the
 * same agent. `maxAttempts` includes the first run and is bounded, so a failing
 * schedule cannot loop forever.
 */
export const ScheduleRetry = z
  .object({
    maxAttempts: z.number().int().min(1).max(5).default(1),
    delaySeconds: z.number().int().min(0).max(3_600).default(60),
  })
  .strict();
export type ScheduleRetry = z.infer<typeof ScheduleRetry>;

/**
 * Resource and inference ceilings for one schedule.
 *
 * `maxRunsPerDay` is the runaway guard: once it is reached the engine parks the
 * schedule past the current UTC day instead of creating an unbounded stream of
 * refused attempts. `maxRunsTotal` turns a one-shot objective into an
 * exhausted schedule. `budget` is the per-run inference ceiling passed to Work.
 */
export const ScheduleLimits = z
  .object({
    maxRunsPerDay: z.number().int().min(1).max(500).default(24),
    maxRunsTotal: z.number().int().min(1).max(1_000_000).optional(),
    budget: Budget.optional(),
  })
  .strict();
export type ScheduleLimits = z.infer<typeof ScheduleLimits>;

export const MissedRunPolicy = z.enum(['skip', 'run_once']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicy>;

/**
 * Creation never accepts `requireApproval: false`.
 *
 * A scheduled run has no owner watching it, so the only safe default is that any
 * purchase, outbound message, account change or infrastructure modification must
 * stop at the permission store for a scoped, single-use owner decision. There is
 * no configuration field that can disable this.
 */
export const ScheduleCreateRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    objective: z.string().min(1).max(200_000),
    timing: ScheduleTiming,
    agent: AgentId.optional(),
    model: ModelRef.optional(),
    mode: DataMode.default('cloud'),
    condition: ScheduleCondition.default({ kind: 'always' }),
    retry: ScheduleRetry.default({}),
    priority: z.number().int().min(0).max(9).default(5),
    limits: ScheduleLimits.default({}),
    missedRunPolicy: MissedRunPolicy.default('skip'),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequest>;
/** Request shape with server defaults optional, for clients that omit them. */
export type ScheduleCreateInput = z.input<typeof ScheduleCreateRequest>;

/**
 * Editing is deliberately narrower than creation.
 *
 * The agent, mode, model and objective are the execution identity that the owner
 * authorized. Excluding them means a PATCH can reschedule or change a condition
 * but can never redirect an already-authorized schedule at a different agent,
 * data mode or objective. Widening requires a new schedule and a new decision.
 */
export const ScheduleUpdateRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timing: ScheduleTiming.optional(),
    condition: ScheduleCondition.optional(),
    retry: ScheduleRetry.optional(),
    priority: z.number().int().min(0).max(9).optional(),
    limits: ScheduleLimits.optional(),
    missedRunPolicy: MissedRunPolicy.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequest>;

/** A preview is computed from the rule; it creates no receipt and no task. */
export const ScheduleUpcoming = z
  .object({
    scheduleId: ScheduleId,
    occurrences: z.array(IsoDateTime).max(20),
  })
  .strict();
export type ScheduleUpcoming = z.infer<typeof ScheduleUpcoming>;

export const Schedule = z
  .object({
    scheduleId: ScheduleId,
    name: z.string().min(1).max(120),
    objective: z.string().min(1).max(200_000),
    agent: AgentId,
    mode: DataMode,
    model: ModelRef.nullable(),
    timing: ScheduleTiming,
    condition: ScheduleCondition,
    retry: ScheduleRetry,
    priority: z.number().int().min(0).max(9),
    limits: ScheduleLimits,
    requireApproval: z.literal(true),
    missedRunPolicy: MissedRunPolicy,
    state: ScheduleState,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    nextRunAt: IsoDateTime.nullable(),
    lastRunAt: IsoDateTime.nullable(),
    lastExecutionId: z.string().min(1).max(128).nullable(),
    runsTotal: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    pausedAt: IsoDateTime.nullable(),
    cancelledAt: IsoDateTime.nullable(),
    cancelReason: z.string().max(500).nullable(),
  })
  .strict();
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleList = z.object({ schedules: z.array(Schedule) }).strict();
export type ScheduleList = z.infer<typeof ScheduleList>;

export const ScheduleExecution = z
  .object({
    executionId: z.string().min(1).max(128),
    scheduleId: ScheduleId,
    occurrenceKey: z.string().min(1).max(600),
    trigger: ScheduleTrigger,
    scheduledFor: IsoDateTime,
    state: ScheduleExecutionState,
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    taskId: TaskId.nullable(),
    conversationId: z.string().min(1).max(128),
    priority: z.number().int().min(0).max(9),
    detail: z.string().max(1_000).nullable(),
    nextAttemptAt: IsoDateTime.nullable(),
    condition: ScheduleConditionStateSchema,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    finishedAt: IsoDateTime.nullable(),
  })
  .strict();
export type ScheduleExecution = z.infer<typeof ScheduleExecution>;

export const ScheduleExecutionList = z
  .object({ executions: z.array(ScheduleExecution) })
  .strict();
export type ScheduleExecutionList = z.infer<typeof ScheduleExecutionList>;

export const ScheduleControlResult = z
  .object({
    scheduleId: ScheduleId,
    state: ScheduleState,
    /** What the engine did, not what the caller asked for. */
    outcome: z.enum(['accepted', 'already_terminal', 'unchanged']),
  })
  .strict();
export type ScheduleControlResult = z.infer<typeof ScheduleControlResult>;

export const ScheduleTriggerRequest = z
  .object({
    /**
     * The durable idempotency key for this manual occurrence. Reusing it returns
     * the existing receipt instead of starting a second run.
     */
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ScheduleTriggerRequest = z.infer<typeof ScheduleTriggerRequest>;

export const ScheduleDispatch = z
  .object({
    scheduleId: ScheduleId,
    executionId: z.string().min(1).max(128),
    /** True when the occurrence already had a durable receipt. */
    duplicate: z.boolean(),
    state: ScheduleExecutionState,
    taskId: TaskId.nullable(),
  })
  .strict();
export type ScheduleDispatch = z.infer<typeof ScheduleDispatch>;

export const ScheduleEventRequest = z
  .object({
    event: z.string().trim().min(1).max(120),
    /**
     * Required for deduplication. Two deliveries of the same key dispatch at most
     * one run per matching schedule.
     */
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type ScheduleEventRequest = z.infer<typeof ScheduleEventRequest>;

export const ScheduleEventResult = z
  .object({ event: z.string().min(1).max(120), dispatched: z.array(ScheduleDispatch) })
  .strict();
export type ScheduleEventResult = z.infer<typeof ScheduleEventResult>;

export const ScheduleNoticeKind = z.enum(['completed', 'failed', 'missed', 'refused']);
export type ScheduleNoticeKind = z.infer<typeof ScheduleNoticeKind>;

/**
 * Schedule notices are separate from Work notifications because a schedule can
 * fail before any Work task exists (budget refusal, missed occurrence). They are
 * durable, owner-scoped and written once per terminal occurrence.
 */
export const ScheduleNotice = z
  .object({
    noticeId: z.string().min(1).max(128),
    scheduleId: ScheduleId,
    executionId: z.string().min(1).max(128),
    kind: ScheduleNoticeKind,
    summary: z.string().max(500),
    createdAt: IsoDateTime,
    read: z.boolean(),
  })
  .strict();
export type ScheduleNotice = z.infer<typeof ScheduleNotice>;

export const ScheduleNoticeList = z
  .object({
    notifications: z.array(ScheduleNotice),
    unread: z.number().int().nonnegative(),
  })
  .strict();
export type ScheduleNoticeList = z.infer<typeof ScheduleNoticeList>;

/** A preview is bounded: it answers "what runs next?", not a calendar export. */
export const SCHEDULE_PREVIEW_LIMIT = 20;
