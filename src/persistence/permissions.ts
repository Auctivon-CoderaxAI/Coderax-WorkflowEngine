import type { PermissionRow, PermissionTable } from '../permissions/store.js';

/**
 * The process-local permission table. It implements the same port as the Mongo
 * table, so the permission store's decisions are unchanged when the deployment
 * selects durable persistence.
 */
export function createPermissionTable(): PermissionTable {
  const rows = new Map<string, PermissionRow>();

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
    updateDecision: async ({ requestId, ownerId, taskId, decision, decidedAt }) => {
      const row = rows.get(requestId);
      if (!row || row.ownerId !== ownerId || row.taskId !== taskId) return null;
      if (row.decision !== 'pending') return null;
      const next = { ...row, decision, decidedAt };
      rows.set(requestId, next);
      return { ...next };
    },
  };
}
