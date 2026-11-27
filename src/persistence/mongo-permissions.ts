import type { PermissionList, PermissionRequest } from '@coderax/contracts';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { PermissionStore } from '../permissions/store.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable permission requests.
 *
 * A task can be suspended on one replica and approved or resumed on another, so
 * the grant cannot live in a process-local Map. The contract store and the
 * durable store implement the same port; only the latter survives a restart.
 * `expiresAtMs` is stored beside the ISO timestamp so expiry is a numeric
 * comparison in the database rather than a clock-dependent client filter.
 */
type PermissionDocument = PermissionRequest & {
  ownerId: string;
  expiresAtMs: number;
  callId?: string;
  binding?: string;
  policy?: 'once' | 'always';
  consumed?: boolean;
};

function toRequest(document: Record<string, unknown>): PermissionRequest {
  const {
    requestId,
    taskId,
    agent,
    scope,
    description,
    resource,
    requestedAt,
    expiresAt,
    decision,
    decidedAt,
  } = document;
  if (
    typeof requestId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof agent !== 'string' ||
    typeof scope !== 'string' ||
    typeof description !== 'string' ||
    typeof resource !== 'string' ||
    typeof requestedAt !== 'string' ||
    typeof expiresAt !== 'string' ||
    (decision !== 'pending' && decision !== 'approved' && decision !== 'denied')
  ) {
    throw new Error('A stored permission row is malformed.');
  }
  return {
    requestId,
    taskId,
    agent: agent as PermissionRequest['agent'],
    scope: scope as PermissionRequest['scope'],
    description,
    resource,
    requestedAt,
    expiresAt,
    decision,
    ...(typeof decidedAt === 'string' ? { decidedAt } : {}),
  };
}

export async function ensurePermissionIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { requestId: 1 },
    { unique: true, name: 'permission_request_id' },
  );
  await collection.createIndex(
    { ownerId: 1, taskId: 1 },
    { name: 'permission_owner_task' },
  );
  await collection.createIndex(
    { taskId: 1, scope: 1, resource: 1 },
    { name: 'permission_resource' },
  );
  await collection.createIndex(
    { taskId: 1, binding: 1, decision: 1 },
    { name: 'permission_binding' },
  );
}

export function createMongoPermissionStore(input: {
  collection: MongoCollectionLike;
  clock: Clock;
  ids: IdGenerator;
  defaultTtlMs?: number;
}): PermissionStore {
  async function listFor(ownerId: string, taskId: string): Promise<PermissionList> {
    const documents = await input.collection
      .find({ ownerId, taskId })
      .sort({ requestedAt: 1 })
      .toArray();
    return { requests: documents.map(toRequest) };
  }

  return {
    request: async ({ ownerId, taskId, agent, scope, description, resource, callId, binding, policy, ttlMs }) => {
      const now = input.clock.now();
      const ttl = ttlMs ?? input.defaultTtlMs ?? 15 * 60_000;
      const record: PermissionDocument = {
        requestId: input.ids.requestId(),
        taskId,
        agent,
        scope,
        description,
        resource,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
        expiresAtMs: now.getTime() + ttl,
        decision: 'pending',
        ownerId,
        ...(callId ? { callId } : {}),
        ...(binding ? { binding } : {}),
        ...(policy ? { policy } : {}),
        consumed: false,
      };
      await input.collection.insertOne({ ...record });
      const { ownerId: _owner, expiresAtMs: _expiry, callId: _call, binding: _bind, policy: _policy, consumed: _used, ...contract } = record;
      return contract;
    },

    list: listFor,

    decide: async ({ ownerId, taskId, requestId, decision }): Promise<ServiceResult<PermissionList>> => {
      const now = input.clock.now();
      const updated = await input.collection.findOneAndUpdate(
        {
          requestId,
          ownerId,
          taskId,
          expiresAtMs: { $gt: now.getTime() },
        },
        { $set: { decision, decidedAt: now.toISOString() } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (!updated) {
        const existing = await input.collection.findOne({ requestId, ownerId, taskId });
        return existing
          ? fail('conflict', 'That permission request has expired.')
          : fail('not_found', 'That permission request does not exist for this task.');
      }
      return ok(await listFor(ownerId, taskId));
    },

    get: async (ownerId, taskId, requestId) => {
      const document = await input.collection.findOne({ ownerId, taskId, requestId });
      return document ? toRequest(document) : null;
    },

    isApproved: async (taskId, scope, resource) => {
      const document = await input.collection.findOne({
        taskId,
        scope,
        resource,
        decision: 'approved',
        consumed: { $ne: true },
        expiresAtMs: { $gt: input.clock.now().getTime() },
      });
      return document !== null;
    },

    hasPending: async (taskId) => {
      const document = await input.collection.findOne({ taskId, decision: 'pending' });
      return document !== null;
    },

    lookup: async ({ ownerId, taskId, scope, resource, binding, callId, requestId, consume }) => {
      const now = input.clock.now().getTime();
      const base = {
        ownerId,
        taskId,
        scope,
        resource,
        $or: [{ binding }, { binding: { $exists: false } }],
      };
      if (requestId) {
        const named = await input.collection.findOne({ ...base, requestId });
        if (!named) return null;
        const document = named as Record<string, unknown>;
        if (Number(document.expiresAtMs ?? 0) <= now) return null;
        if (document.decision === 'denied') return { decision: 'denied', requestId };
        if (document.decision === 'pending') return { decision: 'pending', requestId };
        if (document.consumed === true) return null;
        if (consume) {
          const claimed = await input.collection.updateOne(
            { requestId, ownerId, taskId, consumed: { $ne: true }, decision: 'approved' },
            { $set: { consumed: true } },
            { upsert: false },
          );
          if ((claimed.matchedCount ?? 0) !== 1) return null;
        }
        return { decision: 'granted', requestId };
      }
      const approved = await input.collection.findOne({
        ...base,
        decision: 'approved',
        consumed: { $ne: true },
        expiresAtMs: { $gt: now },
        $and: [{ $or: [{ callId }, { callId: { $exists: false } }, { policy: 'once' }] }],
      });
      if (approved) {
        const document = approved as Record<string, unknown>;
        const id = String(document.requestId ?? '');
        if (consume && id !== '') {
          const claimed = await input.collection.updateOne(
            { requestId: id, consumed: { $ne: true }, decision: 'approved' },
            { $set: { consumed: true } },
            { upsert: false },
          );
          if ((claimed.matchedCount ?? 0) !== 1) return null;
        }
        return { decision: 'granted', ...(id !== '' ? { requestId: id } : {}) };
      }
      const pending = await input.collection.findOne({
        ...base,
        decision: 'pending',
        expiresAtMs: { $gt: now },
      });
      if (pending) {
        const id = String((pending as Record<string, unknown>).requestId ?? '');
        return { decision: 'pending', ...(id !== '' ? { requestId: id } : {}) };
      }
      const denied = await input.collection.findOne({ ...base, decision: 'denied' });
      if (denied) {
        const id = String((denied as Record<string, unknown>).requestId ?? '');
        return { decision: 'denied', ...(id !== '' ? { requestId: id } : {}) };
      }
      return null;
    },

    cancelTask: async (ownerId, taskId) => {
      await input.collection.updateMany(
        { ownerId, taskId, decision: 'pending' },
        { $set: { decision: 'denied', decidedAt: input.clock.iso() } },
        { upsert: false },
      );
    },
  };
}
