import type { ArtifactRow, ScheduleRecord } from '../domain.js';
import type { ArtifactRepository } from '../artifacts/store.js';
import type { PermissionRow, PermissionTable } from '../permissions/store.js';
import { MAX_ACTIVE_SCHEDULES, type ScheduleRepository } from './schedules.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable schedule, artifact and permission rows.
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

function toSchedule(document: Record<string, unknown>): ScheduleRecord {
  if (
    typeof document.scheduleId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.state !== 'string'
  ) {
    throw new Error('A stored schedule row is malformed.');
  }
  return strip(document) as unknown as ScheduleRecord;
}

function toArtifact(document: Record<string, unknown>): ArtifactRow {
  if (
    typeof document.artifactId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.taskId !== 'string' ||
    typeof document.digest !== 'string'
  ) {
    throw new Error('A stored artifact row is malformed.');
  }
  return strip(document) as unknown as ArtifactRow;
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

export async function ensureScheduleIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ scheduleId: 1 }, { unique: true, name: 'schedule_id' });
  await collection.createIndex(
    { state: 1, nextRunAt: 1 },
    { name: 'schedule_due' },
  );
  await collection.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'schedule_owner' });
}

export function createMongoScheduleRepository(
  collection: MongoCollectionLike,
): ScheduleRepository {
  return {
    create: async (record) => {
      const active = await collection
        .find({ ownerId: record.ownerId, state: 'scheduled' })
        .limit(MAX_ACTIVE_SCHEDULES)
        .toArray();
      if (active.length >= MAX_ACTIVE_SCHEDULES) {
        return { ok: false, reason: 'limit' };
      }
      await collection.insertOne({ ...record });
      return { ok: true };
    },
    get: async (ownerId, scheduleId) => {
      const document = await collection.findOne({ scheduleId, ownerId });
      return document ? toSchedule(document) : null;
    },
    list: async (ownerId) => {
      const documents = await collection
        .find({ ownerId })
        .sort({ createdAt: -1 })
        .toArray();
      return documents.map(toSchedule);
    },
    due: async (nowIso, limit) => {
      const documents = await collection
        .find({ state: 'scheduled', nextRunAt: { $lte: nowIso } })
        .sort({ nextRunAt: 1 })
        .limit(Math.max(0, limit))
        .toArray();
      return documents.map(toSchedule);
    },
    update: async (record) => {
      const updated = await collection.findOneAndUpdate(
        { scheduleId: record.scheduleId, ownerId: record.ownerId },
        { $set: { ...record } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated !== null;
    },
    activeCount: async (ownerId) => {
      const documents = await collection
        .find({ ownerId, state: 'scheduled' })
        .limit(MAX_ACTIVE_SCHEDULES)
        .toArray();
      return documents.length;
    },
  };
}

export async function ensureArtifactIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ artifactId: 1 }, { unique: true, name: 'artifact_id' });
  await collection.createIndex(
    { ownerId: 1, taskId: 1, createdAt: 1 },
    { name: 'artifact_task' },
  );
}

export function createMongoArtifactRepository(
  collection: MongoCollectionLike,
): ArtifactRepository {
  return {
    insert: async (row) => {
      await collection.insertOne({ ...row });
    },
    get: async (ownerId, artifactId) => {
      const document = await collection.findOne({ artifactId, ownerId });
      return document ? toArtifact(document) : null;
    },
    list: async (ownerId, taskId) => {
      const documents = await collection
        .find({ ownerId, taskId })
        .sort({ createdAt: 1 })
        .toArray();
      return documents.map(toArtifact);
    },
  };
}

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
