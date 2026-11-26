import type {
  CancelOutcome,
  LeaseClaim,
  LeaseSnapshot,
  LeaseStore,
} from '../execution/lease.js';

/**
 * The storage-neutral shape of one Work run row. It is deliberately the same
 * contract the verified MongoDB implementation in Coderax satisfies, so that
 * implementation can be adapted without changing engine semantics.
 */
export type WorkRunRow = {
  key: string;
  owner: string;
  token: string;
  cancelRequested: boolean;
  expiresAt: Date;
};

export type WorkRunTable = {
  /** Inserts when absent; fails when a live row already exists. Atomic. */
  insertIfAbsent: (row: WorkRunRow, now: Date) => Promise<boolean>;
  find: (key: string) => Promise<WorkRunRow | null>;
  /** Replaces the expiry only when the key and token still match. */
  updateExpiry: (input: {
    key: string;
    token: string;
    now: Date;
    expiresAt: Date;
  }) => Promise<WorkRunRow | null>;
  deleteByToken: (key: string, token: string) => Promise<boolean>;
  /** Flags a live row, returning it; null when no live row exists. */
  flagCancel: (key: string, now: Date) => Promise<WorkRunRow | null>;
  deleteExpired: (key: string, now: Date) => Promise<boolean>;
  deleteExpiredBefore: (before: Date, limit: number) => Promise<string[]>;
};

/**
 * Process-local table with the durability of a single process. Every method
 * completes its read-modify-write without awaiting, so a claim cannot interleave
 * with another claim in this process. It cannot see a restart, which is why a
 * deployment that needs cross-replica durability supplies a database table.
 */
export function createInMemoryWorkRunTable(): WorkRunTable {
  const rows = new Map<string, WorkRunRow>();
  return {
    insertIfAbsent: async (row, now) => {
      const existing = rows.get(row.key);
      if (existing && existing.expiresAt.getTime() > now.getTime()) {
        return false;
      }
      rows.set(row.key, { ...row });
      return true;
    },
    find: async (key) => {
      const row = rows.get(key);
      return row ? { ...row } : null;
    },
    updateExpiry: async ({ key, token, now, expiresAt }) => {
      const row = rows.get(key);
      if (!row || row.token !== token || row.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      row.expiresAt = expiresAt;
      return { ...row };
    },
    deleteByToken: async (key, token) => {
      const row = rows.get(key);
      if (!row || row.token !== token) return false;
      rows.delete(key);
      return true;
    },
    flagCancel: async (key, now) => {
      const row = rows.get(key);
      if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
      row.cancelRequested = true;
      return { ...row };
    },
    deleteExpired: async (key, now) => {
      const row = rows.get(key);
      if (!row || row.expiresAt.getTime() > now.getTime()) return false;
      rows.delete(key);
      return true;
    },
    deleteExpiredBefore: async (before, limit) => {
      const removed: string[] = [];
      for (const [key, row] of rows) {
        if (removed.length >= limit) break;
        if (row.expiresAt.getTime() <= before.getTime()) {
          rows.delete(key);
          removed.push(key);
        }
      }
      return removed;
    },
  };
}

/**
 * Lease store over a WorkRunTable. This is the single implementation of lease
 * semantics; a database-backed table changes durability, not behavior.
 */
export function createLeaseStore(table: WorkRunTable): LeaseStore {
  return {
    claim: async (input: LeaseClaim) =>
      table.insertIfAbsent(
        {
          key: input.key,
          owner: input.owner,
          token: input.token,
          cancelRequested: false,
          expiresAt: input.expiresAt,
        },
        input.now,
      ),
    renew: async (input) => {
      const row = await table.updateExpiry(input);
      return {
        renewed: row !== null,
        cancelRequested: row?.cancelRequested === true,
      };
    },
    release: async (input) => table.deleteByToken(input.key, input.token),
    cancel: async (input): Promise<CancelOutcome> => {
      const flagged = await table.flagCancel(input.key, input.now);
      if (flagged) return 'requested';
      const retired = await table.deleteExpired(input.key, input.now);
      return retired ? 'interrupted' : 'none';
    },
    read: async (input): Promise<LeaseSnapshot | null> => {
      const row = await table.find(input.key);
      if (!row) return null;
      return {
        token: row.token,
        owner: row.owner,
        cancelRequested: row.cancelRequested,
        expiresAt: row.expiresAt,
        live: row.expiresAt.getTime() > input.now.getTime(),
      };
    },
    prune: async (input) => (await table.deleteExpiredBefore(input.before, input.limit)).length,
  };
}

/**
 * Adapter for the verified MongoDB methods already used by Coderax
 * (`createWorkRunMethods`). Keeping this as a thin adapter means the extraction
 * reuses proven atomic upsert/fencing behavior instead of reimplementing it.
 */
export type MongoWorkRunMethods = {
  claimWorkRun: (input: {
    key: string;
    user: string;
    conversationId: string;
    token: string;
    owner: string;
    now: Date;
    expiresAt: Date;
  }) => Promise<boolean>;
  renewWorkRun: (input: {
    key: string;
    token: string;
    now: Date;
    expiresAt: Date;
  }) => Promise<{ renewed: boolean; cancelRequested: boolean }>;
  releaseWorkRun: (input: { key: string; token: string }) => Promise<boolean>;
  cancelWorkRun: (input: { key: string; now: Date }) => Promise<CancelOutcome>;
  readWorkRun: (input: { key: string; now: Date }) => Promise<{
    token: string;
    cancelRequested: boolean;
    expiresAt: Date;
    live: boolean;
  } | null>;
  pruneWorkRuns: (input: { before: Date; limit: number }) => Promise<number>;
};

/**
 * Wraps the already-verified database methods as a LeaseStore. `owner` in a
 * claim row is stored as the run owner; the legacy `user` column carries the
 * owner identifier and the conversation id comes from the scope key.
 */
export function adaptMongoWorkRunMethods(
  methods: MongoWorkRunMethods,
  scopeForKey: (key: string) => { ownerId: string; conversationId: string },
): LeaseStore {
  return {
    claim: async (input) => {
      const scope = scopeForKey(input.key);
      return methods.claimWorkRun({
        key: input.key,
        user: scope.ownerId,
        conversationId: scope.conversationId,
        token: input.token,
        owner: input.owner,
        now: input.now,
        expiresAt: input.expiresAt,
      });
    },
    renew: (input) => methods.renewWorkRun(input),
    release: (input) => methods.releaseWorkRun(input),
    cancel: (input) => methods.cancelWorkRun(input),
    read: (input) => methods.readWorkRun(input),
    prune: (input) => methods.pruneWorkRuns(input),
  };
}
