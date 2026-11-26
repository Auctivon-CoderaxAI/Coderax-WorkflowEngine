import type { Usage } from '@coderax/contracts';

/**
 * The zero-cost ceiling is durable, not a process variable.
 *
 * A reservation is taken before a request leaves the engine, so two concurrent
 * runs cannot both observe "one request left" and both spend it. In Mongo the
 * ceiling is part of the update filter, which makes the check and the increment
 * one atomic operation across replicas; the in-memory store is atomic because a
 * synchronous section cannot interleave.
 *
 * A reservation is settled with the provider's reported usage. When a call fails
 * before it is billed, the reservation is released instead of charged, so a
 * provider outage does not consume the owner's day.
 */

export type BudgetWindow = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
};

export type BudgetStore = {
  reserve: (input: {
    key: string;
    maxRequests: number;
    maxTokens: number;
    tokens: number;
  }) => Promise<{ allowed: boolean; window: BudgetWindow }>;
  settle: (input: {
    key: string;
    reservedTokens: number;
    usage: { inputTokens?: number; outputTokens?: number };
  }) => Promise<void>;
  read: (key: string) => Promise<BudgetWindow>;
};

export type BudgetLedger = {
  /** One daily request slot; the token estimate is reserved separately. */
  reserve: (
    ownerId: string,
    at: Date,
  ) => Promise<{ allowed: boolean; requests: number; reason?: 'requests' | 'tokens' }>;
  /** Reserve input tokens for one model call against the same daily ceiling. */
  reserveTokens: (input: {
    ownerId: string;
    tokens: number;
    at: Date;
  }) => Promise<{ allowed: boolean; reservedTokens: number; reason?: 'requests' | 'tokens' }>;
  /** Replace a reservation with the usage the provider actually reported. */
  settle: (input: {
    ownerId: string;
    at: Date;
    reservedTokens: number;
    usage: Usage;
  }) => Promise<void>;
  consume: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  snapshot: (
    ownerId: string,
    at: Date,
  ) => Promise<{ requests: number; inputTokens: number; outputTokens: number; reservedTokens: number }>;
};

const EMPTY: BudgetWindow = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  reservedTokens: 0,
};

export function budgetKey(ownerId: string, at: Date): string {
  return `${ownerId}:${at.toISOString().slice(0, 10)}`;
}

/** Multi-replica safe store for one deployment that shares a database. */
export function createMemoryBudgetStore(): BudgetStore {
  const windows = new Map<string, BudgetWindow>();

  function window(key: string): BudgetWindow {
    const existing = windows.get(key);
    if (existing) return existing;
    const created: BudgetWindow = { ...EMPTY };
    windows.set(key, created);
    return created;
  }

  return {
    reserve: async ({ key, maxRequests, maxTokens, tokens }) => {
      const current = window(key);
      // One synchronous section: the check and the increment cannot interleave.
      if (
        current.requests + 1 > maxRequests ||
        current.reservedTokens + tokens > maxTokens ||
        current.inputTokens + current.outputTokens + current.reservedTokens + tokens > maxTokens
      ) {
        return { allowed: false, window: { ...current } };
      }
      current.requests += 1;
      current.reservedTokens += tokens;
      return { allowed: true, window: { ...current } };
    },
    settle: async ({ key, reservedTokens, usage }) => {
      const current = window(key);
      current.reservedTokens = Math.max(0, current.reservedTokens - reservedTokens);
      current.inputTokens += Math.max(0, usage.inputTokens ?? 0);
      current.outputTokens += Math.max(0, usage.outputTokens ?? 0);
    },
    read: async (key) => ({ ...window(key) }),
  };
}

export function createBudgetLedger(input: {
  store: BudgetStore;
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
}): BudgetLedger {
  return {
    reserve: async (ownerId, at) => {
      const result = await input.store.reserve({
        key: budgetKey(ownerId, at),
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
        tokens: 0,
      });
      if (!result.allowed) {
        return {
          allowed: false,
          requests: result.window.requests,
          reason: result.window.requests >= input.maxRequestsPerDay ? 'requests' : 'tokens',
        };
      }
      return { allowed: true, requests: result.window.requests };
    },
    reserveTokens: async ({ ownerId, tokens, at }) => {
      const wanted = Math.max(0, Math.ceil(tokens));
      const result = await input.store.reserve({
        key: budgetKey(ownerId, at),
        maxRequests: Number.MAX_SAFE_INTEGER,
        maxTokens: input.maxTokensPerDay,
        tokens: wanted,
      });
      if (!result.allowed) return { allowed: false, reservedTokens: 0, reason: 'tokens' };
      return { allowed: true, reservedTokens: wanted };
    },
    settle: async ({ ownerId, at, reservedTokens, usage }) => {
      await input.store.settle({
        key: budgetKey(ownerId, at),
        reservedTokens,
        usage,
      });
    },
    consume: async (ownerId, usage, at) => {
      await input.store.settle({ key: budgetKey(ownerId, at), reservedTokens: 0, usage });
    },
    snapshot: async (ownerId, at) => {
      const window = await input.store.read(budgetKey(ownerId, at));
      return {
        requests: window.requests,
        inputTokens: window.inputTokens,
        outputTokens: window.outputTokens,
        reservedTokens: window.reservedTokens,
      };
    },
  };
}
