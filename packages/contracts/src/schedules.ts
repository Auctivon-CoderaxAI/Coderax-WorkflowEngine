import { z } from 'zod';
import { AgentId, DataMode, IsoDateTime, ModelRef, ScheduleId } from './primitives.js';
import { Budget } from './models.js';

/**
 * Durable schedules.
 *
 * A schedule is an owner-authorized promise to submit a Work task at a time, not
 * a timer held in a client. It is stored by the engine, so closing the browser or
 * the terminal does not cancel it. Repeating schedules are bounded by
 * `intervalMs` and are rescheduled only after the engine has recorded the
 * submission; a busy conversation leaves the schedule due and retries instead of
 * dropping the run.
 */
export const ScheduleState = z.enum(['scheduled', 'submitted', 'cancelled', 'failed']);
export type ScheduleState = z.infer<typeof ScheduleState>;

export const ScheduleCreateRequest = z
  .object({
    objective: z.string().min(1).max(200_000),
    /** Absolute time; a client that wants "in ten minutes" computes it itself. */
    runAt: IsoDateTime,
    /** Repeat interval after each submission; omitted means one-shot. */
    intervalMs: z.number().int().min(1_000).max(31_536_000_000).optional(),
    agent: AgentId.optional(),
    model: ModelRef.optional(),
    mode: DataMode.default('cloud'),
    budget: Budget.optional(),
    requireApproval: z.boolean().default(true),
  })
  .strict();
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequest>;

export const Schedule = z
  .object({
    scheduleId: ScheduleId,
    objective: z.string().min(1).max(200_000),
    agent: AgentId,
    mode: DataMode,
    model: ModelRef.optional(),
    requireApproval: z.boolean(),
    state: ScheduleState,
    runAt: IsoDateTime,
    intervalMs: z.number().int().min(1_000).optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** When a repeating schedule is next due; absent once it is settled. */
    nextRunAt: IsoDateTime.optional(),
    /** The Work task the last accepted submission created. */
    lastTaskId: z.string().min(1).max(128).optional(),
    /** A stable, user-safe reason the last submission failed. */
    lastError: z.string().max(500).optional(),
  })
  .strict();
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleList = z.object({ schedules: z.array(Schedule) }).strict();
export type ScheduleList = z.infer<typeof ScheduleList>;

export const ScheduleControlResult = z
  .object({
    scheduleId: ScheduleId,
    state: ScheduleState,
    outcome: z.enum(['accepted', 'already_terminal', 'not_found']),
  })
  .strict();
export type ScheduleControlResult = z.infer<typeof ScheduleControlResult>;
