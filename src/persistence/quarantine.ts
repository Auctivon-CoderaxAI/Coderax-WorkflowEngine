/**
 * Durable workspace quarantine.
 *
 * A process can revoke its own capability and stop waiting for an adapter, but it
 * cannot prove that a workload it abandoned has stopped writing. The quarantine
 * record is the cross-replica part of that answer: it names the root that must
 * not be used again until the hold expires, and every replica consults the same
 * row before admitting work there.
 *
 * The record is deliberately not a task state. It outlives the attempt, can be
 * shared by Chat and Work, and is released by expiry rather than by the process
 * that created it — which is what makes it survive a crash and a replica change.
 */

export type QuarantineEntry = {
  root: string;
  generation: number;
  taskId: string;
  reason: string;
  /** Epoch milliseconds; the hold is inactive at and after this instant. */
  until: number;
  executionId?: string;
};

/** The storage-specific half; both drivers implement exactly this. */
export type QuarantineTable = {
  upsert: (entry: QuarantineEntry) => Promise<void>;
  get: (root: string) => Promise<QuarantineEntry | null>;
  delete: (root: string) => Promise<boolean>;
  list: () => Promise<QuarantineEntry[]>;
  deleteExpired: (now: number) => Promise<number>;
};

export type QuarantineStore = {
  poison: (input: {
    root: string;
    generation: number;
    taskId: string;
    reason: string;
    now: number;
    executionId?: string;
  }) => Promise<QuarantineEntry>;
  /** The active entry for a root, or null when it is safe to use. */
  find: (root: string, now: number) => Promise<QuarantineEntry | null>;
  release: (root: string) => Promise<boolean>;
  list: (now: number) => Promise<QuarantineEntry[]>;
  prune: (now: number) => Promise<number>;
};

export function createInMemoryQuarantineTable(): QuarantineTable {
  const rows = new Map<string, QuarantineEntry>();
  return {
    upsert: async (entry) => {
      rows.set(entry.root, { ...entry });
    },
    get: async (root) => {
      const row = rows.get(root);
      return row ? { ...row } : null;
    },
    delete: async (root) => rows.delete(root),
    list: async () => [...rows.values()].map((row) => ({ ...row })),
    deleteExpired: async (now) => {
      let removed = 0;
      for (const [root, row] of rows) {
        if (row.until <= now) {
          rows.delete(root);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export function createQuarantineStore(input: {
  table: QuarantineTable;
  ttlMs: number;
}): QuarantineStore {
  async function find(root: string, now: number): Promise<QuarantineEntry | null> {
    const row = await input.table.get(root);
    if (!row) return null;
    if (row.until <= now) {
      // Expiry is enforced on read, so a stale row cannot hold a root merely
      // because the sweep has not run on this replica yet.
      await input.table.delete(root);
      return null;
    }
    return row;
  }

  return {
    poison: async ({ now, ...fields }) => {
      const entry: QuarantineEntry = {
        ...fields,
        until: now + input.ttlMs,
      };
      // The longest hold wins: a second, shorter observation must not make a
      // root usable while an earlier unverified workload may still be writing.
      const current = await input.table.get(fields.root);
      if (current && current.until > entry.until) return current;
      await input.table.upsert(entry);
      return entry;
    },
    find,
    release: async (root) => input.table.delete(root),
    list: async (now) => {
      const rows = await input.table.list();
      return rows.filter((row) => row.until > now);
    },
    prune: async (now) => input.table.deleteExpired(now),
  };
}
