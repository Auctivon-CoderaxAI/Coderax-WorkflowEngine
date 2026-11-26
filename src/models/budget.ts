import type { Usage } from '@coderax/contracts';

/**
 * Zero-cost enforcement needs a hard local ceiling, not a warning. The ledger
 * reserves before a request is sent, so an exhausted budget refuses the request
 * instead of discovering the overrun afterwards. Counters reset on the UTC day
 * boundary, which is what the provider's published free tier uses.
 */
export type BudgetLedger = {
  reserve: (ownerId: string, at: Date) => { allowed: boolean; requests: number };
  /** Gives back a reservation when the request was refused after reserving. */
  release: (ownerId: string, at: Date) => void;
  consume: (ownerId: string, usage: Usage, at: Date) => void;
  snapshot: (ownerId: string, at: Date) => {
    requests: number;
    inputTokens: number;
    outputTokens: number;
  };
};

export function createBudgetLedger(input: {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
}): BudgetLedger {
  type Day = { requests: number; inputTokens: number; outputTokens: number };
  const days = new Map<string, Day>();

  const dayKey = (ownerId: string, at: Date): string =>
    `${ownerId}:${at.toISOString().slice(0, 10)}`;

  function day(ownerId: string, at: Date): Day {
    const key = dayKey(ownerId, at);
    const existing = days.get(key);
    if (existing) return existing;
    const created: Day = { requests: 0, inputTokens: 0, outputTokens: 0 };
    days.set(key, created);
    return created;
  }

  return {
    reserve: (ownerId, at) => {
      const state = day(ownerId, at);
      const tokens = state.inputTokens + state.outputTokens;
      if (state.requests >= input.maxRequestsPerDay || tokens >= input.maxTokensPerDay) {
        return { allowed: false, requests: state.requests };
      }
      state.requests += 1;
      return { allowed: true, requests: state.requests };
    },
    release: (ownerId, at) => {
      const state = day(ownerId, at);
      if (state.requests > 0) state.requests -= 1;
    },
    consume: (ownerId, usage, at) => {
      const state = day(ownerId, at);
      state.inputTokens += usage.inputTokens ?? 0;
      state.outputTokens += usage.outputTokens ?? 0;
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
