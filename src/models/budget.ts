import type { Usage } from '@coderax/contracts';

/**
 * The zero-cost budget is a reservation ledger, not a warning counter.
 *
 * A request reserves one request slot and an estimated input+output token
 * allowance before the provider is called. A skipped candidate is released; a
 * completed call is settled with its actual usage. Tokens reserved but not yet
 * settled count against the day, so concurrent callers cannot each see the same
 * remaining allowance.
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

export type BudgetLedger = {
  available: (ownerId: string, at: Date) => boolean;
  reserve: (input: {
    ownerId: string;
    at: Date;
    inputTokens: number;
    outputTokens: number;
  }) => ReserveOutcome;
  settle: (reservationId: string, usage: Usage) => void;
  /**
   * Release an unspent reservation. `dispatched` charges the request slot for an
   * attempt that may already have reached the provider while returning its
   * unused token allowance.
   */
  release: (reservationId: string, options?: { dispatched?: boolean }) => void;
  /** Charge an external engine that did not go through the router. */
  charge: (ownerId: string, usage: Usage, at: Date) => void;
  /**
   * Record token usage for a run whose request slot was already charged at
   * admission. It must not charge a second request.
   */
  recordUsage: (ownerId: string, usage: Usage, at: Date) => void;
  snapshot: (ownerId: string, at: Date) => BudgetSnapshot;
};

/**
 * Admission hold for callers that only need a request slot. The router uses the
 * full reservation API; orchestration admission has no token estimate yet, so it
 * holds the slot and releases it if the run is refused before execution.
 */
export type BudgetHold =
  | {
      allowed: true;
      reservationId: string;
      /** Charge the slot for an attempt that was dispatched. */
      commit: () => void;
      /** Return the slot because nothing was dispatched. */
      release: () => void;
    }
  | { allowed: false; reason: 'requests' | 'tokens'; detail: string };

export function holdBudget(ledger: BudgetLedger, ownerId: string, at: Date): BudgetHold {
  const outcome = ledger.reserve({ ownerId, at, inputTokens: 0, outputTokens: 0 });
  if (!outcome.allowed) {
    return { allowed: false, reason: outcome.reason, detail: outcome.detail };
  }
  let held = true;
  return {
    allowed: true,
    reservationId: outcome.reservation.id,
    commit: () => {
      if (!held) return;
      held = false;
      ledger.release(outcome.reservation.id, { dispatched: true });
    },
    release: () => {
      if (!held) return;
      held = false;
      ledger.release(outcome.reservation.id);
    },
  };
}

export function createBudgetLedger(input: {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
}): BudgetLedger {
  type Day = {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    reservedRequests: number;
    reservedInput: number;
    reservedOutput: number;
  };
  const days = new Map<string, Day>();
  const reservations = new Map<string, { key: string; reservation: BudgetReservation }>();
  let nextId = 0;

  const dayKey = (ownerId: string, at: Date): string =>
    `${ownerId}:${at.toISOString().slice(0, 10)}`;

  function day(ownerId: string, at: Date): Day {
    const key = dayKey(ownerId, at);
    const existing = days.get(key);
    if (existing) return existing;
    const created: Day = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      reservedRequests: 0,
      reservedInput: 0,
      reservedOutput: 0,
    };
    days.set(key, created);
    return created;
  }

  function usedTokens(state: Day): number {
    return state.inputTokens + state.outputTokens + state.reservedInput + state.reservedOutput;
  }

  return {
    available: (ownerId, at) => {
      const state = day(ownerId, at);
      if (state.requests + state.reservedRequests >= input.maxRequestsPerDay) return false;
      return usedTokens(state) < input.maxTokensPerDay;
    },

    reserve: ({ ownerId, at, inputTokens, outputTokens }) => {
      const state = day(ownerId, at);
      const inTokens = Math.max(0, Math.ceil(inputTokens));
      const outTokens = Math.max(0, Math.ceil(outputTokens));
      if (state.requests + state.reservedRequests >= input.maxRequestsPerDay) {
        return {
          allowed: false,
          reason: 'requests',
          detail: 'The daily zero-cost request budget is exhausted.',
          requests: state.requests,
        };
      }
      if (usedTokens(state) >= input.maxTokensPerDay || usedTokens(state) + inTokens + outTokens > input.maxTokensPerDay) {
        return {
          allowed: false,
          reason: 'tokens',
          detail: 'The daily zero-cost token budget cannot cover this request.',
          requests: state.requests,
        };
      }
      const reservation: BudgetReservation = {
        id: `budget_${++nextId}`,
        ownerId,
        inputTokens: inTokens,
        outputTokens: outTokens,
      };
      state.reservedRequests += 1;
      state.reservedInput += inTokens;
      state.reservedOutput += outTokens;
      reservations.set(reservation.id, { key: dayKey(ownerId, at), reservation });
      return {
        allowed: true,
        reservation,
        requests: state.requests + state.reservedRequests,
      };
    },

    settle: (reservationId, usage) => {
      const held = reservations.get(reservationId);
      if (!held) return;
      reservations.delete(reservationId);
      const state = days.get(held.key);
      if (!state) return;
      state.reservedRequests = Math.max(0, state.reservedRequests - 1);
      state.reservedInput = Math.max(0, state.reservedInput - held.reservation.inputTokens);
      state.reservedOutput = Math.max(0, state.reservedOutput - held.reservation.outputTokens);
      state.requests += 1;
      // A provider can omit one side of its usage report. Charging zero for the
      // omitted side would refund tokens that were already reserved and could
      // have been consumed, so the reservation is the conservative fallback.
      state.inputTokens += Math.max(0, usage.inputTokens ?? held.reservation.inputTokens);
      state.outputTokens += Math.max(0, usage.outputTokens ?? held.reservation.outputTokens);
    },

    release: (reservationId, options = {}) => {
      const held = reservations.get(reservationId);
      if (!held) return;
      reservations.delete(reservationId);
      const state = days.get(held.key);
      if (!state) return;
      state.reservedRequests = Math.max(0, state.reservedRequests - 1);
      state.reservedInput = Math.max(0, state.reservedInput - held.reservation.inputTokens);
      state.reservedOutput = Math.max(0, state.reservedOutput - held.reservation.outputTokens);
      // A dispatched attempt consumes one request even when it produced no
      // usage; it must not become free just because the provider failed.
      if (options.dispatched === true) state.requests += 1;
    },

    charge: (ownerId, usage, at) => {
      const state = day(ownerId, at);
      state.requests += 1;
      state.inputTokens += Math.max(0, usage.inputTokens ?? 0);
      state.outputTokens += Math.max(0, usage.outputTokens ?? 0);
    },

    recordUsage: (ownerId, usage, at) => {
      const state = day(ownerId, at);
      state.inputTokens += Math.max(0, usage.inputTokens ?? 0);
      state.outputTokens += Math.max(0, usage.outputTokens ?? 0);
    },

    snapshot: (ownerId, at) => {
      const state = day(ownerId, at);
      return {
        requests: state.requests,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      };
    },
  };
}
