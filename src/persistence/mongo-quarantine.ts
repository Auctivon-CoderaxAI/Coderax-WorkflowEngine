import type { QuarantineEntry, QuarantineTable } from './quarantine.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Mongo-backed quarantine rows.
 *
 * `root` is unique, so two replicas cannot hold the same root with different
 * deadlines; the store resolves that before writing. The index on `until` lets
 * the retention sweep delete expired holds without scanning fresh ones.
 */
export async function ensureQuarantineIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ root: 1 }, { unique: true, name: 'quarantine_root' });
  await collection.createIndex({ until: 1 }, { name: 'quarantine_until' });
}

function toEntry(document: Record<string, unknown>): QuarantineEntry {
  if (typeof document.root !== 'string' || typeof document.until !== 'number') {
    throw new Error('A stored quarantine row is malformed.');
  }
  return {
    root: document.root,
    generation: typeof document.generation === 'number' ? document.generation : 0,
    taskId: typeof document.taskId === 'string' ? document.taskId : '',
    reason: typeof document.reason === 'string' ? document.reason : 'unknown',
    until: document.until,
    ...(typeof document.executionId === 'string' ? { executionId: document.executionId } : {}),
  };
}

export function createMongoQuarantineTable(collection: MongoCollectionLike): QuarantineTable {
  return {
    upsert: async (entry) => {
      await collection.updateOne(
        { root: entry.root },
        { $set: { ...entry } },
        { upsert: true },
      );
    },
    get: async (root) => {
      const document = await collection.findOne({ root });
      return document ? toEntry(document) : null;
    },
    delete: async (root) => {
      const result = await collection.deleteOne({ root });
      return (result.deletedCount ?? 0) > 0;
    },
    list: async () => {
      const documents = await collection.find({}).toArray();
      return documents.map(toEntry);
    },
    deleteExpired: async (now) => {
      const result = await collection.deleteMany({ until: { $lte: now } });
      return result.deletedCount ?? 0;
    },
  };
}
