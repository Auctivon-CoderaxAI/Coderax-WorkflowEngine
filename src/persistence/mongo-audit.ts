import type { AuditListInput, AuditLog } from '../observability/audit.js';
import type { AuditRecord } from '../domain.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Execution receipts in MongoDB.
 *
 * The receipt id is unique, so a retry of the same logical write cannot create a
 * second piece of evidence. Queries are owner- and task-scoped and use the same
 * bounded cursor as every other read model.
 */
export async function ensureAuditIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ receipt: 1 }, { unique: true, name: 'audit_receipt' });
  await collection.createIndex({ at: -1, receipt: -1 }, { name: 'audit_at' });
  await collection.createIndex({ actor: 1, at: -1 }, { name: 'audit_actor_at' });
  await collection.createIndex({ taskId: 1, at: -1 }, { name: 'audit_task_at' });
}

function toRecord(document: Record<string, unknown>): AuditRecord {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as AuditRecord;
}

export function createMongoAuditLog(input: {
  collection: MongoCollectionLike;
  clock: Clock;
  ids: IdGenerator;
}): AuditLog {
  const { collection } = input;

  return {
    record: async (entry) => {
      const record: AuditRecord = {
        ...entry,
        at: input.clock.iso(),
        receipt: input.ids.receipt(),
      };
      await collection.insertOne({ ...record });
      return record;
    },

    list: async (query: AuditListInput = {}) => {
      const limit = clampLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const base = {
        ...(query.actor ? { actor: query.actor } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
      };
      const filter: Record<string, unknown> = {
        ...base,
        ...(cursor
          ? {
              $or: [
                { at: { $lt: cursor.at } },
                { at: cursor.at, receipt: { $lt: cursor.id } },
              ],
            }
          : {}),
      };
      const [documents, total] = await Promise.all([
        collection.find(filter).sort({ at: -1, receipt: -1 }).limit(limit + 1).toArray(),
        collection.countDocuments(base),
      ]);
      const page = documents.slice(0, limit).map(toRecord);
      const hasMore = documents.length > limit;
      return {
        receipts: page,
        total,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeCursor(page[page.length - 1]!.at, page[page.length - 1]!.receipt) }
          : {}),
      };
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      const expired = await collection.find({ at: { $lte: before } }).limit(limit).toArray();
      const receipts = expired
        .map((document) => document.receipt)
        .filter((receipt): receipt is string => typeof receipt === 'string');
      if (receipts.length === 0) return 0;
      const result = await collection.deleteMany({ receipt: { $in: receipts } });
      return result.deletedCount;
    },

    deleteByTaskIds: async (taskIds) => {
      if (taskIds.length === 0) return 0;
      const result = await collection.deleteMany({ taskId: { $in: [...taskIds] } });
      return result.deletedCount;
    },
  };
}
