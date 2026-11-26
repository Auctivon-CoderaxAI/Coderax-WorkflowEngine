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
 *
 * Three rules make a decision enforceable rather than advisory:
 *
 * - a request can be decided once. A denied request cannot later be flipped to
 *   approved by replaying the same id, which is the escalation path a mutable
 *   record would leave open.
 * - an expired request is never pending and never approved, even if the clock
 *   moved between a list and a decision.
 * - an approval can be spent once. The durable copy of the decision lives on the
 *   task row (`recordApproval`/`consumeApproval`); this store is the prompt and
 *   the validation in front of it.
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
  /** Forget a request; used when a task settles so its prompts do not linger. */
  clear: (taskId: string) => void;
};

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  defaultTtlMs?: number;
}): PermissionStore {
  const requests = new Map<string, PermissionRequest & { ownerId: string }>();
  const consumed = new Set<string>();

  const live = (record: PermissionRequest & { ownerId: string }): boolean =>
    new Date(record.expiresAt).getTime() > input.clock.now().getTime();

  function listFor(ownerId: string, taskId: string): PermissionList {
    return {
      requests: [...requests.values()]
        .filter((entry) => entry.ownerId === ownerId && entry.taskId === taskId)
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map(({ ownerId: _owner, ...rest }) => rest),
    };
  }

  return {
    request: async ({ ownerId, taskId, agent, scope, description, resource, ttlMs }) => {
      const now = input.clock.now();
      const ttl = ttlMs ?? 15 * 60_000;
      const record = {
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
      };
      requests.set(record.requestId, record);
      const { ownerId: _owner, ...contract } = record;
      return contract;
    },
    list: async (ownerId, taskId) => listFor(ownerId, taskId),
    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const record = requests.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      const now = input.clock.now();
      if (!live(record)) {
        return fail('conflict', 'That permission request has expired.');
      }
      if (record.decision !== 'pending' || consumed.has(requestId)) {
        return fail('conflict', 'That permission request has already been decided.');
      }
      record.decision = decision;
      record.decidedAt = now.toISOString();
      if (decision === 'denied') consumed.add(requestId);
      return ok(listFor(ownerId, taskId));
    },
    isApproved: async (taskId, scope, resource) => {
      for (const record of requests.values()) {
        if (
          record.taskId === taskId &&
          record.scope === scope &&
          record.resource === resource &&
          record.decision === 'approved' &&
          !consumed.has(record.requestId) &&
          live(record)
        ) {
          return true;
        }
      }
      return false;
    },
    hasPending: async (taskId) => {
      for (const record of requests.values()) {
        if (record.taskId === taskId && record.decision === 'pending' && live(record)) {
          return true;
        }
      }
      return false;
    },
    clear: (taskId) => {
      for (const [requestId, record] of requests) {
        if (record.taskId === taskId) requests.delete(requestId);
      }
      for (const requestId of consumed) {
        if (requests.get(requestId)?.taskId === taskId) consumed.delete(requestId);
      }
    },
  };
}
