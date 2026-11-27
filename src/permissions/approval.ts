import type { AgentId } from '@coderax/contracts';
import type { PermissionStore } from './store.js';
import type { ApprovalGate } from '../tools/types.js';

/**
 * The tool-facing side of the permission store.
 *
 * A tool never decides for itself whether it may run. `ensure` looks up the
 * durable decision for the exact action binding and, when the owner approved it,
 * claims it once. A pending decision is reported as a suspension so the task can
 * be resumed; a denial is final for that binding.
 *
 * A Chat turn has no task row to suspend on, so a scoped action there is refused
 * rather than left pending forever.
 */
export function createApprovalGate(input: {
  permissions: PermissionStore;
  clock: { iso: () => string };
  ownerId: string;
  taskId: string | null;
  agent: AgentId;
}): ApprovalGate {
  return {
    ensure: async (request) => {
      if (!input.taskId) {
        return { decision: 'denied' };
      }
      const looked = await input.permissions.lookup({
        ownerId: input.ownerId,
        taskId: input.taskId,
        scope: request.scope,
        resource: request.resource,
        binding: request.binding,
        callId: request.callId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        consume: request.consume,
      });
      if (looked) {
        return {
          decision:
            looked.decision === 'granted'
              ? 'granted'
              : looked.decision === 'pending'
                ? 'pending'
                : 'denied',
          ...(looked.requestId ? { requestId: looked.requestId } : {}),
        };
      }
      const created = await input.permissions.request({
        ownerId: input.ownerId,
        taskId: input.taskId,
        agent: input.agent,
        scope: request.scope,
        description: request.description,
        resource: request.resource,
        callId: request.callId,
        binding: request.binding,
        policy: request.policy,
      });
      return { decision: 'pending', requestId: created.requestId };
    },
  };
}
