import type {
  PermissionList,
  PermissionRequest,
  PermissionScope,
} from '@coderax/contracts';
import type { AgentId } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';

/**
 * Permissions are asked for, never assumed.
 *
 * A request names one scope and one exact resource. A grant approves that
 * resource only, so an agent cannot widen `workspace.read` into a broader path by
 * asking once. External agents begin with nothing; Native is the only agent whose
 * isolation already includes memory and conversations.
 *
 * The store is process-local unless a collection is supplied. The collection is
 * the production default; the in-process map keeps the same semantics for a
 * single-process deployment and for tests.
 */
export type PermissionStore = {
  request: (input: {
    ownerId: string;
    taskId: string;
    agent: AgentId;
    scope: PermissionScope;
    description: string;
    resource: string;
    ttlMs?: number;
  }) => Promise<PermissionRequest>;
  list: (ownerId: string, taskId: string) => Promise<PermissionList>;
  decide: (input: {
    ownerId: string;
    taskId: string;
    requestId: string;
    decision: 'approved' | 'denied';
    reason?: string;
  }) => Promise<ServiceResult<PermissionList>>;
  isApproved: (taskId: string, scope: PermissionScope, resource: string) => Promise<boolean>;
  hasPending: (taskId: string) => Promise<boolean>;
  /** Authorized cascade for deleting a task's owning conversation. */
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
  /** Expired requests are operational residue, not history; keep them bounded. */
  prune: (before: string, limit: number) => Promise<number>;
};

type Row = PermissionRequest & { ownerId: string };

export async function ensurePermissionIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { requestId: 1 },
    { unique: true, name: 'permission_request' },
  );
  await collection.createIndex(
    { ownerId: 1, taskId: 1, requestedAt: 1 },
    { name: 'permission_owner_task' },
  );
  await collection.createIndex({ taskId: 1, decision: 1 }, { name: 'permission_task_decision' });
  await collection.createIndex({ expiresAt: 1 }, { name: 'permission_expiry' });
}

function toRow(document: Record<string, unknown>): Row {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as Row;
}

function publicRow(row: Row): PermissionRequest {
  const { ownerId: _owner, ...contract } = row;
  return contract;
}

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  defaultTtlMs?: number;
  collection?: MongoCollectionLike;
}): PermissionStore {
  const collection = input.collection;
  const rows = new Map<string, Row>();

  async function scoped(ownerId: string, taskId: string): Promise<Row[]> {
    if (collection) {
      const documents = await collection
        .find({ ownerId, taskId })
        .sort({ requestedAt: 1 })
        .toArray();
      return documents.map(toRow);
    }
    return [...rows.values()]
      .filter((row) => row.ownerId === ownerId && row.taskId === taskId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  async function listFor(ownerId: string, taskId: string): Promise<PermissionList> {
    return { requests: (await scoped(ownerId, taskId)).map(publicRow) };
  }

  return {
    request: async ({ ownerId, taskId, agent, scope, description, resource, ttlMs }) => {
      const now = input.clock.now();
      const ttl = ttlMs ?? 15 * 60_000;
      const row: Row = {
        requestId: input.ids.requestId(),
        taskId,
        agent,
        scope,
        description,
        resource,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
        decision: 'pending',
        ownerId,
      };
      if (collection) await collection.insertOne({ ...row });
      else rows.set(row.requestId, row);
      return publicRow(row);
    },

    list: async (ownerId, taskId) => listFor(ownerId, taskId),

    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const now = input.clock.now().toISOString();
      if (collection) {
        const existing = await collection.findOne({ requestId, ownerId, taskId });
        if (!existing) {
          return fail('not_found', 'That permission request does not exist for this task.');
        }
        const updated = await collection.updateOne(
          { requestId, ownerId, taskId, decision: 'pending', expiresAt: { $gt: now } },
          { $set: { decision, decidedAt: now } },
          { upsert: false },
        );
        if ((updated.matchedCount ?? 0) !== 1) {
          return fail('conflict', 'That permission request has expired or was already decided.');
        }
        return ok(await listFor(ownerId, taskId));
      }

      const row = rows.get(requestId);
      if (!row || row.ownerId !== ownerId || row.taskId !== taskId) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      if (new Date(row.expiresAt).getTime() <= input.clock.now().getTime()) {
        return fail('conflict', 'That permission request has expired.');
      }
      if (row.decision !== 'pending') {
        return fail('conflict', 'That permission request was already decided.');
      }
      row.decision = decision;
      row.decidedAt = now;
      return ok(await listFor(ownerId, taskId));
    },

    isApproved: async (taskId, scope, resource) => {
      const now = input.clock.now().toISOString();
      if (collection) {
        const document = await collection.findOne({
          taskId,
          scope,
          resource,
          decision: 'approved',
          expiresAt: { $gt: now },
        });
        return document !== null;
      }
      for (const row of rows.values()) {
        if (
          row.taskId === taskId &&
          row.scope === scope &&
          row.resource === resource &&
          row.decision === 'approved' &&
          new Date(row.expiresAt).getTime() > input.clock.now().getTime()
        ) {
          return true;
        }
      }
      return false;
    },

    hasPending: async (taskId) => {
      if (collection) {
        return (await collection.findOne({ taskId, decision: 'pending' })) !== null;
      }
      for (const row of rows.values()) {
        if (row.taskId === taskId && row.decision === 'pending') return true;
      }
      return false;
    },

    deleteByTaskIds: async (taskIds) => {
      if (taskIds.length === 0) return 0;
      if (collection) {
        const result = await collection.deleteMany({ taskId: { $in: [...taskIds] } });
        return result.deletedCount;
      }
      let deleted = 0;
      for (const [requestId, row] of rows) {
        if (taskIds.includes(row.taskId)) {
          rows.delete(requestId);
          deleted += 1;
        }
      }
      return deleted;
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      if (collection) {
        const expired = await collection
          .find({ expiresAt: { $lte: before } })
          .limit(limit)
          .toArray();
        const ids = expired.map((document) => document.requestId).filter((id): id is string => typeof id === 'string');
        if (ids.length === 0) return 0;
        const result = await collection.deleteMany({ requestId: { $in: ids } });
        return result.deletedCount;
      }
      let deleted = 0;
      for (const [requestId, row] of rows) {
        if (deleted >= limit) break;
        if (row.expiresAt <= before) {
          rows.delete(requestId);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
