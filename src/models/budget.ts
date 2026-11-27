import { randomUUID } from 'node:crypto';
import type { Usage } from '@coderax/contracts';

/**
 * The zero-cost ceiling is durable, not a process variable.
 *
 * A request reserves one request slot and a token allowance before the provider
 * is called. The reservation is written to a store that may be shared by every
 * replica of this deployment, so two concurrent callers cannot both observe
 * "one request left" and both spend it. Settlement and release are guarded by
 * the reservation id inside the same atomic window update: replaying either one
 * cannot charge the owner twice.
 *
 * Tokens reserved but not yet settled count against the day. A skipped candidate
 * is released; a dispatched attempt keeps its request slot even when it failed.
 */
export type BudgetReservation = {
  id: string;
  ownerId: string;
  inputTokens: number;
  outputTokens: number;
};

export type BudgetSnapshot = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

export type ReserveOutcome =
  | { allowed: true; reservation: BudgetReservation; requests: number }
  | {
      allowed: false;
      reason: 'requests' | 'tokens';
      detail: string;
      requests: number;
    };

/** One owner's UTC day, including the tokens still held by unsettled calls. */
export type BudgetWindow = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
};

/**
 * The durable half of the ledger. Both operations are atomic per window and
 * idempotent per reservation id.
 */
export type BudgetWindowStore = {
  reserve: (input: {
    key: string;
    reservationId: string;
    maxRequests: number;
    maxTokens: number;
    tokens: number;
  }) => Promise<{ allowed: boolean; window: BudgetWindow }>;
  /** Applies the provider's usage once; returns false for a replay. */
  settle: (input: {
    key: string;
    reservationId: string;
    reservedTokens: number;
    /** Split reservations, used when a provider omits one side of its usage. */
    reservedInputTokens: number;
    reservedOutputTokens: number;
    usage: Usage;
  }) => Promise<boolean>;
  /** Returns unused tokens once; a dispatched attempt still spends a request. */
  release: (input: {
    key: string;
    reservationId: string;
    reservedTokens: number;
    dispatched: boolean;
  }) => Promise<boolean>;
  read: (key: string) => Promise<BudgetWindow>;
};

export type BudgetLedger = {
  available: (ownerId: string, at: Date) => Promise<boolean>;
  reserve: (input: {
    ownerId: string;
    at: Date;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<ReserveOutcome>;
  settle: (reservationId: string, usage: Usage) => Promise<void>;
  /**
   * Release an unspent reservation. `dispatched` charges the request slot for an
   * attempt that may already have reached the provider while returning its
   * unused token allowance.
   */
  release: (reservationId: string, options?: { dispatched?: boolean }) => Promise<void>;
  snapshot: (ownerId: string, at: Date) => Promise<BudgetSnapshot>;
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

/** Used by a single process and by the fast tests; same semantics as Mongo. */
export function createMemoryBudgetStore(): BudgetWindowStore {
  type Row = BudgetWindow & { settled: Set<string>; released: Set<string> };
  const windows = new Map<string, Row>();

  function row(key: string): Row {
    const existing = windows.get(key);
    if (existing) return existing;
    const created: Row = {
      ...EMPTY,
      settled: new Set<string>(),
      released: new Set<string>(),
    };
    windows.set(key, created);
    return created;
  }

  function view(state: Row): BudgetWindow {
    return {
      requests: state.requests,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      reservedTokens: state.reservedTokens,
    };
  }

  return {
    reserve: async ({ key, reservationId, maxRequests, maxTokens, tokens }) => {
      const state = row(key);
      const committed = state.inputTokens + state.outputTokens + state.reservedTokens;
      if (
        state.requests + 1 > maxRequests ||
        committed + tokens > maxTokens ||
        state.settled.has(reservationId) ||
        state.released.has(reservationId)
      ) {
        return { allowed: false, window: view(state) };
      }
      // One synchronous section: the check and the increment cannot interleave.
      state.requests += 1;
      state.reservedTokens += tokens;
      return { allowed: true, window: view(state) };
    },

    settle: async ({
      key, reservationId, reservedTokens, reservedInputTokens, reservedOutputTokens, usage,
    }) => {
      const state = row(key);
      if (state.settled.has(reservationId) || state.released.has(reservationId)) return false;
      state.settled.add(reservationId);
      state.reservedTokens = Math.max(0, state.reservedTokens - Math.max(0, reservedTokens));
      // A provider can omit one side of its usage report. Charging zero for the
      // omitted side would refund tokens that may already have been consumed, so
      // the reservation is the conservative fallback.
      state.inputTokens += Math.max(0, usage.inputTokens ?? Math.max(0, reservedInputTokens));
      state.outputTokens += Math.max(0, usage.outputTokens ?? Math.max(0, reservedOutputTokens));
      return true;
    },

    release: async ({ key, reservationId, reservedTokens, dispatched }) => {
      const state = row(key);
      if (state.settled.has(reservationId) || state.released.has(reservationId)) return false;
      state.released.add(reservationId);
      state.reservedTokens = Math.max(0, state.reservedTokens - Math.max(0, reservedTokens));
      // The reservation already spent the request slot. Only an attempt that
      // never reached the provider gives it back.
      if (!dispatched) state.requests = Math.max(0, state.requests - 1);
      return true;
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
  const reservations = new Map<string, {
    key: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    ownerId: string;
  }>();

  function committed(window: BudgetWindow): number {
    return window.inputTokens + window.outputTokens + window.reservedTokens;
  }

  return {
    available: async (ownerId, at) => {
      const window = await store.read(budgetKey(ownerId, at));
      return window.requests < input.maxRequestsPerDay &&
        committed(window) < input.maxTokensPerDay;
    },

    reserve: async ({ ownerId, at, inputTokens, outputTokens }) => {
      const key = budgetKey(ownerId, at);
      const inTokens = Math.max(0, Math.ceil(inputTokens));
      const outTokens = Math.max(0, Math.ceil(outputTokens));
      const tokens = inTokens + outTokens;
      const reservation: BudgetReservation = {
        id: `budget_${randomUUID()}`,
        ownerId,
        inputTokens: inTokens,
        outputTokens: outTokens,
      };
      const result = await store.reserve({
        key,
        reservationId: reservation.id,
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
        tokens,
      });
      if (!result.allowed) {
        const reason = result.window.requests >= input.maxRequestsPerDay ? 'requests' : 'tokens';
        return {
          allowed: false,
          reason,
          detail: reason === 'requests'
            ? 'The daily zero-cost request budget is exhausted.'
            : 'The daily zero-cost token budget cannot cover this request.',
          requests: result.window.requests,
        };
      }
      reservations.set(reservation.id, {
        key, tokens, inputTokens: inTokens, outputTokens: outTokens, ownerId,
      });
      return { allowed: true, reservation, requests: result.window.requests };
    },

    settle: async (reservationId, usage) => {
      const held = reservations.get(reservationId);
      if (!held) return;
      // Keep the reservation in the local map only until the durable write is
      // acknowledged; a retry after a crash is rejected by the store.
      await store.settle({
        key: held.key,
        reservationId,
        reservedTokens: held.tokens,
        reservedInputTokens: held.inputTokens,
        reservedOutputTokens: held.outputTokens,
        usage,
      });
      reservations.delete(reservationId);
    },

    release: async (reservationId, options = {}) => {
      const held = reservations.get(reservationId);
      if (!held) return;
      await store.release({
        key: held.key,
        reservationId,
        reservedTokens: held.tokens,
        dispatched: options.dispatched === true,
      });
      reservations.delete(reservationId);
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
