import type {
  ScheduleExecutionPatch,
  ScheduleExecutionRecord,
  ScheduleNoticeRecord,
  SchedulePatch,
  ScheduleRecord,
} from '../domain.js';
import type { ScheduleExecutionState } from '@coderax/contracts';
import type { ScheduleNoticeList } from '@coderax/contracts';

/**
 * The durable record of what the engine is allowed to run and what it already
 * ran.
 *
 * Two uniqueness rules make the store the arbiter of duplicate prevention, not
 * an in-process guard: `scheduleId` is unique, and so is an execution's
 * `executionKey`. A second replica that races the same due occurrence loses the
 * insert and must not dispatch. `update` advances a schedule only when the
 * caller's `version` still matches, so two replicas cannot both compute a new
 * next run from the same read.
 */

export type ScheduleCreateResult =
  | { ok: true; schedule: ScheduleRecord }
  | { ok: false; reason: 'exists' };

export type ScheduleUpdateResult = {
  applied: boolean;
  schedule: ScheduleRecord | null;
};

export type ExecutionCreateResult = {
  created: boolean;
  execution: ScheduleExecutionRecord;
};

export type ScheduleRepository = {
  create: (schedule: ScheduleRecord) => Promise<ScheduleCreateResult>;
  get: (scheduleId: string) => Promise<ScheduleRecord | null>;
  listByOwner: (ownerId: string) => Promise<ScheduleRecord[]>;
  /** Active schedules whose durable next run is due, priority first. */
  listDue: (input: { now: string; limit: number }) => Promise<ScheduleRecord[]>;
  listActive: () => Promise<ScheduleRecord[]>;
  /** Compare-and-swap on `version`; a stale writer applies nothing. */
  update: (input: {
    scheduleId: string;
    expectedVersion: number;
    patch: SchedulePatch;
  }) => Promise<ScheduleUpdateResult>;

  /** Returns null when all slots are occupied or a retry lost its state fence. */
  claim: (execution: ScheduleExecutionRecord, cap: number, retry: boolean) => Promise<ExecutionCreateResult | null>;
  createExecution: (execution: ScheduleExecutionRecord) => Promise<ExecutionCreateResult>;
  getExecution: (executionId: string) => Promise<ScheduleExecutionRecord | null>;
  /** Applies a patch only while the receipt is still in one of `from`. */
  updateExecution: (input: {
    executionId: string;
    observed?: Pick<ScheduleExecutionRecord, 'attempt' | 'taskId'>;
    from: readonly ScheduleExecutionState[];
    patch: ScheduleExecutionPatch;
  }) => Promise<ScheduleExecutionRecord | null>;
  dueRetries: (now: string, limit: number) => Promise<ScheduleExecutionRecord[]>;
  pendingNotices: (limit: number) => Promise<ScheduleExecutionRecord[]>;
  listPending: (scheduleId: string) => Promise<ScheduleExecutionRecord[]>;
  listExecutions: (scheduleId: string, limit: number) => Promise<ScheduleExecutionRecord[]>;
  listExecutionsByState: (
    states: readonly ScheduleExecutionState[],
    limit: number,
  ) => Promise<ScheduleExecutionRecord[]>;
  /** Receipts that represent an actual Work submission since `since`. */
  countExecutionsSince: (
    scheduleId: string,
    since: string,
    states: readonly ScheduleExecutionState[],
  ) => Promise<number>;
  countActiveExecutions: (scheduleId: string) => Promise<number>;
  countActive: () => Promise<number>;
};

export type ScheduleNoticeStore = {
  /** False when the notice already exists; notices are written at most once. */
  record: (notice: ScheduleNoticeRecord) => Promise<boolean>;
  list: (ownerId: string, limit: number) => Promise<ScheduleNoticeList>;
  markAllRead: (ownerId: string) => Promise<void>;
};

export const ONGOING_EXECUTION_STATES: readonly ScheduleExecutionState[] = [
  'claimed',
  'dispatched',
];

export const RUN_EXECUTION_STATES: readonly ScheduleExecutionState[] = [
  'claimed',
  'dispatched',
  'retry_wait',
  'completed',
  'failed',
  'cancelled',
  // A refusal consumed an admission attempt. Counting it makes an unavailable
  // agent exhaust the daily budget and park the schedule, instead of producing a
  // refusal notice on every recurrence forever.
  'refused',
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byPriorityThenDue(left: ScheduleRecord, right: ScheduleRecord): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  return (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '');
}

function byNewest(left: ScheduleExecutionRecord, right: ScheduleExecutionRecord): number {
  return right.createdAt.localeCompare(left.createdAt);
}

/**
 * Process-local store. It has the durability of one process, which is why the
 * composition root selects the Mongo implementation whenever scheduling must
 * survive a restart or be shared by replicas. Its read-modify-writes complete
 * without an intervening await, so it is atomic inside this process.
 */
export function createScheduleRepository(): ScheduleRepository {
  const schedules = new Map<string, ScheduleRecord>();
  const executions = new Map<string, ScheduleExecutionRecord>();
  const byExecutionKey = new Map<string, string>();

  return {
    create: async (schedule) => {
      if (schedules.has(schedule.scheduleId)) return { ok: false, reason: 'exists' };
      schedules.set(schedule.scheduleId, clone(schedule));
      return { ok: true, schedule: clone(schedule) };
    },

    get: async (scheduleId) => {
      const found = schedules.get(scheduleId);
      return found ? clone(found) : null;
    },

    listByOwner: async (ownerId) =>
      [...schedules.values()]
        .filter((schedule) => schedule.ownerId === ownerId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone),

    listDue: async ({ now, limit }) => {
      const bounded = Math.min(Math.max(1, limit) * 4, 1_000);
      return [...schedules.values()]
        .filter(
          (schedule) =>
            schedule.state === 'active' &&
            schedule.nextRunAt !== null &&
            schedule.nextRunAt.localeCompare(now) <= 0,
        )
        .sort(byPriorityThenDue)
        .slice(0, bounded)
        .map(clone);
    },

    listActive: async () =>
      [...schedules.values()]
        .filter((schedule) => schedule.state === 'active')
        .sort(byPriorityThenDue)
        .map(clone),

    update: async ({ scheduleId, expectedVersion, patch }) => {
      const schedule = schedules.get(scheduleId);
      if (!schedule || schedule.version !== expectedVersion) {
        return { applied: false, schedule: null };
      }
      const next: ScheduleRecord = {
        ...schedule,
        ...clone(patch),
        version: schedule.version + 1,
      };
      schedules.set(scheduleId, next);
      return { applied: true, schedule: clone(next) };
    },

    claim: async (record, cap, retry) => {
      const existingId = byExecutionKey.get(record.executionKey);
      const existing = existingId && executions.get(existingId);
      if (existing && !retry) return { created: false, execution: clone(existing) };
      if (retry && (!existing || existing.state !== 'retry_wait' || existing.attempt !== record.attempt)) return null;
      const active = [...executions.values()].filter(e => e.state === 'claimed' || e.state === 'dispatched');
      if (active.length >= cap || active.some(e => e.scheduleId === record.scheduleId)) return null;
      executions.set(record.executionId, clone(record));
      byExecutionKey.set(record.executionKey, record.executionId);
      return { created: true, execution: clone(record) };
    },

    createExecution: async (execution) => {
      const existingId = byExecutionKey.get(execution.executionKey);
      if (existingId) {
        const existing = executions.get(existingId);
        if (existing) return { created: false, execution: clone(existing) };
      }
      executions.set(execution.executionId, clone(execution));
      byExecutionKey.set(execution.executionKey, execution.executionId);
      return { created: true, execution: clone(execution) };
    },

    getExecution: async (executionId) => {
      const found = executions.get(executionId);
      return found ? clone(found) : null;
    },

    updateExecution: async ({ executionId, from, observed, patch }) => {
      const execution = executions.get(executionId);
      if (!execution || !from.includes(execution.state) || (observed && (observed.attempt !== execution.attempt || observed.taskId !== execution.taskId))) return null;
      const next: ScheduleExecutionRecord = { ...execution, ...clone(patch) };
      executions.set(executionId, next);
      return clone(next);
    },

    dueRetries: async (now, limit) => [...executions.values()]
      .filter(e => e.state === 'retry_wait' && e.nextAttemptAt !== null && e.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt!.localeCompare(b.nextAttemptAt!))
      .slice(0, limit).map(clone),
    pendingNotices: async limit => [...executions.values()].filter(e => e.noticePending).slice(0, limit).map(clone),
    listPending: async (scheduleId) => [...executions.values()].filter(e => e.scheduleId === scheduleId && ['retry_wait', 'claimed', 'dispatched'].includes(e.state)).map(clone),

    listExecutions: async (scheduleId, limit) =>
      [...executions.values()]
        .filter((execution) => execution.scheduleId === scheduleId)
        .sort(byNewest)
        .slice(0, Math.max(0, limit))
        .map(clone),

    listExecutionsByState: async (states, limit) =>
      [...executions.values()]
        .filter((execution) => states.includes(execution.state))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, Math.max(0, limit))
        .map(clone),

    countExecutionsSince: async (scheduleId, since, states) =>
      [...executions.values()].filter(
        (execution) =>
          execution.scheduleId === scheduleId &&
          execution.createdAt.localeCompare(since) >= 0 &&
          states.includes(execution.state),
      ).length,

    countActiveExecutions: async (scheduleId) =>
      [...executions.values()].filter(
        (execution) =>
          execution.scheduleId === scheduleId &&
          ONGOING_EXECUTION_STATES.includes(execution.state),
      ).length,

    countActive: async () =>
      [...executions.values()].filter((execution) =>
        ONGOING_EXECUTION_STATES.includes(execution.state),
      ).length,
  };
}

export function createScheduleNoticeStore(): ScheduleNoticeStore {
  const notices = new Map<string, ScheduleNoticeRecord>();

  function toList(ownerId: string, limit: number): ScheduleNoticeList {
    const owned = [...notices.values()]
      .filter((notice) => notice.ownerId === ownerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      // Owner identity stays in the store; it is not part of the wire contract.
      notifications: owned.slice(0, Math.max(0, limit)).map((notice) => ({
        noticeId: notice.noticeId,
        scheduleId: notice.scheduleId,
        executionId: notice.executionId,
        kind: notice.kind,
        summary: notice.summary,
        createdAt: notice.createdAt,
        read: notice.read,
      })),
      unread: owned.filter((notice) => !notice.read).length,
    };
  }

  return {
    record: async (notice) => {
      if (notices.has(notice.noticeId)) return false;
      notices.set(notice.noticeId, clone(notice));
      return true;
    },
    list: async (ownerId, limit) => toList(ownerId, limit),
    markAllRead: async (ownerId) => {
      for (const [id, notice] of notices) {
        if (notice.ownerId === ownerId && !notice.read) {
          notices.set(id, { ...notice, read: true });
        }
      }
    },
  };
}
