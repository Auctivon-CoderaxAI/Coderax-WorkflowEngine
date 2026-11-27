import { randomUUID } from 'node:crypto';
import type { Usage } from '@coderax/contracts';

/**
 * The zero-cost ceiling is durable, not a process variable.
 *
 * A request reserves one request slot before the provider is called. The
 * reservation is written to a store that may be shared by every replica of this
 * deployment, so two concurrent callers cannot both observe "one request left"
 * and both spend it. Usage is charged to the same UTC-day window afterwards, and
 * a refused or never-dispatched attempt returns its slot exactly once.
 *
 * Tokens are charged from the provider's reported usage. This ledger does not
 * reserve a token allowance up front, because the caller does not know the
 * completion size; a router that does know can add a reservation later without
 * changing the window format.
 */

export type BudgetSnapshot = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

/** One owner's UTC day. `committed` is the token total both ceilings compare. */
export type BudgetWindow = BudgetSnapshot & { committed: number };

export type ReserveOutcome = {
  allowed: boolean;
  /** The request count after this attempt, whichever way it was decided. */
  requests: number;
  /** Opaque reservation id; settlement and release are idempotent by this id. */
  id: string;
  /** Returns this attempt's request slot once. Safe to call more than once. */
  release: () => Promise<void>;
};

/**
 * The durable half of the ledger. Reserve and release are atomic per window and
 * idempotent per reservation id; consume is an atomic increment.
 */
export type BudgetWindowStore = {
  reserve: (input: {
    key: string;
    reservationId: string;
    maxRequests: number;
    maxTokens: number;
  }) => Promise<{ allowed: boolean; window: BudgetWindow }>;
  /** Returns one request slot once; a replay returns false and changes nothing. */
  release: (input: { key: string; reservationId: string }) => Promise<boolean>;
  consume: (input: { key: string; inputTokens: number; outputTokens: number }) => Promise<void>;
  read: (key: string) => Promise<BudgetWindow>;
};

export type BudgetLedger = {
  available: (ownerId: string, at: Date) => Promise<boolean>;
  reserve: (ownerId: string, at: Date) => Promise<ReserveOutcome>;
  consume: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  snapshot: (ownerId: string, at: Date) => Promise<BudgetSnapshot>;
};

const EMPTY: BudgetWindow = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  committed: 0,
};

export function budgetKey(ownerId: string, at: Date): string {
  return `${ownerId}:${at.toISOString().slice(0, 10)}`;
}

/** Used by a single process and by the fast tests; same semantics as Mongo. */
export function createMemoryBudgetStore(): BudgetWindowStore {
  type Row = BudgetWindow & { released: Set<string> };
  const windows = new Map<string, Row>();

  function row(key: string): Row {
    const existing = windows.get(key);
    if (existing) return existing;
    const created: Row = { ...EMPTY, released: new Set<string>() };
    windows.set(key, created);
    return created;
  }

  function view(state: Row): BudgetWindow {
    return {
      requests: state.requests,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      committed: state.committed,
    };
  }

  return {
    reserve: async ({ key, maxRequests, maxTokens }) => {
      const state = row(key);
      // One synchronous section: the ceiling check and the increment cannot
      // interleave inside a process, and the store makes the same guarantee
      // across processes.
      if (state.requests + 1 > maxRequests || state.committed >= maxTokens) {
        return { allowed: false, window: view(state) };
      }
      state.requests += 1;
      return { allowed: true, window: view(state) };
    },

    release: async ({ key, reservationId }) => {
      const state = row(key);
      if (state.released.has(reservationId)) return false;
      state.released.add(reservationId);
      state.requests = Math.max(0, state.requests - 1);
      return true;
    },

    consume: async ({ key, inputTokens, outputTokens }) => {
      const state = row(key);
      const input = Math.max(0, Math.ceil(inputTokens));
      const output = Math.max(0, Math.ceil(outputTokens));
      state.inputTokens += input;
      state.outputTokens += output;
      state.committed += input + output;
    },

    read: async (key) => view(row(key)),
  };
}

/** A ledger over one durable window store; safe to construct per process. */
export function createBudgetLedger(input: {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  store?: BudgetWindowStore;
}): BudgetLedger {
  const store = input.store ?? createMemoryBudgetStore();

  return {
    available: async (ownerId, at) => {
      const window = await store.read(budgetKey(ownerId, at));
      return window.requests < input.maxRequestsPerDay && window.committed < input.maxTokensPerDay;
    },

    reserve: async (ownerId, at) => {
      const key = budgetKey(ownerId, at);
      const reservationId = `budget_${randomUUID()}`;
      const result = await store.reserve({
        key,
        reservationId,
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
      });
      if (!result.allowed) {
        return {
          allowed: false,
          requests: result.window.requests,
          id: reservationId,
          release: async () => undefined,
        };
      }
      let held = true;
      return {
        allowed: true,
        requests: result.window.requests,
        id: reservationId,
        release: async () => {
          if (!held) return;
          held = false;
          await store.release({ key, reservationId });
        },
      };
    },

    consume: async (ownerId, usage, at) => {
      const inTokens = Math.max(0, Math.ceil(usage.inputTokens ?? 0));
      const outTokens = Math.max(0, Math.ceil(usage.outputTokens ?? 0));
      await store.consume({
        key: budgetKey(ownerId, at),
        inputTokens: inTokens,
        outputTokens: outTokens,
      });
    },

    snapshot: async (ownerId, at) => {
      const window = await store.read(budgetKey(ownerId, at));
      return {
        requests: window.requests,
        inputTokens: window.inputTokens,
        outputTokens: window.outputTokens,
      };
    },
  };
}
