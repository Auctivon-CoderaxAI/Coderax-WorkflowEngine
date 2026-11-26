import type { PermissionRow, PermissionTable } from '../permissions/store.js';

/**
 * The process-local permission table. It implements the same port as the Mongo
 * table, so the permission store's decisions are unchanged when the deployment
 * selects durable persistence.
 *
 * Consumption and decision updates check their preconditions immediately before
 * the mutation. The map is single-threaded, which is what makes that atomic here;
 * the Mongo table uses a conditional `findOneAndUpdate` for the same guarantee
 * across replicas.
 */
export function createPermissionTable(): PermissionTable {
  const rows = new Map<string, PermissionRow>();

  function bindingOf(row: PermissionRow): string {
    return row.binding ?? '';
  }

  return {
    insert: async (row) => {
      rows.set(row.requestId, { ...row });
    },
    get: async (requestId) => {
      const row = rows.get(requestId);
      return row ? { ...row } : null;
    },
    listTask: async (ownerId, taskId) =>
      [...rows.values()]
        .filter((row) => row.ownerId === ownerId && row.taskId === taskId)
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map((row) => ({ ...row })),
    listPending: async (ownerId) =>
      [...rows.values()]
        .filter((row) => row.ownerId === ownerId && row.decision === 'pending')
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map((row) => ({ ...row })),
    listByTask: async (taskId) =>
      [...rows.values()]
        .filter((row) => row.taskId === taskId)
        .map((row) => ({ ...row })),
    updateDecision: async ({
      requestId,
      ownerId,
      taskId,
      decision,
      decidedAt,
      expected,
      revoke,
    }) => {
      const row = rows.get(requestId);
      if (!row || row.ownerId !== ownerId || row.taskId !== taskId) return null;
      if (row.decision !== expected) return null;
      if (row.consumed === true) return null;
      if (revoke && row.decision !== 'approved') return null;
      const next: PermissionRow = {
        ...row,
        decision,
        decidedAt,
        ...(revoke ? { revokedAt: decidedAt } : {}),
      };
      rows.set(requestId, next);
      return { ...next };
    },
    consume: async ({ requestId, ownerId, taskId, scope, resource, binding, at }) => {
      const row = rows.get(requestId);
      if (!row || row.ownerId !== ownerId || row.taskId !== taskId) return null;
      if (row.decision !== 'approved' || row.consumed === true) return null;
      if (row.standing === true) return null;
      if (row.scope !== scope || row.resource !== resource) return null;
      if (bindingOf(row) !== binding) return null;
      if (row.expiresAt <= at) return null;
      const next: PermissionRow = { ...row, consumed: true, consumedAt: at };
      rows.set(requestId, next);
      return { ...next };
    },
    deleteByTaskIds: async (taskIds) => {
      const wanted = new Set(taskIds);
      let deleted = 0;
      for (const [requestId, row] of rows) {
        if (wanted.has(row.taskId)) {
          rows.delete(requestId);
          deleted += 1;
        }
      }
      return deleted;
    },
    prune: async (before, limit) => {
      if (limit <= 0) return 0;
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
