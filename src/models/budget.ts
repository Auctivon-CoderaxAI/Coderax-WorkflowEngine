import type { Usage } from '@coderax/contracts';
import type { BudgetStore } from '../persistence/budgets.js';

/**
 * The zero-cost budget is a reservation ledger, not a warning counter.
 *
 * A request reserves one request slot and a token allowance before the provider
 * is called. A skipped candidate is released; a completed call is settled with
 * its actual usage, capped at the allowance it holds so the shared day cannot
 * overrun. The counters live in the persistence layer, so two replicas cannot
 * each see the same remaining allowance and both admit the last request.
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
  available: (ownerId: string, at: Date) => Promise<boolean>;
  reserve: (input: {
    ownerId: string;
    at: Date;
    inputTokens: number;
    outputTokens: number;
    reservationId: string;
  }) => Promise<ReserveOutcome>;
  settle: (reservationId: string, usage: Usage) => Promise<boolean>;
  /**
   * Release an unspent reservation. `dispatched` charges the request slot for an
   * attempt that may already have reached the provider while returning its
   * unused token allowance.
   */
  release: (reservationId: string, options?: { dispatched?: boolean }) => Promise<boolean>;
  snapshot: (ownerId: string, at: Date) => Promise<BudgetSnapshot>;
};

export function createBudgetLedger(input: {
  store: BudgetStore;
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
}): BudgetLedger {
  const dayKey = (at: Date): string => at.toISOString().slice(0, 10);

  return {
    available: async (ownerId, at) => {
      // A probe for the owner's next request; the authoritative check is the
      // conditional update in `reserve`.
      const state = await input.store.snapshot(ownerId, dayKey(at));
      return (
        state.requests < input.maxRequestsPerDay &&
        state.inputTokens + state.outputTokens < input.maxTokensPerDay
      );
    },

    reserve: async ({ ownerId, at, inputTokens, outputTokens, reservationId }) => {
      const inTokens = Math.max(0, Math.ceil(inputTokens));
      const outTokens = Math.max(0, Math.ceil(outputTokens));
      const outcome = await input.store.reserve({
        reservation: {
          id: reservationId,
          ownerId,
          day: dayKey(at),
          inputTokens: inTokens,
          outputTokens: outTokens,
          state: 'reserved',
        },
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
      });
      if (!outcome.allowed) {
        return {
          allowed: false,
          reason: outcome.reason,
          detail:
            outcome.reason === 'requests'
              ? 'The daily zero-cost request budget is exhausted.'
              : 'The daily zero-cost token budget cannot cover this request.',
          requests: outcome.requests,
        };
      }
      return {
        allowed: true,
        reservation: { id: reservationId, ownerId, inputTokens: inTokens, outputTokens: outTokens },
        requests: outcome.requests,
      };
    },

    settle: (reservationId, usage) => input.store.settle(reservationId, usage),

    release: (reservationId, options = {}) =>
      input.store.release(reservationId, { dispatched: options.dispatched === true }),

    snapshot: (ownerId, at) => input.store.snapshot(ownerId, dayKey(at)),
  };
}
