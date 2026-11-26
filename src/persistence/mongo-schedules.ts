import type {
  ScheduleExecutionPatch,
  ScheduleExecutionRecord,
  ScheduleNoticeRecord,
  ScheduleRecord,
} from '../domain.js';
import type { ScheduleNoticeList } from '@coderax/contracts';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';
import type {
  ExecutionCreateResult,
  ScheduleCreateResult,
  ScheduleNoticeStore,
  ScheduleRepository,
  ScheduleUpdateResult,
} from './schedules.js';

/**
 * Durable schedules, execution receipts and schedule notices.
 *
 * Each method is one atomic database operation, and the two indexes that matter
 * are unique: `scheduleId` and `executionKey`. That is what makes the database —
 * not a replica's memory — the arbiter when two engines wake at the same
 * instant. Times are stored as ISO-8601 UTC strings; every timestamp this code
 * writes comes from `toISOString()`, so lexicographic comparison and range
 * filters are chronological.
 */

function strip(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy._id;
  delete copy.slot;
  delete copy.occupiesSlot;
  return copy;
}

function defined(patch: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );
}

function toSchedule(document: Record<string, unknown>): ScheduleRecord {
  if (
    typeof document.scheduleId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.state !== 'string' ||
    typeof document.version !== 'number'
  ) {
    throw new Error('A stored schedule row is malformed.');
  }
  return strip(document) as unknown as ScheduleRecord;
}

function toExecution(document: Record<string, unknown>): ScheduleExecutionRecord {
  if (
    typeof document.executionId !== 'string' ||
    typeof document.executionKey !== 'string' ||
    typeof document.scheduleId !== 'string' ||
    typeof document.state !== 'string'
  ) {
    throw new Error('A stored schedule execution row is malformed.');
  }
  return strip(document) as unknown as ScheduleExecutionRecord;
}

function toNotice(document: Record<string, unknown>): ScheduleNoticeRecord {
  if (
    typeof document.noticeId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.kind !== 'string'
  ) {
    throw new Error('A stored schedule notice row is malformed.');
  }
  return strip(document) as unknown as ScheduleNoticeRecord;
}

export async function ensureScheduleIndexes(input: {
  schedules: MongoCollectionLike;
  executions: MongoCollectionLike;
  notices: MongoCollectionLike;
}): Promise<void> {
  await input.schedules.createIndex(
    { scheduleId: 1 },
    { unique: true, name: 'schedule_id' },
  );
  await input.schedules.createIndex(
    { state: 1, nextRunAt: 1 },
    { name: 'schedule_due' },
  );
  await input.schedules.createIndex(
    { ownerId: 1, createdAt: -1 },
    { name: 'schedule_owner_created' },
  );
  await input.executions.createIndex(
    { executionKey: 1 },
    { unique: true, name: 'execution_key' },
  );
  await input.executions.createIndex(
    { scheduleId: 1, createdAt: -1 },
    { name: 'execution_schedule_created' },
  );
  await input.executions.createIndex(
    { state: 1, createdAt: 1 },
    { name: 'execution_state_created' },
  );
  await input.executions.createIndex({ state: 1, nextAttemptAt: 1 }, { name: 'execution_due_retry' });
  await input.executions.createIndex({ noticePending: 1 }, {
    name: 'execution_pending_notice', partialFilterExpression: { noticePending: true },
  });
  for (const field of ['slot', 'scheduleId']) {
    await input.executions.createIndex({ [field]: 1 }, {
      unique: true, name: `execution_occupied_${field}`, partialFilterExpression: { occupiesSlot: true },
    });
  }
  await input.notices.createIndex(
    { noticeId: 1 },
    { unique: true, name: 'notice_id' },
  );
  await input.notices.createIndex(
    { ownerId: 1, createdAt: -1 },
    { name: 'notice_owner_created' },
  );
}

export function createMongoScheduleRepository(input: {
  schedules: MongoCollectionLike;
  executions: MongoCollectionLike;
}): ScheduleRepository {
  const { schedules, executions } = input;

  return {
    create: async (schedule): Promise<ScheduleCreateResult> => {
      try {
        await schedules.insertOne({ ...schedule });
        return { ok: true, schedule };
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, reason: 'exists' };
        throw error;
      }
    },

    get: async (scheduleId) => {
      const document = await schedules.findOne({ scheduleId });
      return document ? toSchedule(document) : null;
    },

    listByOwner: async (ownerId) => {
      const documents = await schedules.find({ ownerId }).sort({ createdAt: -1 }).toArray();
      return documents.map(toSchedule);
    },

    listDue: async ({ now, limit }) => {
      const bounded = Math.min(Math.max(1, limit) * 4, 1_000);
      const documents = await schedules
        .find({ state: 'active', nextRunAt: { $lte: now } })
        .sort({ nextRunAt: 1 })
        .limit(bounded)
        .toArray();
      return documents
        .map(toSchedule)
        .sort((left, right) =>
          left.priority === right.priority
            ? (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '')
            : right.priority - left.priority,
        )
        .slice(0, Math.max(1, limit));
    },

    listActive: async () => {
      const documents = await schedules.find({ state: 'active' }).sort({ nextRunAt: 1 }).toArray();
      return documents.map(toSchedule);
    },

    update: async ({ scheduleId, expectedVersion, patch }): Promise<ScheduleUpdateResult> => {
      const updated = await schedules.findOneAndUpdate(
        { scheduleId, version: expectedVersion },
        { $set: { ...defined(patch), version: expectedVersion + 1 } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated
        ? { applied: true, schedule: toSchedule(updated) }
        : { applied: false, schedule: null };
    },

    claim: async (record, cap, retry) => {
      // Receipts written before slot indexes existed must drain before their
      // capacity can be reused. Also account for slots above a lowered cap.
      const active = await executions.find({ state: { $in: ['claimed', 'dispatched'] } }).toArray();
      const outside = active.filter(e => e.occupiesSlot !== true || Number(e.slot) >= cap);
      if (outside.length) return null;
      for (let slot = 0; slot < cap; slot++) {
        try {
          const fields = { ...record, occupiesSlot: true, slot };
          if (retry) {
            const updated = await executions.findOneAndUpdate(
              { executionId: record.executionId, state: 'retry_wait', attempt: record.attempt },
              { $set: fields }, { returnDocument: 'after', includeResultMetadata: false },
            );
            if (!updated) return null;
          } else {
            await executions.insertOne(fields);
          }
          return { created: true, execution: record };
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          if (!retry) {
            const existing = await executions.findOne({ executionKey: record.executionKey });
            if (existing) return { created: false, execution: toExecution(existing) };
          }
        }
      }
      return null;
    },

    createExecution: async (execution): Promise<ExecutionCreateResult> => {
      try {
        await executions.insertOne({ ...execution });
        return { created: true, execution };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existing = await executions.findOne({ executionKey: execution.executionKey });
        if (!existing) throw error;
        return { created: false, execution: toExecution(existing) };
      }
    },

    getExecution: async (executionId) => {
      const document = await executions.findOne({ executionId });
      return document ? toExecution(document) : null;
    },

    updateExecution: async ({ executionId, from, observed, patch }) => {
      const updated = await executions.findOneAndUpdate(
        { executionId, state: { $in: [...from] }, ...(observed && { attempt: observed.attempt, taskId: observed.taskId }) },
        { $set: { ...defined(patch as ScheduleExecutionPatch),
          ...(patch.state && !['claimed', 'dispatched'].includes(patch.state) ? { occupiesSlot: false } : {}),
        } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated ? toExecution(updated) : null;
    },

    dueRetries: async (now, limit) => (await executions.find({
      state: 'retry_wait', nextAttemptAt: { $lte: now },
    }).sort({ nextAttemptAt: 1 }).limit(limit).toArray()).map(toExecution),
    pendingNotices: async limit => (await executions.find({ noticePending: true }).limit(limit).toArray()).map(toExecution),
    listPending: async (scheduleId) => (await executions.find({
      scheduleId, state: { $in: ['retry_wait', 'claimed', 'dispatched'] },
    }).toArray()).map(toExecution),

    listExecutions: async (scheduleId, limit) => {
      const documents = await executions
        .find({ scheduleId })
        .sort({ createdAt: -1 })
        .limit(Math.max(0, limit))
        .toArray();
      return documents.map(toExecution);
    },

    listExecutionsByState: async (states, limit) => {
      const documents = await executions
        .find({ state: { $in: [...states] } })
        .sort({ createdAt: 1 })
        .limit(Math.max(0, limit))
        .toArray();
      return documents.map(toExecution);
    },

    countExecutionsSince: async (scheduleId, since, states) => {
      const documents = await executions
        .find({ scheduleId, createdAt: { $gte: since }, state: { $in: [...states] } })
        .toArray();
      return documents.length;
    },

    countActiveExecutions: async (scheduleId) => {
      const documents = await executions
        .find({ scheduleId, state: { $in: ['claimed', 'dispatched'] } })
        .toArray();
      return documents.length;
    },

    countActive: async () => {
      const documents = await executions
        .find({ state: { $in: ['claimed', 'dispatched'] } })
        .toArray();
      return documents.length;
    },
  };
}

export function createMongoScheduleNoticeStore(
  collection: MongoCollectionLike,
): ScheduleNoticeStore {
  function toList(ownerId: string, limit: number): Promise<ScheduleNoticeList> {
    return (async () => {
      const documents = await collection
        .find({ ownerId })
        .sort({ createdAt: -1 })
        .limit(Math.max(0, limit))
        .toArray();
      const owned = documents.map(toNotice);
      const all = await collection.find({ ownerId }).toArray();
      return {
        notifications: owned.map((notice) => ({
          noticeId: notice.noticeId,
          scheduleId: notice.scheduleId,
          executionId: notice.executionId,
          kind: notice.kind,
          summary: notice.summary,
          createdAt: notice.createdAt,
          read: notice.read,
        })),
        unread: all.map(toNotice).filter((notice) => !notice.read).length,
      };
    })();
  }

  return {
    record: async (notice) => {
      try {
        await collection.insertOne({ ...notice });
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },

    list: async (ownerId, limit) => toList(ownerId, limit),

    markAllRead: async (ownerId) => {
      const unread = await collection.find({ ownerId, read: false }).toArray();
      for (const document of unread) {
        await collection.updateOne(
          { noticeId: toNotice(document).noticeId, ownerId },
          { $set: { read: true } },
          { upsert: false },
        );
      }
    },
  };
}
