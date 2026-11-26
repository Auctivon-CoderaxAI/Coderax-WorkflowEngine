import { randomUUID } from 'node:crypto';
import type { AgentId, DataMode } from '@coderax/contracts';
import type { ScheduleRecord } from '../domain.js';
import type { Clock } from '../support/clock.js';

/**
 * Schedules are durable instructions, not live runs.
 *
 * A firing submits ordinary Work, so nothing here may start a run, hold a lease
 * or settle a task: the schedule only decides *when* to ask. `nextRunAt` always
 * moves forward from the firing time rather than from the previous slot, so a
 * paused or busy interval produces one skipped firing instead of a catch-up
 * storm of tasks the owner never asked for.
 */

/** How often the engine looks for a due schedule. */
export const SCHEDULE_TICK_MS = 5_000;
const MAX_SCHEDULES_PER_TICK = 10;

export type ScheduleStore = {
  create: (input: {
    ownerId: string;
    objective: string;
    agent: AgentId;
    mode: DataMode;
    intervalMs: number;
    enabled: boolean;
    startAt: string | null;
    conversationId: string | null;
  }) => ScheduleRecord;
  list: (ownerId: string) => ScheduleRecord[];
  get: (ownerId: string, scheduleId: string) => ScheduleRecord | null;
  setEnabled: (input: {
    ownerId: string;
    scheduleId: string;
    enabled: boolean;
  }) => ScheduleRecord | null;
  remove: (ownerId: string, scheduleId: string) => boolean;
  due: (now: Date, limit?: number) => ScheduleRecord[];
  markRun: (input: {
    scheduleId: string;
    at: string;
    taskId: string;
    nextRunAt: string;
  }) => void;
  markSkipped: (input: { scheduleId: string; at: string; nextRunAt: string }) => void;
};

export function createScheduleStore(input: { clock: Clock }): ScheduleStore {
  const schedules = new Map<string, ScheduleRecord>();

  function nextFrom(baseMs: number, intervalMs: number): string {
    return new Date(baseMs + intervalMs).toISOString();
  }

  return {
    create: ({
      ownerId,
      objective,
      agent,
      mode,
      intervalMs,
      enabled,
      startAt,
      conversationId,
    }) => {
      const now = input.clock.now();
      const requested = startAt ? new Date(startAt).getTime() : Number.NaN;
      const first = Number.isFinite(requested) && requested > now.getTime()
        ? new Date(requested).toISOString()
        : nextFrom(now.getTime(), intervalMs);
      const record: ScheduleRecord = {
        scheduleId: `sch_${randomUUID()}`,
        ownerId,
        objective,
        agent,
        mode,
        intervalMs,
        enabled,
        conversationId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        nextRunAt: enabled ? first : null,
        lastRunAt: null,
        lastTaskId: null,
        runs: 0,
        skipped: 0,
      };
      schedules.set(record.scheduleId, record);
      return { ...record };
    },
    list: (ownerId) =>
      [...schedules.values()]
        .filter((record) => record.ownerId === ownerId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((record) => ({ ...record })),
    get: (ownerId, scheduleId) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      return { ...record };
    },
    setEnabled: ({ ownerId, scheduleId, enabled }) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      const now = input.clock.now();
      record.enabled = enabled;
      record.updatedAt = now.toISOString();
      // A resumed schedule starts a full interval from now: it must not fire
      // immediately for every slot it missed while paused.
      record.nextRunAt = enabled ? nextFrom(now.getTime(), record.intervalMs) : null;
      schedules.set(scheduleId, record);
      return { ...record };
    },
    remove: (ownerId, scheduleId) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return false;
      schedules.delete(scheduleId);
      return true;
    },
    due: (now, limit = MAX_SCHEDULES_PER_TICK) =>
      [...schedules.values()]
        .filter(
          (record) => record.enabled && record.nextRunAt !== null &&
            new Date(record.nextRunAt).getTime() <= now.getTime(),
        )
        .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''))
        .slice(0, limit)
        .map((record) => ({ ...record })),
    markRun: ({ scheduleId, at, taskId, nextRunAt }) => {
      const record = schedules.get(scheduleId);
      if (!record) return;
      record.lastRunAt = at;
      record.lastTaskId = taskId;
      record.nextRunAt = nextRunAt;
      record.runs += 1;
      record.updatedAt = at;
      schedules.set(scheduleId, record);
    },
    markSkipped: ({ scheduleId, at, nextRunAt }) => {
      const record = schedules.get(scheduleId);
      if (!record) return;
      record.skipped += 1;
      record.updatedAt = at;
      record.nextRunAt = nextRunAt;
      schedules.set(scheduleId, record);
    },
  };
}
