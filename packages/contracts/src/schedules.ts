import { z } from 'zod';
import {
  AgentId,
  ConversationId,
  DataMode,
  IsoDateTime,
  ScheduleId,
  TaskId,
} from './primitives.js';

/**
 * A schedule is a durable instruction to submit Work on an interval.
 *
 * It is not a live run and it holds no lease between firings: when a schedule is
 * due the engine submits a normal Work task, which then obeys every execution
 * invariant. A missed firing is reported as a skipped tick rather than silently
 * backfilled, and a schedule whose conversation already has a live run waits for
 * the next interval instead of queueing behind it.
 */

/** One minute. A sub-minute schedule would be a busy loop, not a schedule. */
export const SCHEDULE_MIN_INTERVAL_MS = 60_000;
export const SCHEDULE_MAX_INTERVAL_MS = 604_800_000;

export const ScheduleCreateRequest = z
  .object({
    objective: z.string().min(1).max(200_000),
    /** Omitted means the engine's default agent, resolved at submission time. */
    agent: AgentId.optional(),
    mode: DataMode.default('cloud'),
    intervalMs: z.number().int().min(SCHEDULE_MIN_INTERVAL_MS).max(SCHEDULE_MAX_INTERVAL_MS),
    /** Defaults to now + interval; never in the past. */
    startAt: IsoDateTime.optional(),
    enabled: z.boolean().default(true),
    /** Reuse one conversation for every firing, or a fresh one per firing. */
    conversationId: ConversationId.optional(),
  })
  .strict();
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequest>;
export type ScheduleCreateRequestInput = z.input<typeof ScheduleCreateRequest>;

export const Schedule = z
  .object({
    scheduleId: ScheduleId,
    objective: z.string().min(1).max(200_000),
    agent: AgentId,
    mode: DataMode,
    intervalMs: z.number().int().positive(),
    enabled: z.boolean(),
    conversationId: ConversationId.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** Absent while a schedule is paused. */
    nextRunAt: IsoDateTime.optional(),
    lastRunAt: IsoDateTime.optional(),
    lastTaskId: TaskId.optional(),
    runs: z.number().int().nonnegative(),
    /** Firings skipped because the conversation was busy or a tick overlapped. */
    skipped: z.number().int().nonnegative(),
  })
  .strict();
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleList = z.object({ schedules: z.array(Schedule) }).strict();
export type ScheduleList = z.infer<typeof ScheduleList>;

export const ScheduleAction = z.enum(['pause', 'resume']);
export type ScheduleAction = z.infer<typeof ScheduleAction>;

export const ScheduleControlRequest = z.object({ action: ScheduleAction }).strict();
export type ScheduleControlRequest = z.infer<typeof ScheduleControlRequest>;

export const ScheduleControlResult = z
  .object({
    scheduleId: ScheduleId,
    enabled: z.boolean(),
    nextRunAt: IsoDateTime.optional(),
    runs: z.number().int().nonnegative(),
    /** What the engine did, not what the caller asked for. */
    outcome: z.enum(['accepted', 'unchanged']),
  })
  .strict();
export type ScheduleControlResult = z.infer<typeof ScheduleControlResult>;

export const ScheduleRemoval = z
  .object({
    scheduleId: ScheduleId,
    outcome: z.enum(['deleted', 'not_found']),
  })
  .strict();
export type ScheduleRemoval = z.infer<typeof ScheduleRemoval>;
