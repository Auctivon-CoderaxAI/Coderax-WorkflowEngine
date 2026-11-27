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
 * A request names one scope, one exact resource and, for a tool invocation, one
 * action binding: a digest of the tool, its policy, the data mode and the
 * validated arguments. A grant approves that action only, so an agent cannot
 * widen `workspace.read` into a broader path by asking once, and a browser or
 * shell action cannot reuse an approval given for a different call.
 *
 * `consume` makes a grant single-use. The check and the claim happen in one
 * operation, so two concurrent executions of the same call cannot both spend it.
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
    callId?: string;
    /** Digest of the exact validated action the owner is approving. */
    binding?: string;
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
  isApproved: (taskId: string, scope: PermissionScope, resource: string) => Promise<boolean>;
  /**
   * One request by id inside its owner and task scope. The browser integration
   * uses this to bind an approval to a single exact resource and to consume it
   * once; a caller that only checks `isApproved` could reuse a grant.
   */
  get: (
    ownerId: string,
    taskId: string,
    requestId: string,
  ) => Promise<PermissionRequest | null>;
  hasPending: (taskId: string) => Promise<boolean>;
  /**
   * The durable lookup a tool runtime performs before executing. It matches the
   * exact action binding, spends an approved grant when `consume` is set, and
   * reports `null` when no decision exists so the caller can create a request.
   */
  lookup: (input: {
    ownerId: string;
    taskId: string;
    scope: PermissionScope;
    resource: string;
    binding: string;
    callId?: string;
    /** A resumed call names the exact decision it was suspended on. */
    requestId?: string;
    consume: boolean;
  }) => Promise<{ decision: 'granted' | 'denied' | 'pending'; requestId?: string } | null>;
  /** Cancellation closes every undecided request so it cannot be spent later. */
  cancelTask: (ownerId: string, taskId: string) => Promise<void>;
};

type PermissionRecord = PermissionRequest & {
  ownerId: string;
  callId?: string;
  binding?: string;
  policy?: 'once' | 'always';
  consumed?: boolean;
};

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  defaultTtlMs?: number;
}): PermissionStore {
  const requests = new Map<string, PermissionRecord>();

  function listFor(ownerId: string, taskId: string): PermissionList {
    return {
      requests: [...requests.values()]
        .filter((entry) => entry.ownerId === ownerId && entry.taskId === taskId)
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map(({ ownerId: _owner, callId: _call, binding: _binding, policy: _policy, consumed: _used, ...rest }) => rest),
    };
  }

  return {
    request: async ({ ownerId, taskId, agent, scope, description, resource, callId, binding, policy, ttlMs }) => {
      const now = input.clock.now();
      const ttl = ttlMs ?? input.defaultTtlMs ?? 15 * 60_000;
      const record: PermissionRecord = {
        requestId: input.ids.requestId(),
        taskId,
        agent,
        scope,
        description,
        resource,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
        decision: 'pending' as const,
        ownerId,
        ...(callId ? { callId } : {}),
        ...(binding ? { binding } : {}),
        ...(policy ? { policy } : {}),
        consumed: false,
      };
      requests.set(record.requestId, record);
      const { ownerId: _owner, callId: _call, binding: _binding, policy: _policy, consumed: _used, ...contract } = record;
      return contract;
    },
    list: async (ownerId, taskId) => listFor(ownerId, taskId),
    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const record = requests.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      const now = input.clock.now();
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        return fail('conflict', 'That permission request has expired.');
      }
      if (record.decision !== 'pending' || record.consumed) return fail('conflict', 'That request was already decided.');
      record.decision = decision;
      record.decidedAt = now.toISOString();
      return ok(listFor(ownerId, taskId));
    },
    get: async (ownerId, taskId, requestId) => {
      const record = requests.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) return null;
      const { ownerId: _owner, callId: _call, binding: _binding, policy: _policy, consumed: _used, ...contract } = record;
      return contract;
    },
    isApproved: async (taskId, scope, resource) => {
      const now = input.clock.now();
      for (const record of requests.values()) {
        if (
          record.taskId === taskId &&
          record.scope === scope &&
          record.resource === resource &&
          record.decision === 'approved' &&
          record.consumed !== true &&
          new Date(record.expiresAt).getTime() > now.getTime()
        ) {
          return true;
        }
      }
      return false;
    },
    hasPending: async (taskId) => {
      for (const record of requests.values()) {
        if (record.taskId === taskId && record.decision === 'pending') return true;
      }
      return false;
    },
    lookup: async ({ ownerId, taskId, scope, resource, binding, callId, requestId, consume }) => {
      const now = input.clock.now();
      const candidates = [...requests.values()].filter(
        (record) =>
          record.ownerId === ownerId &&
          record.taskId === taskId &&
          record.scope === scope &&
          record.resource === resource &&
          (record.binding === undefined || record.binding === binding),
      );
      const named = requestId ? candidates.find((record) => record.requestId === requestId) : undefined;
      if (named) {
        if (new Date(named.expiresAt).getTime() <= now.getTime()) return null;
        if (named.decision === 'denied') return { decision: 'denied', requestId: named.requestId };
        if (named.decision === 'pending') return { decision: 'pending', requestId: named.requestId };
        if (named.consumed === true) return null;
        if (consume) named.consumed = true;
        return { decision: 'granted', requestId: named.requestId };
      }
      const approved = candidates.find(
        (record) =>
          record.decision === 'approved' &&
          record.consumed !== true &&
          new Date(record.expiresAt).getTime() > now.getTime() &&
          (record.callId === undefined || record.callId === callId || record.policy === 'once'),
      );
      if (approved) {
        if (consume) approved.consumed = true;
        return { decision: 'granted', requestId: approved.requestId };
      }
      const pending = candidates.find(
        (record) =>
          record.decision === 'pending' && new Date(record.expiresAt).getTime() > now.getTime(),
      );
      if (pending) return { decision: 'pending', requestId: pending.requestId };
      const denied = candidates.find((record) => record.decision === 'denied');
      if (denied) return { decision: 'denied', requestId: denied.requestId };
      return null;
    },
    cancelTask: async (ownerId, taskId) => {
      const now = input.clock.now().toISOString();
      for (const record of requests.values()) {
        if (record.ownerId === ownerId && record.taskId === taskId && record.decision === 'pending') {
          record.decision = 'denied';
          record.decidedAt = now;
        }
      }
    },
  };
}

export type PermissionRow = PermissionRequest & { ownerId: string; binding: string; consumed: boolean };
export type PermissionTable = {
  insert: (row: PermissionRow) => Promise<void>;
  get: (requestId: string) => Promise<PermissionRow | null>;
  listTask: (ownerId: string, taskId: string) => Promise<PermissionRow[]>;
  listPending: (ownerId: string) => Promise<PermissionRow[]>;
  listByTask: (taskId: string) => Promise<PermissionRow[]>;
  updateDecision: (input: { requestId: string; ownerId: string; taskId: string; decision: PermissionRequest['decision']; decidedAt: string }) => Promise<PermissionRow | null>;
};
