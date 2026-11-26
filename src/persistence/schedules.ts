import type { ScheduleRecord } from '../domain.js';

/**
 * Durable schedules.
 *
 * A schedule is written before it is due and read by a tick that is independent
 * of any client connection. `due` is the only method that crosses owners: the
 * ticker asks for every due row, while every owner-facing read is scoped.
 */
export type ScheduleRepository = {
  create: (record: ScheduleRecord) => Promise<{ ok: true } | { ok: false; reason: 'limit' }>;
  get: (ownerId: string, scheduleId: string) => Promise<ScheduleRecord | null>;
  list: (ownerId: string) => Promise<ScheduleRecord[]>;
  /** Due rows across owners, oldest first. The ticker is engine-internal. */
  due: (nowIso: string, limit: number) => Promise<ScheduleRecord[]>;
  update: (record: ScheduleRecord) => Promise<boolean>;
  activeCount: (ownerId: string) => Promise<number>;
};

export const MAX_ACTIVE_SCHEDULES = 50;

export function createScheduleRepository(): ScheduleRepository {
  const schedules = new Map<string, ScheduleRecord>();

  function owned(record: ScheduleRecord): ScheduleRecord {
    return { ...record };
  }

  return {
    create: async (record) => {
      const active = [...schedules.values()].filter(
        (entry) => entry.ownerId === record.ownerId && entry.state === 'scheduled',
      ).length;
      if (active >= MAX_ACTIVE_SCHEDULES) {
        return { ok: false, reason: 'limit' };
      }
      schedules.set(record.scheduleId, owned(record));
      return { ok: true };
    },
    get: async (ownerId, scheduleId) => {
      const record = schedules.get(scheduleId);
      return record && record.ownerId === ownerId ? owned(record) : null;
    },
    list: async (ownerId) =>
      [...schedules.values()]
        .filter((entry) => entry.ownerId === ownerId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(owned),
    due: async (nowIso, limit) =>
      [...schedules.values()]
        .filter(
          (entry) =>
            entry.state === 'scheduled' &&
            entry.nextRunAt !== null &&
            entry.nextRunAt <= nowIso,
        )
        .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''))
        .slice(0, Math.max(0, limit))
        .map(owned),
    update: async (record) => {
      const existing = schedules.get(record.scheduleId);
      if (!existing || existing.ownerId !== record.ownerId) return false;
      schedules.set(record.scheduleId, owned(record));
      return true;
    },
    activeCount: async (ownerId) =>
      [...schedules.values()].filter(
        (entry) => entry.ownerId === ownerId && entry.state === 'scheduled',
      ).length,
  };
}
