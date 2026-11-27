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
};

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  defaultTtlMs?: number;
}): PermissionStore {
  const requests = new Map<string, PermissionRequest & { ownerId: string }>();

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
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        return fail('conflict', 'That permission request has expired.');
      }
      record.decision = decision;
      record.decidedAt = now.toISOString();
      return ok(listFor(ownerId, taskId));
    },
    get: async (ownerId, taskId, requestId) => {
      const record = requests.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) return null;
      const { ownerId: _owner, ...contract } = record;
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
  };
}
