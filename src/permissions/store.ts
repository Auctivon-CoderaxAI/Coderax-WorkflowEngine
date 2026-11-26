import type {
  PermissionList,
  PermissionListQuery,
  PermissionRequest,
  PermissionScope,
} from '@coderax/contracts';
import type { AgentId } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { clampLimit, decodeCursor, encodeCursor } from '../persistence/pagination.js';

/**
 * Permissions are asked for, never assumed.
 *
 * A request names one scope, one exact resource and (optionally) one action
 * binding. Approval is for that exact tuple: an agent cannot widen
 * `workspace.read` into a broader path by asking once, nor replay a grant for a
 * different command.
 *
 * Authorization is single-use by default. `lookup({ consume: true })` consumes
 * the grant in one atomic table operation, so two replicas racing on the same
 * approval produce exactly one success. A grant may be created `standing` only
 * when the caller explicitly asks for repeatable authorization; that decision is
 * recorded on the row and is visible to the owner.
 *
 * Every row carries the owner. The table port scopes reads and writes by owner
 * and task independently of the caller, so a guessed request id cannot reach
 * another owner's grant.
 */
export type PermissionRow = PermissionRequest & {
  ownerId: string;
  /** Exact action this grant authorizes; empty means the resource only. */
  binding?: string;
  /** Explicitly repeatable authorization. Defaults to single-use. */
  standing?: boolean;
  consumed?: boolean;
  consumedAt?: string;
  revokedAt?: string;
};

export type PermissionPageQuery = PermissionListQuery;

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
    /** Which prior decision may be superseded. */
    expected: 'pending' | 'approved';
    /** True when an approved, unconsumed grant is being withdrawn. */
    revoke: boolean;
  }) => Promise<PermissionRow | null>;
  /** Atomically marks one matching approved grant consumed. */
  consume: (input: {
    requestId: string;
    ownerId: string;
    taskId: string;
    scope: PermissionScope;
    resource: string;
    binding: string;
    at: string;
  }) => Promise<PermissionRow | null>;
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
  prune: (before: string, limit: number) => Promise<number>;
};

export type PermissionLookup = {
  decision: 'granted' | 'denied' | 'pending';
  requestId?: string;
  /** True when the grant was standing, so nothing was consumed. */
  standing?: boolean;
};

export type PermissionStore = {
  request: (input: {
    ownerId: string;
    taskId: string;
    agent: AgentId;
    scope: PermissionScope;
    description: string;
    resource: string;
    /** Exact action identity; omitted means the resource alone. */
    binding?: string;
    /** Explicitly repeatable authorization; never implicit. */
    standing?: boolean;
    ttlMs?: number;
  }) => Promise<PermissionRequest>;
  list: (
    ownerId: string,
    taskId: string,
    query?: PermissionPageQuery,
  ) => Promise<PermissionList>;
  listPending: (ownerId: string, query?: PermissionPageQuery) => Promise<PermissionList>;
  decide: (input: {
    ownerId: string;
    taskId: string;
    requestId: string;
    decision: 'approved' | 'denied';
    reason?: string;
  }) => Promise<ServiceResult<PermissionList>>;
  /**
   * The authorization decision for one exact action.
   *
   * `consume: true` is the enforcing call: it either grants once or reports that
   * the grant is absent, denied, pending, expired or already consumed.
   */
  lookup: (input: {
    ownerId: string;
    taskId: string;
    scope: PermissionScope;
    resource: string;
    binding: string;
    consume: boolean;
  }) => Promise<PermissionLookup | null>;
  /** Non-consuming compatibility check; never use it to authorize an action. */
  isApproved: (taskId: string, scope: PermissionScope, resource: string) => Promise<boolean>;
  hasPending: (taskId: string) => Promise<boolean>;
  /** Authorized cascade for deleting a task's owning conversation. */
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
  /** Expired requests are operational residue, not history; keep them bounded. */
  prune: (before: string, limit: number) => Promise<number>;
};

function toContract(row: PermissionRow): PermissionRequest {
  const {
    ownerId: _owner,
    binding: _binding,
    standing: _standing,
    consumed: _consumed,
    consumedAt: _consumedAt,
    revokedAt: _revokedAt,
    ...contract
  } = row;
  return contract;
}

function normalize(row: PermissionRow): PermissionRow {
  return {
    ...row,
    binding: row.binding ?? '',
    standing: row.standing === true,
    consumed: row.consumed === true,
  };
}

function isLive(row: PermissionRow, now: string): boolean {
  return row.expiresAt > now;
}

function matchesBinding(row: PermissionRow, binding: string): boolean {
  return (row.binding ?? '') === binding;
}

/**
 * Sorts by the stable pagination key and applies one cursor. The key is
 * `(requestedAt, requestId)`, so two requests made in the same millisecond still
 * paginate without duplicating or skipping a row.
 */
function page(
  rows: PermissionRow[],
  query: PermissionPageQuery,
): PermissionList {
  const limit = clampLimit(query.limit);
  const filtered = rows
    .filter((row) => !query.decision || row.decision === query.decision)
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.requestId.localeCompare(right.requestId),
    );
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const after = cursor
    ? filtered.filter(
        (row) =>
          row.requestedAt > cursor.at ||
          (row.requestedAt === cursor.at && row.requestId > cursor.id),
      )
    : filtered;
  const slice = after.slice(0, limit);
  const hasMore = after.length > limit;
  const last = slice[slice.length - 1];
  return {
    requests: slice.map(toContract),
    total: filtered.length,
    ...(hasMore && last
      ? { nextCursor: encodeCursor(last.requestedAt, last.requestId) }
      : {}),
  };
}

export function createPermissionStore(input: {
  clock: Clock;
  ids: IdGenerator;
  table: PermissionTable;
  defaultTtlMs?: number;
}): PermissionStore {
  const { table, clock, ids } = input;

  async function listFor(
    ownerId: string,
    taskId: string,
    query: PermissionPageQuery = {},
  ): Promise<PermissionList> {
    return page((await table.listTask(ownerId, taskId)).map(normalize), query);
  }

  return {
    request: async ({
      ownerId,
      taskId,
      agent,
      scope,
      description,
      resource,
      binding,
      standing,
      ttlMs,
    }) => {
      const now = clock.now();
      const ttl = ttlMs ?? input.defaultTtlMs ?? 15 * 60_000;
      const row: PermissionRow = {
        requestId: ids.requestId(),
        taskId,
        agent,
        scope,
        description,
        resource,
        binding: binding ?? '',
        standing: standing === true,
        consumed: false,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
        decision: 'pending',
        ownerId,
      };
      await table.insert(row);
      return toContract(row);
    },

    list: listFor,

    listPending: async (ownerId, query = {}) =>
      page((await table.listPending(ownerId)).map(normalize), {
        ...query,
        decision: 'pending',
      }),

    decide: async ({ ownerId, taskId, requestId, decision }) => {
      const record = await table.get(requestId);
      if (!record || record.ownerId !== ownerId || record.taskId !== taskId) {
        return fail('not_found', 'That permission request does not exist for this task.');
      }
      const now = clock.now();
      if (!isLive(record, now.toISOString())) {
        return fail('conflict', 'That permission request has expired.');
      }
      if (record.consumed === true) {
        return fail('conflict', 'That permission grant was already used and cannot change.');
      }
      const expected = record.decision;
      if (expected === 'denied') {
        return fail('conflict', 'That permission request was already decided.');
      }
      const updated = await table.updateDecision({
        requestId,
        ownerId,
        taskId,
        decision,
        decidedAt: now.toISOString(),
        expected,
        revoke: expected === 'approved',
      });
      if (!updated) {
        return fail('conflict', 'That permission request changed before it was decided.');
      }
      return ok(await listFor(ownerId, taskId));
    },

    lookup: async ({ ownerId, taskId, scope, resource, binding, consume }) => {
      const now = clock.now().toISOString();
      const rows = (await table.listByTask(taskId))
        .map(normalize)
        .filter(
          (row) =>
            row.ownerId === ownerId &&
            row.scope === scope &&
            row.resource === resource &&
            matchesBinding(row, binding) &&
            isLive(row, now),
        )
        .sort(
          (left, right) =>
            left.requestedAt.localeCompare(right.requestedAt) ||
            left.requestId.localeCompare(right.requestId),
        );

      const approved = rows.find(
        (row) => row.decision === 'approved' && row.consumed !== true,
      );
      if (approved) {
        if (approved.standing === true) {
          return { decision: 'granted', requestId: approved.requestId, standing: true };
        }
        if (!consume) {
          return { decision: 'granted', requestId: approved.requestId };
        }
        const consumed = await table.consume({
          requestId: approved.requestId,
          ownerId,
          taskId,
          scope,
          resource,
          binding,
          at: now,
        });
        // A concurrent replica consumed it first. The action is not authorized,
        // and the caller must request a new grant rather than replay this one.
        return consumed ? { decision: 'granted', requestId: consumed.requestId } : null;
      }

      const decided = rows.find((row) => row.decision === 'denied');
      if (decided) return { decision: 'denied', requestId: decided.requestId };
      const pending = rows.find((row) => row.decision === 'pending');
      if (pending) return { decision: 'pending', requestId: pending.requestId };
      return null;
    },

    isApproved: async (taskId, scope, resource) => {
      const now = clock.now().toISOString();
      return (await table.listByTask(taskId))
        .map(normalize)
        .some(
          (row) =>
            row.scope === scope &&
            row.resource === resource &&
            row.decision === 'approved' &&
            row.consumed !== true &&
            isLive(row, now),
        );
    },

    hasPending: async (taskId) => {
      const now = clock.now().toISOString();
      return (await table.listByTask(taskId))
        .map(normalize)
        .some((row) => row.decision === 'pending' && isLive(row, now));
    },

    deleteByTaskIds: async (taskIds) => table.deleteByTaskIds(taskIds),

    prune: async (before, limit) => table.prune(before, limit),
  };
}

export { matchesBinding, normalize, page as paginatePermissions, toContract };
