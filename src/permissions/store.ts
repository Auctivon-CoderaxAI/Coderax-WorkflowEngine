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
 * A request names one scope, one exact resource and one action binding (tool,
 * policy, data mode and validated arguments). A grant approves that action only,
 * so an agent cannot widen `workspace.read` into a broader path by asking once,
 * and a browser action cannot reuse an approval given for a different call.
 *
 * Decisions live in the same persistence layer as the suspended task. In a
 * MongoDB deployment a request created on one replica is decidable on another,
 * and `consume` is a conditional update: exactly one execution can spend a grant.
 */
export type PermissionStore = {
  request: (input: {
    ownerId: string;
    taskId: string;
    agent: AgentId;
    scope: PermissionScope;
    description: string;
    resource: string;
    /** The one execution slot this decision can authorize. */
    callId: string;
    /** Digest of the exact validated action the owner is approving. */
    binding: string;
    policy?: 'once' | 'always';
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
    ownerId: string;
    taskId: string;
    scope: PermissionScope;
    resource: string;
    binding: string;
    callId: string;
    /** A resumed call names the exact decision it was suspended on. */
    requestId?: string;
    consume: boolean;
  }) => Promise<{ decision: 'granted' | 'denied' | 'pending'; requestId?: string } | null>;
  /** Cancellation closes every undecided request so it cannot be spent later. */
  cancelTask: (ownerId: string, taskId: string) => Promise<void>;
};

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  collection?: MongoCollectionLike;
}): PermissionStore {
  type Row = PermissionRequest & {
    ownerId: string;
    callId: string;
    binding: string;
    policy: 'once' | 'always';
    consumed: boolean;
    reason?: string;
  };
  const rows = new Map<string, Row>();
  const collection = input.collection;

  async function scoped(ownerId: string, taskId: string): Promise<Row[]> {
    if (collection) {
      return (await collection
        .find({ ownerId, taskId })
        .sort({ requestedAt: 1 })
        .toArray()) as unknown as Row[];
    }
    return [...rows.values()].filter((row) => row.taskId === taskId && row.ownerId === ownerId);
  }

  function publicRow(row: Row): PermissionRequest {
    const { ownerId, callId, binding, policy, consumed, reason, _id, validUntil, ...request } = row as Row & {
      _id?: unknown;
      validUntil?: Date;
    };
    void ownerId;
    void callId;
    void binding;
    void policy;
    void consumed;
    void reason;
    void _id;
    void validUntil;
    return request;
  }

  async function list(ownerId: string, taskId: string): Promise<PermissionList> {
    return { requests: (await scoped(ownerId, taskId)).map(publicRow) };
  }

  async function update(
    row: Row,
    expected: PermissionRequest['decision'],
    patch: Partial<Row>,
  ): Promise<boolean> {
    const now = input.clock.iso();
    if (collection) {
      const result = await collection.updateOne(
        {
          requestId: row.requestId,
          taskId: row.taskId,
          ownerId: row.ownerId,
          validUntil: { $gt: new Date(now) },
          decision: expected,
          consumed: false,
        },
        { $set: patch },
        { upsert: false },
      );
      return result.matchedCount === 1;
    }
    if (row.decision !== expected || row.consumed || row.expiresAt <= now) return false;
    Object.assign(row, patch);
    return true;
  }

  return {
    request: async ({ ttlMs, binding = '', policy = 'once', ...fields }) => {
      const now = input.clock.now();
      const row: Row = {
        ...fields,
        binding,
        policy,
        consumed: false,
        requestId: input.ids.requestId(),
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (ttlMs ?? 900_000)).toISOString(),
        decision: 'pending',
      };
      if (collection) await collection.insertOne({ ...row, validUntil: new Date(row.expiresAt) });
      else rows.set(row.requestId, row);
      return publicRow(row);
    },

    list,

    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const row = (await scoped(ownerId, taskId)).find((entry) => entry.requestId === requestId);
      if (!row) return fail('not_found', 'That permission request does not exist for this task.');
      if (!(await update(row, 'pending', { decision, decidedAt: input.clock.iso() }))) {
        return fail('conflict', 'That request has expired or was already decided.');
      }
      return ok(await list(ownerId, taskId));
    },

    lookup: async ({ ownerId, taskId, scope, resource, binding, callId, requestId, consume }) => {
      // A multi-scope tool creates one row per scope under the same call id, so
      // the lookup must select by scope and action as well as by identity.
      const row = (await scoped(ownerId, taskId)).find(
        (entry) =>
          (requestId === undefined ? entry.callId === callId : entry.requestId === requestId) &&
          entry.scope === scope &&
          entry.resource === resource &&
          entry.binding === binding,
      );
      // The identity, action binding, scope and resource must all match. A grant
      // for one call can never authorize a different call that happens to touch
      // the same path with the same arguments.
      if (!row || row.expiresAt <= input.clock.iso()) return null;
      if (row.consumed) {
        // The decision was already spent. A replay must fail closed rather than
        // ask for a fresh grant behind the owner's back.
        return { decision: 'denied', requestId: row.requestId };
      }
      if (row.decision !== 'approved') return { decision: row.decision, requestId: row.requestId };
      // One decision, one invocation. A conditional update is the arbiter when
      // two replicas race to spend the same grant.
      if (consume && !(await update(row, 'approved', { consumed: true }))) {
        return { decision: 'denied', requestId: row.requestId };
      }
      return { decision: 'granted', requestId: row.requestId };
    },

    cancelTask: async (ownerId, taskId) => {
      const open = (await scoped(ownerId, taskId)).filter(
        (row) => row.decision === 'pending' && !row.consumed,
      );
      for (const row of open) {
        await update(row, 'pending', {
          decision: 'denied',
          decidedAt: input.clock.iso(),
          reason: 'The task was cancelled.',
        }).catch(() => false);
      }
    },
  };
}
