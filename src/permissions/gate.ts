import type { AgentId, PermissionScope } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { PermissionStore } from './store.js';

/**
 * The adapter between the agent-facing authorization port and the permission
 * store. Native cannot approve itself: `allowed` is reserved for an action with
 * no additional scope, and every scoped action is answered from a stored,
 * owner-decided grant or becomes a pending request.
 */
export type PermissionDecision =
  | { decision: 'allowed' }
  | { decision: 'approved'; requestId: string }
  | { decision: 'requested'; requestId: string }
  | { decision: 'pending'; requestId: string }
  | { decision: 'denied' };

export type PermissionGate = {
  authorize: (input: {
    taskId: string;
    ownerId: string;
    agent: AgentId;
    scope: PermissionScope | null;
    resource: string;
    description: string;
  }) => Promise<PermissionDecision>;
};

export function createPermissionGate(input: {
  permissions: PermissionStore;
  clock: Clock;
}): PermissionGate {
  return {
    authorize: async ({ taskId, ownerId, agent, scope, resource, description }) => {
      // Inference under an owner-authorized task needs no second grant. This is
      // the only branch that returns `allowed`, and it cannot name a resource.
      if (scope === null) return { decision: 'allowed' };
      if (!taskId) return { decision: 'denied' };

      const list = await input.permissions.list(ownerId, taskId);
      const now = input.clock.now().getTime();
      const matching = list.requests.filter(
        (request) => request.scope === scope && request.resource === resource,
      );
      const approved = matching.find(
        (request) =>
          request.decision === 'approved' && new Date(request.expiresAt).getTime() > now,
      );
      if (approved) {
        return { decision: 'approved', requestId: approved.requestId };
      }
      const pending = matching.find(
        (request) =>
          request.decision === 'pending' && new Date(request.expiresAt).getTime() > now,
      );
      if (pending) {
        return { decision: 'pending', requestId: pending.requestId };
      }
      // A denial is the owner's answer for this task, scope and resource; it is
      // not re-asked merely because the request's approval window elapsed.
      const denied = matching.find((request) => request.decision === 'denied');
      if (denied) return { decision: 'denied' };

      const request = await input.permissions.request({
        ownerId,
        taskId,
        agent,
        scope,
        description,
        resource,
      });
      return { decision: 'requested', requestId: request.requestId };
    },
  };
}
