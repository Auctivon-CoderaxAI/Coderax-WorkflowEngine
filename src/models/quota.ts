import { isDuplicateKey, type MongoCollectionLike } from '../persistence/mongo.js';

/**
 * The authoritative zero-cost quota.
 *
 * A `BudgetLedger` is a policy layer over this store: the store owns the
 * durable counters, the ledger owns the daily limits and the UTC day key. In
 * mongo mode both replicas share one account document, so request admission is
 * a compare-and-swap rather than a process-local map. That matters because a
 * team can fan out across replicas; a local ceiling would let each replica spend
 * the whole daily budget independently.
 */
export type QuotaUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

export type QuotaStore = {
  /** Atomically charges one request slot if the account is below both limits. */
  reserve: (input: {
    ownerId: string;
    day: string;
    maxRequests: number;
    maxTokens: number;
  }) => Promise<{ allowed: boolean; requests: number }>;
  /** Adds the actually reported usage after a provider call. */
  settle: (input: { ownerId: string; day: string; usage: QuotaUsage }) => Promise<void>;
  /** Returns request slots reserved for a wave that never ran. */
  release: (input: { ownerId: string; day: string; count: number }) => Promise<void>;
  snapshot: (ownerId: string, day: string) => Promise<QuotaUsage>;
};

const ZERO: QuotaUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

const accountId = (ownerId: string, day: string): string => `${ownerId}:${day}`;

/**
 * Single-process fallback. It is the same contract the durable store implements,
 * so selecting the memory driver changes durability, not quota semantics.
 */
export function createMemoryQuotaStore(): QuotaStore {
  const accounts = new Map<string, QuotaUsage>();

  const account = (ownerId: string, day: string): QuotaUsage => {
    const id = accountId(ownerId, day);
    const existing = accounts.get(id);
    if (existing) return existing;
    const created: QuotaUsage = { ...ZERO };
    accounts.set(id, created);
    return created;
  };

  return {
    reserve: async ({ ownerId, day, maxRequests, maxTokens }) => {
      const state = account(ownerId, day);
      const tokens = state.inputTokens + state.outputTokens;
      if (state.requests >= maxRequests || tokens >= maxTokens) {
        return { allowed: false, requests: state.requests };
      }
      state.requests += 1;
      return { allowed: true, requests: state.requests };
    },
    settle: async ({ ownerId, day, usage }) => {
      const state = account(ownerId, day);
      state.inputTokens += usage.inputTokens;
      state.outputTokens += usage.outputTokens;
    },
    release: async ({ ownerId, day, count }) => {
      const state = account(ownerId, day);
      state.requests = Math.max(0, state.requests - count);
    },
    snapshot: async (ownerId, day) => ({ ...account(ownerId, day) }),

  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function fromDocument(document: Record<string, unknown> | null): QuotaUsage {
  if (!document) return { ...ZERO };
  return {
    requests: count(document.requests),
    inputTokens: count(document.inputTokens),
    outputTokens: count(document.outputTokens),
  };
}

/**
 * Durable quota shared by every replica.
 *
 * `reserve` is a read/compare-and-swap pair on the account document. The filter
 * carries the observed request count, so two replicas that read the same state
 * cannot both increment past the ceiling in the same round: one update matches,
 * the other sees `matchedCount: 0` and retries against the new value.
 */
export function createMongoQuotaStore(input: { collection: MongoCollectionLike }): QuotaStore {
  const collection = input.collection;

  return {
    reserve: async ({ ownerId, day, maxRequests, maxTokens }) => {
      const id = accountId(ownerId, day);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const existing = await collection.findOne({ _id: id });
        if (!existing) {
          try {
            await collection.insertOne({
              _id: id,
              ownerId,
              day,
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
            });
            return { allowed: true, requests: 1 };
          } catch (error) {
            // Another replica created the account between the read and the
            // insert. Re-read it instead of failing admission.
            if (isDuplicateKey(error)) continue;
            throw error;
          }
        }
        const state = fromDocument(existing);
        if (state.requests >= maxRequests || state.inputTokens + state.outputTokens >= maxTokens) {
          return { allowed: false, requests: state.requests };
        }
        // The observed token counts are part of the compare-and-swap. A
        // concurrent `settle` changes them, so the update misses and the retry
        // re-checks the token ceiling instead of admitting past it.
        const result = await collection.updateOne(
          {
            _id: id,
            requests: state.requests,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
          },
          { $inc: { requests: 1 } },
          { upsert: false },
        );
        if ((result.matchedCount ?? 0) === 1) {
          return { allowed: true, requests: state.requests + 1 };
        }
      }
      // Exhausted retries under extreme contention: fail closed rather than
      // spend quota that may already be gone.
      return { allowed: false, requests: 0 };
    },
    settle: async ({ ownerId, day, usage }) => {
      const id = accountId(ownerId, day);
      await collection.updateOne(
        { _id: id },
        {
          $inc: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
          $setOnInsert: { ownerId, day, requests: 0 },
        },
        { upsert: true },
      );
    },
    release: async ({ ownerId, day, count }) => {
      if (count <= 0) return;
      await collection.updateOne(
        { _id: accountId(ownerId, day) },
        { $inc: { requests: -count } },
        { upsert: false },
      );
    },
    snapshot: async (ownerId, day) =>
      fromDocument(await collection.findOne({ _id: accountId(ownerId, day) })),
  };
}
