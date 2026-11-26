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
 * The rows live behind a table port so a Mongo deployment keeps a pending
 * approval across a restart instead of forgetting it with the process.
 */
export type PermissionRow = PermissionRequest & { ownerId: string };

export type PermissionTable = {
  insert: (row: PermissionRow) => Promise<void>;
  get: (requestId: string) => Promise<PermissionRow | null>;
  listTask: (ownerId: string, taskId: string) => Promise<PermissionRow[]>;
  listPending: (ownerId: string) => Promise<PermissionRow[]>;
  /** Engine-internal checks; never a route read. */
  listByTask: (taskId: string) => Promise<PermissionRow[]>;
  updateDecision: (input: {
    requestId: string;
    ownerId: string;
    taskId: string;
    decision: 'approved' | 'denied';
    decidedAt: string;
  }) => Promise<PermissionRow | null>;
};

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
  listPending: (ownerId: string) => Promise<PermissionList>;
  decide: (input: {
    ownerId: string;
    taskId: string;
    requestId: string;
    decision: 'approved' | 'denied';
    reason?: string;
  }) => Promise<ServiceResult<PermissionList>>;
  isApproved: (taskId: string, scope: PermissionScope, resource: string) => Promise<boolean>;
  hasPending: (taskId: string) => Promise<boolean>;
};

function toContract(row: PermissionRow): PermissionRequest {
  const { ownerId: _owner, ...rest } = row;
  return rest;
}

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  table: PermissionTable;
  defaultTtlMs?: number;
}): PermissionStore {
  async function listFor(ownerId: string, taskId: string): Promise<PermissionList> {
    return { requests: (await input.table.listTask(ownerId, taskId)).map(toContract) };
  }

  return {
    request: async ({ ownerId, taskId, agent, scope, description, resource, ttlMs }) => {
      const now = input.clock.now();
      const ttl = ttlMs ?? 15 * 60_000;
      const row: PermissionRow = {
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
      await input.table.insert(row);
      return toContract(row);
    },
    list: listFor,
    listPending: async (ownerId) => ({
      requests: (await input.table.listPending(ownerId)).map(toContract),
    }),
    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const record = await input.table.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      const now = input.clock.now();
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        return fail('conflict', 'That permission request has expired.');
      }
      if (record.decision !== 'pending') {
        return fail('conflict', 'That permission request has already been decided.');
      }
      const updated = await input.table.updateDecision({
        requestId,
        ownerId,
        taskId,
        decision,
        decidedAt: now.toISOString(),
      });
      if (!updated) {
        return fail('conflict', 'That permission request changed before it was decided.');
      }
      return ok(await listFor(ownerId, taskId));
    },
    isApproved: async (taskId, scope, resource) => {
      const now = input.clock.now();
      return (await input.table.listByTask(taskId)).some(
        (row) =>
          row.scope === scope &&
          row.resource === resource &&
          row.decision === 'approved' &&
          new Date(row.expiresAt).getTime() > now.getTime(),
      );
    },
    hasPending: async (taskId) =>
      (await input.table.listByTask(taskId)).some((row) => row.decision === 'pending'),
  };
}
