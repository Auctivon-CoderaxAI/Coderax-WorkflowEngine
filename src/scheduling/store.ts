import { randomUUID } from 'node:crypto';
import type { AgentId, DataMode } from '@coderax/contracts';
import type { ScheduleExecutionRecord, ScheduleRecord } from '../domain.js';
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
/** Executions retained per schedule; older firings fall off the end. */
export const MAX_SCHEDULE_EXECUTIONS = 100;

export const DEFAULT_SCHEDULE_EXECUTION_LIMIT = 50;

/** Editable parts of a schedule. `enabled` belongs to pause/resume, not here. */
export type ScheduleUpdate = {
  objective?: string;
  agent?: AgentId;
  mode?: DataMode;
  intervalMs?: number;
  startAt?: string;
};

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
  /** Applies the editable fields; returns null when the owner does not have it. */
  update: (input: {
    ownerId: string;
    scheduleId: string;
    patch: ScheduleUpdate;
  }) => ScheduleRecord | null;
  setEnabled: (input: {
    ownerId: string;
    scheduleId: string;
    enabled: boolean;
  }) => ScheduleRecord | null;
  remove: (ownerId: string, scheduleId: string) => boolean;
  due: (now: Date, limit?: number) => ScheduleRecord[];
  /** Newest first. Null when the schedule does not exist for the owner. */
  executions: (input: {
    ownerId: string;
    scheduleId: string;
    limit: number;
  }) => ScheduleExecutionRecord[] | null;
  markRun: (input: {
    scheduleId: string;
    at: string;
    taskId: string;
    nextRunAt: string;
  }) => void;
  markSkipped: (input: {
    scheduleId: string;
    at: string;
    nextRunAt: string;
    code: string;
  }) => void;
};

export function createScheduleStore(input: { clock: Clock }): ScheduleStore {
  const schedules = new Map<string, ScheduleRecord>();

  function nextFrom(baseMs: number, intervalMs: number): string {
    return new Date(baseMs + intervalMs).toISOString();
  }

  /**
   * The next firing for an enabled schedule. A requested start is honoured only
   * while it is in the future; otherwise the cadence restarts a full interval
   * from now, so a stale `startAt` cannot produce an immediate firing.
   */
  function scheduleNext(nowMs: number, intervalMs: number, startAt: string | null): string {
    const requested = startAt ? new Date(startAt).getTime() : Number.NaN;
    return Number.isFinite(requested) && requested > nowMs
      ? new Date(requested).toISOString()
      : nextFrom(nowMs, intervalMs);
  }

  function recordExecution(record: ScheduleRecord, execution: ScheduleExecutionRecord): void {
    record.executions.unshift(execution);
    if (record.executions.length > MAX_SCHEDULE_EXECUTIONS) {
      record.executions.length = MAX_SCHEDULE_EXECUTIONS;
    }
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
        nextRunAt: enabled ? scheduleNext(now.getTime(), intervalMs, startAt) : null,
        pendingStartAt: null,
        lastRunAt: null,
        lastTaskId: null,
        runs: 0,
        skipped: 0,
        executions: [],
      };
      schedules.set(record.scheduleId, record);
      return { ...record, executions: [...record.executions] };
    },
    list: (ownerId) =>
      [...schedules.values()]
        .filter((record) => record.ownerId === ownerId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((record) => ({ ...record, executions: [...record.executions] })),
    get: (ownerId, scheduleId) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      return { ...record, executions: [...record.executions] };
    },
    update: ({ ownerId, scheduleId, patch }) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      const now = input.clock.now();
      if (patch.objective !== undefined) record.objective = patch.objective;
      if (patch.agent !== undefined) record.agent = patch.agent;
      if (patch.mode !== undefined) record.mode = patch.mode;
      const cadenceChanged = patch.intervalMs !== undefined && patch.intervalMs !== record.intervalMs;
      if (patch.intervalMs !== undefined) record.intervalMs = patch.intervalMs;

      if (patch.startAt !== undefined) {
        if (record.enabled) {
          record.nextRunAt = scheduleNext(now.getTime(), record.intervalMs, patch.startAt);
          record.pendingStartAt = null;
        } else {
          // A paused schedule remembers the requested start until it resumes.
          record.pendingStartAt = patch.startAt;
        }
      } else if (cadenceChanged && record.enabled) {
        // A new interval starts now: keeping the old slot would fire early
        // relative to the cadence the owner just asked for.
        record.nextRunAt = nextFrom(now.getTime(), record.intervalMs);
      }

      record.updatedAt = now.toISOString();
      schedules.set(scheduleId, record);
      return { ...record, executions: [...record.executions] };
    },
    setEnabled: ({ ownerId, scheduleId, enabled }) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      // Repeating the same verb is a no-op, not a reason to move the slot.
      if (record.enabled === enabled) {
        return { ...record, executions: [...record.executions] };
      }
      const now = input.clock.now();
      record.enabled = enabled;
      record.updatedAt = now.toISOString();
      // A resumed schedule starts from its requested start or a full interval
      // from now: it must not fire immediately for every slot it missed.
      record.nextRunAt = enabled
        ? scheduleNext(now.getTime(), record.intervalMs, record.pendingStartAt)
        : null;
      record.pendingStartAt = null;
      schedules.set(scheduleId, record);
      return { ...record, executions: [...record.executions] };
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
          (record) =>
            record.enabled &&
            record.nextRunAt !== null &&
            new Date(record.nextRunAt).getTime() <= now.getTime(),
        )
        .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''))
        .slice(0, limit)
        .map((record) => ({ ...record, executions: [...record.executions] })),
    executions: ({ ownerId, scheduleId, limit }) => {
      const record = schedules.get(scheduleId);
      if (!record || record.ownerId !== ownerId) return null;
      return record.executions.slice(0, Math.max(1, limit)).map((entry) => ({ ...entry }));
    },
    markRun: ({ scheduleId, at, taskId, nextRunAt }) => {
      const record = schedules.get(scheduleId);
      if (!record) return;
      record.lastRunAt = at;
      record.lastTaskId = taskId;
      record.nextRunAt = nextRunAt;
      record.runs += 1;
      record.updatedAt = at;
      recordExecution(record, { at, outcome: 'submitted', nextRunAt, taskId, code: null });
      schedules.set(scheduleId, record);
    },
    markSkipped: ({ scheduleId, at, nextRunAt, code }) => {
      const record = schedules.get(scheduleId);
      if (!record) return;
      record.skipped += 1;
      record.updatedAt = at;
      record.nextRunAt = nextRunAt;
      recordExecution(record, { at, outcome: 'skipped', nextRunAt, taskId: null, code });
      schedules.set(scheduleId, record);
    },
  };
}
