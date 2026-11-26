import type { CheckpointRecord } from '../domain.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Checkpoints are history, not a second source of run state.
 *
 * The task row carries the checkpoint a resume reads. This append-only log keeps
 * what the engine actually observed at each step, so recovery evidence survives
 * a settlement that later replaces the task's checkpoint, and a supervisor can
 * see how a run progressed without replaying the transcript.
 */
export type CheckpointPageInput = {
  taskId: string;
  limit?: number;
  cursor?: string;
};

export type CheckpointPage = {
  checkpoints: CheckpointRecord[];
  nextCursor?: string;
};

export type CheckpointStore = {
  append: (record: CheckpointRecord) => Promise<void>;
  latest: (taskId: string) => Promise<CheckpointRecord | null>;
  list: (input: CheckpointPageInput) => Promise<CheckpointPage>;
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
  prune: (before: string, limit: number) => Promise<number>;
};

function ascending(left: CheckpointRecord, right: CheckpointRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.checkpointId.localeCompare(right.checkpointId);
}

export function createCheckpointStore(): CheckpointStore {
  const records: CheckpointRecord[] = [];
  return {
    append: async (record) => {
      if (records.some((entry) => entry.checkpointId === record.checkpointId)) return;
      records.push({ ...record });
    },
    latest: async (taskId) =>
      [...records].filter((entry) => entry.taskId === taskId).sort(ascending).at(-1) ?? null,
    list: async ({ taskId, limit, cursor }) => {
      const bounded = clampLimit(limit, 100);
      const ordered = records.filter((entry) => entry.taskId === taskId).sort(ascending);
      const parsed = cursor ? decodeCursor(cursor) : null;
      const after = parsed
        ? ordered.filter(
            (entry) =>
              entry.createdAt > parsed.at ||
              (entry.createdAt === parsed.at && entry.checkpointId > parsed.id),
          )
        : ordered;
      const page = after.slice(0, bounded);
      const hasMore = after.length > bounded;
      return {
        checkpoints: page.map((entry) => ({ ...entry })),
        ...(hasMore && page.length > 0
          ? {
              nextCursor: encodeCursor(
                page[page.length - 1]!.createdAt,
                page[page.length - 1]!.checkpointId,
              ),
            }
          : {}),
      };
    },
    deleteByTaskIds: async (taskIds) => {
      let deleted = 0;
      for (let index = 0; index < records.length; ) {
        if (taskIds.includes(records[index]!.taskId)) {
          records.splice(index, 1);
          deleted += 1;
        } else {
          index += 1;
        }
      }
      return deleted;
    },
    prune: async (before, limit) => {
      let deleted = 0;
      for (let index = 0; index < records.length && deleted < limit; ) {
        if (records[index]!.createdAt <= before) {
          records.splice(index, 1);
          deleted += 1;
        } else {
          index += 1;
        }
      }
      return deleted;
    },
  };
}

export async function ensureCheckpointIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { checkpointId: 1 },
    { unique: true, name: 'checkpoint_id' },
  );
  await collection.createIndex(
    { taskId: 1, createdAt: 1, checkpointId: 1 },
    { name: 'checkpoint_task_created' },
  );
  await collection.createIndex({ createdAt: 1 }, { name: 'checkpoint_created' });
}

function toCheckpoint(document: Record<string, unknown>): CheckpointRecord {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as CheckpointRecord;
}

export function createMongoCheckpointStore(collection: MongoCollectionLike): CheckpointStore {
  return {
    append: async (record) => {
      try {
        await collection.insertOne({ ...record });
      } catch (error) {
        // A repeated checkpoint id is the same observation; it is not an error.
        if ((error as { code?: number }).code !== 11_000) throw error;
      }
    },
    latest: async (taskId) => {
      const documents = await collection
        .find({ taskId })
        .sort({ createdAt: -1, checkpointId: -1 })
        .limit(1)
        .toArray();
      return documents[0] ? toCheckpoint(documents[0]) : null;
    },
    list: async ({ taskId, limit, cursor }) => {
      const bounded = clampLimit(limit, 100);
      const parsed = cursor ? decodeCursor(cursor) : null;
      const filter: Record<string, unknown> = {
        taskId,
        ...(parsed
          ? {
              $or: [
                { createdAt: { $gt: parsed.at } },
                { createdAt: parsed.at, checkpointId: { $gt: parsed.id } },
              ],
            }
          : {}),
      };
      const documents = await collection
        .find(filter)
        .sort({ createdAt: 1, checkpointId: 1 })
        .limit(bounded + 1)
        .toArray();
      const page = documents.slice(0, bounded).map(toCheckpoint);
      const hasMore = documents.length > bounded;
      return {
        checkpoints: page,
        ...(hasMore && page.length > 0
          ? {
              nextCursor: encodeCursor(
                page[page.length - 1]!.createdAt,
                page[page.length - 1]!.checkpointId,
              ),
            }
          : {}),
      };
    },
    deleteByTaskIds: async (taskIds) => {
      if (taskIds.length === 0) return 0;
      const result = await collection.deleteMany({ taskId: { $in: [...taskIds] } });
      return result.deletedCount;
    },
    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      const expired = await collection
        .find({ createdAt: { $lte: before } })
        .limit(limit)
        .toArray();
      const ids = expired
        .map((document) => document.checkpointId)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return 0;
      const result = await collection.deleteMany({ checkpointId: { $in: ids } });
      return result.deletedCount;
    },
  };
}
