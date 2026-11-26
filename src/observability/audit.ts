import type { AuditRecord } from '../domain.js';
import type { DataMode, IsoDateTime } from '@coderax/contracts';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { clampLimit, decodeCursor, encodeCursor } from '../persistence/pagination.js';

/**
 * Every accepted, refused and settled task leaves a receipt. The log is
 * append-only and carries no credential, message text or absolute path, so it can
 * be retained and inspected without becoming a second copy of private content.
 *
 * Receipts are operational evidence, so the production path stores them in
 * MongoDB and reads them back with the same cursor discipline as any other read
 * model. A write failure is reported to the caller; it is never swallowed into a
 * process-local buffer that a restart would erase.
 */
export type AuditInput = {
  actor: string;
  action: string;
  outcome: AuditRecord['outcome'];
  taskId?: string;
  conversationId?: string;
  detail?: string;
  requestId?: string;
  mode?: DataMode;
};

export type AuditListInput = {
  actor?: string;
  taskId?: string;
  limit?: number;
  cursor?: string;
};

export type AuditPage = {
  receipts: AuditRecord[];
  total: number;
  nextCursor?: string;
};

export type AuditLog = {
  record: (input: AuditInput) => Promise<AuditRecord>;
  list: (input?: AuditListInput) => Promise<AuditPage>;
  prune: (before: IsoDateTime, limit: number) => Promise<number>;
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
};

function sortNewest(left: AuditRecord, right: AuditRecord): number {
  return right.at.localeCompare(left.at) || right.receipt.localeCompare(left.receipt);
}

export function createAuditLog(input: {
  clock: Clock;
  ids: IdGenerator;
  collection?: MongoCollectionLike;
}): AuditLog {
  const records: AuditRecord[] = [];
  const { collection } = input;

  return {
    record: async (entry) => {
      const record: AuditRecord = {
        ...entry,
        at: input.clock.iso(),
        receipt: input.ids.receipt(),
      };
      if (collection) await collection.insertOne({ ...record });
      else records.push(record);
      return record;
    },

    list: async (query = {}) => {
      const limit = clampLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      if (collection) {
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
        const page = documents.slice(0, limit).map((document) => {
          const copy = { ...document };
          delete copy._id;
          return copy as unknown as AuditRecord;
        });
        const hasMore = documents.length > limit;
        return {
          receipts: page,
          total,
          ...(hasMore && page.length > 0
            ? { nextCursor: encodeCursor(page[page.length - 1]!.at, page[page.length - 1]!.receipt) }
            : {}),
        };
      }

      const matching = records
        .filter((record) => !query.actor || record.actor === query.actor)
        .filter((record) => !query.taskId || record.taskId === query.taskId)
        .sort(sortNewest);
      const after = cursor
        ? matching.filter(
            (record) =>
              record.at < cursor.at || (record.at === cursor.at && record.receipt < cursor.id),
          )
        : matching;
      const page = after.slice(0, limit);
      const hasMore = after.length > limit;
      return {
        receipts: page,
        total: matching.length,
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeCursor(page[page.length - 1]!.at, page[page.length - 1]!.receipt) }
          : {}),
      };
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      if (collection) {
        const expired = await collection.find({ at: { $lte: before } }).limit(limit).toArray();
        const receipts = expired
          .map((document) => document.receipt)
          .filter((receipt): receipt is string => typeof receipt === 'string');
        if (receipts.length === 0) return 0;
        const result = await collection.deleteMany({ receipt: { $in: receipts } });
        return result.deletedCount;
      }
      let deleted = 0;
      for (let index = 0; index < records.length && deleted < limit; ) {
        if (records[index]!.at <= before) {
          records.splice(index, 1);
          deleted += 1;
        } else {
          index += 1;
        }
      }
      return deleted;
    },

    deleteByTaskIds: async (taskIds) => {
      if (taskIds.length === 0) return 0;
      if (collection) {
        const result = await collection.deleteMany({ taskId: { $in: [...taskIds] } });
        return result.deletedCount;
      }
      let deleted = 0;
      for (let index = 0; index < records.length; ) {
        if (records[index]!.taskId && taskIds.includes(records[index]!.taskId!)) {
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
