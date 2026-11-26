import type { MongoCollectionLike } from '../persistence/mongo.js';
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

/**
 * Permissions are asked for, never assumed.
 *
 * A request names one scope and one exact resource. A grant approves that
 * resource only, so an agent cannot widen `workspace.read` into a broader path by
 * asking once. External agents begin with nothing; Native is the only agent whose
 * isolation already includes memory and conversations.
 */
export type PermissionStore = {
  request: (input: {
    ownerId: string;
    taskId: string;
    agent: AgentId;
    scope: PermissionScope;
    description: string;
    resource: string;
    binding?: string;
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
  lookup: (input: {
    ownerId: string; taskId: string; scope: PermissionScope; resource: string; binding: string; consume: boolean;
  }) => Promise<{ decision: 'granted' | 'denied' | 'pending'; requestId?: string } | null>;
};

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  collection?: MongoCollectionLike;
}): PermissionStore {
  type Row = PermissionRequest & { ownerId: string; binding: string; consumed: boolean };
  const rows = new Map<string, Row>();
  const collection = input.collection;
  async function scoped(ownerId: string, taskId: string): Promise<Row[]> {
    if (collection) return await collection.find({ ownerId, taskId }).sort({ requestedAt: 1 }).toArray() as unknown as Row[];
    return [...rows.values()].filter(row => row.taskId === taskId && row.ownerId === ownerId);
  }
  function publicRow(row: Row): PermissionRequest {
    const { ownerId, binding, consumed, _id, validUntil, ...request } = row as Row & { _id?: unknown; validUntil?: Date };
    return request;
  }
  async function list(ownerId: string, taskId: string): Promise<PermissionList> {
    return { requests: (await scoped(ownerId, taskId)).map(publicRow) };
  }
  async function update(row: Row, expected: PermissionRequest['decision'], patch: Partial<Row>): Promise<boolean> {
    const now = input.clock.iso();
    if (collection) {
      const result = await collection.updateOne({
        requestId: row.requestId, taskId: row.taskId, ownerId: row.ownerId,
        validUntil: { $gt: new Date(now) }, decision: expected, consumed: false,
      }, { $set: patch }, { upsert: false });
      return result.matchedCount === 1;
    }
    if (row.decision !== expected || row.consumed || row.expiresAt <= now) return false;
    Object.assign(row, patch);
    return true;
  }
  return {
    request: async ({ ttlMs, binding = '', ...fields }) => {
      const now = input.clock.now();
      const row: Row = {
        ...fields, binding, consumed: false, requestId: input.ids.requestId(),
        requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (ttlMs ?? 900_000)).toISOString(),
        decision: 'pending',
      };
      if (collection) await collection.insertOne({ ...row, validUntil: new Date(row.expiresAt) });
      else rows.set(row.requestId, row);
      return publicRow(row);
    },
    list,
    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const row = (await scoped(ownerId, taskId)).find(r => r.requestId === requestId);
      if (!row) return fail('not_found', 'That permission request does not exist for this task.');
      if (!await update(row, 'pending', { decision, decidedAt: input.clock.iso() })) {
        return fail('conflict', 'That request has expired or was already decided.');
      }
      return ok(await list(ownerId, taskId));
    },
    lookup: async ({ ownerId, taskId, scope, resource, binding, consume }) => {
      const row = (await scoped(ownerId, taskId)).find(r =>
        r.scope === scope && r.resource === resource && r.binding === binding &&
        r.expiresAt > input.clock.iso() && !r.consumed);
      if (!row) return null;
      if (row.decision !== 'approved') return { decision: row.decision, requestId: row.requestId };
      if (consume && !await update(row, 'approved', { consumed: true })) return null;
      return { decision: 'granted' };
    },
  };
}
