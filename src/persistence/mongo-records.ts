import type { PermissionRow, PermissionTable } from '../permissions/store.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable schedule and permission rows.
 *
 * Each store mirrors the in-memory semantics; the difference is that the row
 * survives the process. Owner scoping is part of every owner-facing filter, not a
 * check the caller is trusted to perform.
 */

function strip(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  delete copy._id;
  return copy;
}

function toPermission(document: Record<string, unknown>): PermissionRow {
  if (
    typeof document.requestId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.taskId !== 'string'
  ) {
    throw new Error('A stored permission row is malformed.');
  }
  return strip(document) as unknown as PermissionRow;
}

export function createMongoPermissionTable(
  collection: MongoCollectionLike,
): PermissionTable {
  return {
    insert: async (row) => {
      await collection.insertOne({ ...row });
    },
    get: async (requestId) => {
      const document = await collection.findOne({ requestId });
      return document ? toPermission(document) : null;
    },
    listTask: async (ownerId, taskId) => {
      const documents = await collection
        .find({ ownerId, taskId })
        .sort({ requestedAt: 1 })
        .toArray();
      return documents.map(toPermission);
    },
    listPending: async (ownerId) => {
      const documents = await collection
        .find({ ownerId, decision: 'pending' })
        .sort({ requestedAt: 1 })
        .toArray();
      return documents.map(toPermission);
    },
    listByTask: async (taskId) => {
      const documents = await collection.find({ taskId }).toArray();
      return documents.map(toPermission);
    },
    updateDecision: async ({ requestId, ownerId, taskId, decision, decidedAt }) => {
      const document = await collection.findOneAndUpdate(
        { requestId, ownerId, taskId, decision: 'pending' },
        { $set: { decision, decidedAt } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? toPermission(document) : null;
    },
  };
}

export { isDuplicateKey };

export async function ensurePermissionIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ requestId: 1 }, { unique: true, name: 'permission_request' });
  await collection.createIndex(
    { ownerId: 1, taskId: 1, requestedAt: 1 },
    { name: 'permission_task' },
  );
  await collection.createIndex(
    { ownerId: 1, decision: 1 },
    { name: 'permission_pending' },
  );
}

