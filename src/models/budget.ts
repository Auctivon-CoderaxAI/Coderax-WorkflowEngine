import { randomUUID } from 'node:crypto';
import type { Usage } from '@coderax/contracts';
import { createMemoryQuotaStore, type QuotaStore } from './quota.js';

/**
 * Zero-cost enforcement needs a hard ceiling, not a warning. The ledger
 * reserves before a request is sent, so an exhausted budget refuses the request
 * instead of discovering the overrun afterwards. Counters reset on the UTC day
 * boundary, which is what the provider's published free tier uses.
 *
 * The counters live in a `QuotaStore`. In mongo mode that store is shared and
 * durable, so every replica spends the same daily allowance and a process
 * restart does not mint a fresh budget. The memory store exists only for the
 * memory persistence driver.
 */
export type BudgetLedger = {
  /** Non-mutating admission check; the reservation is what actually charges. */
  available: (ownerId: string, at: Date) => Promise<boolean>;
  reserve: (ownerId: string, at: Date) => Promise<{ allowed: boolean; requests: number }>;
  consume: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  /** Returns request slots that were reserved for work that never ran. */
  release: (ownerId: string, count: number, at: Date) => Promise<void>;
  snapshot: (ownerId: string, at: Date) => Promise<{
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
};

export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function createBudgetLedger(input: {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  /** Authoritative store; defaults to the single-process implementation. */
  store?: QuotaStore;
}): BudgetLedger {
  const store = input.store ?? createMemoryQuotaStore();

  function view(state: Row): BudgetWindow {
    return {
      requests: state.requests,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      reservedTokens: state.reservedTokens,
    };
  }

  return {
    available: async (ownerId, at) => {
      const state = await store.snapshot(ownerId, dayKey(at));
      return (
        state.requests < input.maxRequestsPerDay &&
        state.inputTokens + state.outputTokens < input.maxTokensPerDay
      );
    },
    reserve: (ownerId, at) =>
      store.reserve({
        ownerId,
        day: dayKey(at),
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
      }),
    consume: (ownerId, usage, at) =>
      store.settle({
        ownerId,
        day: dayKey(at),
        usage: {
          requests: 0,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      }),
    release: (ownerId, count, at) =>
      store.release({ ownerId, day: dayKey(at), count }),
    snapshot: (ownerId, at) => store.snapshot(ownerId, dayKey(at)),
  };
}
