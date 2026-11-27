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
  available: (ownerId: string, at: Date) => boolean;
  reserve: (input: {
    ownerId: string;
    at: Date;
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
