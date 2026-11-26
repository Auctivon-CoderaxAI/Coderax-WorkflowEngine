import type { Usage } from '@coderax/contracts';

/**
 * Durable zero-cost budget reservations.
 *
 * The day counters live in one row per owner and UTC day, and a reservation is
 * written before the provider can be called. Two replicas that both want the
 * last request slot race on one conditional update; exactly one wins. Settling
 * replaces the reserved allowance with the usage the provider actually reported
 * but never charges beyond the reservation, so the daily cap holds even when a
 * provider reports more than was held. A duplicate settle/release is refused by
 * the reservation state, so a retried completion cannot charge twice.
 *
 * Reservation ids are deterministic for a task generation, which makes an
 * admission retry idempotent without keeping process-local state.
 */

export type BudgetSnapshot = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

export type ReservationState = 'reserved' | 'settled' | 'released';

export type BudgetReservationRecord = {
  id: string;
  ownerId: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  state: ReservationState;
};

export type ReserveBudgetResult =
  | { allowed: true; requests: number }
  | { allowed: false; reason: 'requests' | 'tokens'; requests: number };

export type BudgetStore = {
  reserve: (input: {
    reservation: BudgetReservationRecord;
    maxRequests: number;
    maxTokens: number;
  }) => Promise<ReserveBudgetResult>;
  settle: (reservationId: string, usage: Usage) => Promise<boolean>;
  release: (reservationId: string, options: { dispatched: boolean }) => Promise<boolean>;
  snapshot: (ownerId: string, day: string) => Promise<BudgetSnapshot>;
  /**
   * Removes settled reservations whose day is older than `beforeDay`
   * (`YYYY-MM-DD`). A reserved row is never removed: it is live authority for a
   * request that may still settle.
   */
  prune: (beforeDay: string, limit: number) => Promise<number>;
};

type Day = BudgetSnapshot;

function emptyDay(): Day {
  return { requests: 0, inputTokens: 0, outputTokens: 0 };
}

export function createMemoryBudgetStore(): BudgetStore {
  const days = new Map<string, Day>();
  const reservations = new Map<string, BudgetReservationRecord>();

  const key = (ownerId: string, day: string): string => `${ownerId}:${day}`;
  function dayFor(ownerId: string, day: string): Day {
    const current = days.get(key(ownerId, day));
    if (current) return current;
    const created = emptyDay();
    days.set(key(ownerId, day), created);
    return created;
  }

  return {
    reserve: async ({ reservation, maxRequests, maxTokens }) => {
      const existing = reservations.get(reservation.id);
      if (existing) {
        const state = dayFor(existing.ownerId, existing.day);
        return { allowed: true, requests: state.requests };
      }
      const state = dayFor(reservation.ownerId, reservation.day);
      if (state.requests >= maxRequests) {
        return { allowed: false, reason: 'requests', requests: state.requests };
      }
      const used = state.inputTokens + state.outputTokens;
      if (used + reservation.inputTokens + reservation.outputTokens > maxTokens) {
        return { allowed: false, reason: 'tokens', requests: state.requests };
      }
      reservations.set(reservation.id, { ...reservation, state: 'reserved' });
      state.requests += 1;
      state.inputTokens += reservation.inputTokens;
      state.outputTokens += reservation.outputTokens;
      return { allowed: true, requests: state.requests };
    },

    settle: async (reservationId, usage) => {
      const reservation = reservations.get(reservationId);
      if (!reservation || reservation.state !== 'reserved') return false;
      reservation.state = 'settled';
      const state = dayFor(reservation.ownerId, reservation.day);
      // A provider may omit one side. Charging the reservation for the omitted
      // side is the conservative choice: it cannot refund tokens already sent.
      // Neither side may exceed the reservation: that allowance is the request's
      // ceiling, and the cap was enforced when it was taken.
      const actualIn = Math.min(
        reservation.inputTokens,
        Math.max(0, usage.inputTokens ?? reservation.inputTokens),
      );
      const actualOut = Math.min(
        reservation.outputTokens,
        Math.max(0, usage.outputTokens ?? reservation.outputTokens),
      );
      state.inputTokens = Math.max(
        0,
        state.inputTokens - reservation.inputTokens + actualIn,
      );
      state.outputTokens = Math.max(
        0,
        state.outputTokens - reservation.outputTokens + actualOut,
      );
      return true;
    },

    release: async (reservationId, options) => {
      const reservation = reservations.get(reservationId);
      if (!reservation || reservation.state !== 'reserved') return false;
      reservation.state = 'released';
      const state = dayFor(reservation.ownerId, reservation.day);
      state.inputTokens = Math.max(0, state.inputTokens - reservation.inputTokens);
      state.outputTokens = Math.max(0, state.outputTokens - reservation.outputTokens);
      if (!options.dispatched) {
        state.requests = Math.max(0, state.requests - 1);
      }
      // Removing the row makes the release final: a later admission with the
      // same deterministic id must reserve against the counters again instead of
      // being mistaken for an existing reservation.
      reservations.delete(reservationId);
      return true;
    },

    snapshot: async (ownerId, day) => ({ ...dayFor(ownerId, day) }),

    prune: async (beforeDay, limit) => {
      if (limit <= 0) return 0;
      let removed = 0;
      for (const [id, reservation] of reservations) {
        if (removed >= limit) break;
        if (reservation.state !== 'settled' || reservation.day >= beforeDay) continue;
        reservations.delete(id);
        removed += 1;
      }
      return removed;
    },
  };
}
