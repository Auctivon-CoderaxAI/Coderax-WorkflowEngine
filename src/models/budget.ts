import { randomUUID } from 'node:crypto';
import type { Usage } from '@coderax/contracts';

export type BudgetReservation = {
  id: string;
  ownerId: string;
  inputTokens: number;
  outputTokens: number;
};

export type BudgetSnapshot = { requests: number; inputTokens: number; outputTokens: number };

export type ReserveOutcome =
  | { allowed: true; reservation: BudgetReservation; requests: number }
  | { allowed: false; reason: 'requests' | 'tokens'; detail: string; requests: number };

/** A UTC-day window; held reservations count against both admission ceilings. */
export type BudgetWindow = BudgetSnapshot & {
  reservedRequests: number;
  reservedInput: number;
  reservedOutput: number;
  reservations: Record<string, BudgetReservation>;
};

export type BudgetWindowStore = {
  read: (key: string) => Promise<BudgetWindow>;
  /** Atomic read-modify-write; the callback is pure and may be replayed. */
  update: <T>(key: string, change: (window: BudgetWindow) => T) => Promise<T>;
};

export function emptyBudgetWindow(): BudgetWindow {
  return { requests: 0, inputTokens: 0, outputTokens: 0, reservedRequests: 0,
    reservedInput: 0, reservedOutput: 0, reservations: {} };
}

export function budgetKey(ownerId: string, at: Date): string {
  return `${ownerId}:${at.toISOString().slice(0, 10)}`;
}

export function createMemoryBudgetStore(): BudgetWindowStore {
  const windows = new Map<string, BudgetWindow>();
  return {
    read: async (key) => structuredClone(windows.get(key) ?? emptyBudgetWindow()),
    update: async (key, change) => {
      const window = structuredClone(windows.get(key) ?? emptyBudgetWindow());
      const result = change(window);
      windows.set(key, window);
      return result;
    },
  };
}

export type BudgetLedger = {
  available: (ownerId: string, at: Date) => Promise<boolean>;
  reserve: (input: { ownerId: string; at: Date; inputTokens: number; outputTokens: number }) => Promise<ReserveOutcome>;
  settle: (reservationId: string, usage: Usage) => Promise<void>;
  release: (reservationId: string, options?: { dispatched?: boolean }) => Promise<void>;
  charge: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  recordUsage: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  snapshot: (ownerId: string, at: Date) => Promise<BudgetSnapshot>;
};

export type BudgetHold =
  | { allowed: true; reservationId: string; commit: () => Promise<void>; release: () => Promise<void> }
  | { allowed: false; reason: 'requests' | 'tokens'; detail: string };

export async function holdBudget(ledger: BudgetLedger, ownerId: string, at: Date): Promise<BudgetHold> {
  const outcome = await ledger.reserve({ ownerId, at, inputTokens: 0, outputTokens: 0 });
  if (!outcome.allowed) return outcome;
  const id = outcome.reservation.id;
  return { allowed: true, reservationId: id,
    commit: () => ledger.release(id, { dispatched: true }),
    release: () => ledger.release(id) };
}

function usedTokens(window: BudgetWindow): number {
  return window.inputTokens + window.outputTokens + window.reservedInput + window.reservedOutput;
}

function tokens(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Invalid budget token amount');
  return Math.max(0, Math.ceil(value));
}

function keyOf(id: string): string | null {
  const parts = id.split('~');
  if (parts.length !== 3 || parts[0] !== 'budget' || !parts[1]) return null;
  return Buffer.from(parts[1], 'base64url').toString('utf8');
}

export function createBudgetLedger(input: {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  store?: BudgetWindowStore;
}): BudgetLedger {
  const store = input.store ?? createMemoryBudgetStore();
  async function finish(id: string, usage: Usage | undefined, dispatched: boolean): Promise<void> {
    const key = keyOf(id);
    if (key === null) return;
    await store.update(key, (window) => {
      const held = window.reservations[id];
      if (!held) return;
      delete window.reservations[id];
      window.reservedRequests -= 1;
      window.reservedInput -= held.inputTokens;
      window.reservedOutput -= held.outputTokens;
      if (dispatched) window.requests += 1;
      if (usage !== undefined) {
        window.inputTokens += tokens(usage.inputTokens ?? held.inputTokens);
        window.outputTokens += tokens(usage.outputTokens ?? held.outputTokens);
      }
    });
  }
  function record(window: BudgetWindow, usage: Usage): void {
    window.inputTokens += tokens(usage.inputTokens ?? 0);
    window.outputTokens += tokens(usage.outputTokens ?? 0);
  }
  return {
    available: async (ownerId, at) => {
      const window = await store.read(budgetKey(ownerId, at));
      return window.requests + window.reservedRequests < input.maxRequestsPerDay
        && usedTokens(window) < input.maxTokensPerDay;
    },
    reserve: async ({ ownerId, at, inputTokens, outputTokens }) => {
      const key = budgetKey(ownerId, at);
      const reservation: BudgetReservation = {
        id: `budget~${Buffer.from(key).toString('base64url')}~${randomUUID()}`,
        ownerId, inputTokens: tokens(inputTokens), outputTokens: tokens(outputTokens),
      };
      return store.update<ReserveOutcome>(key, (window) => {
        const requests = window.requests + window.reservedRequests;
        if (requests >= input.maxRequestsPerDay) return { allowed: false, reason: 'requests',
          detail: 'The daily zero-cost request budget is exhausted.', requests };
        if (usedTokens(window) >= input.maxTokensPerDay ||
            usedTokens(window) + reservation.inputTokens + reservation.outputTokens > input.maxTokensPerDay) {
          return { allowed: false, reason: 'tokens',
            detail: 'The daily zero-cost token budget cannot cover this request.', requests };
        }
        window.reservedRequests += 1;
        window.reservedInput += reservation.inputTokens;
        window.reservedOutput += reservation.outputTokens;
        window.reservations[reservation.id] = reservation;
        return { allowed: true, reservation, requests: requests + 1 };
      });
    },
    settle: (id, usage) => finish(id, usage, true),
    release: (id, options) => finish(id, undefined, options?.dispatched === true),
    charge: async (ownerId, usage, at) => {
      await store.update(budgetKey(ownerId, at), (window) => { window.requests += 1; record(window, usage); });
    },
    recordUsage: async (ownerId, usage, at) => {
      await store.update(budgetKey(ownerId, at), (window) => record(window, usage));
    },
    snapshot: async (ownerId, at) => {
      const { requests, inputTokens, outputTokens } = await store.read(budgetKey(ownerId, at));
      return { requests, inputTokens, outputTokens };
    },
  };
}
