import type { CircuitState } from './types.js';

/**
 * A circuit per model and per provider. Three consecutive failures open it; one
 * probe is admitted after the cooldown. A half-open probe that fails reopens the
 * circuit instead of letting every request through.
 */
export type Circuit = {
  allow: (now: Date) => boolean;
  success: () => void;
  failure: (now: Date) => void;
  /** Release a half-open probe that never produced an outcome. */
  abandon: () => void;
  state: (now: Date) => CircuitState;
  retryAfterMs: (now: Date) => number;
};

export function createCircuit(input: {
  failureThreshold: number;
  cooldownMs: number;
}): Circuit {
  let failures = 0;
  let openedAt: number | null = null;
  let halfOpenProbe = false;

  function state(now: Date): CircuitState {
    if (openedAt === null) return 'closed';
    if (now.getTime() - openedAt >= input.cooldownMs) return 'half_open';
    return 'open';
  }

  return {
    allow: (now) => {
      const current = state(now);
      if (current === 'closed') return true;
      if (current === 'open') return false;
      if (halfOpenProbe) return false;
      halfOpenProbe = true;
      return true;
    },
    success: () => {
      // A success from a request admitted before the circuit opened must not
      // close it. Only a closed circuit or a half-open probe can recover it.
      if (openedAt !== null && !halfOpenProbe) return;
      failures = 0;
      openedAt = null;
      halfOpenProbe = false;
    },
    failure: (now) => {
      halfOpenProbe = false;
      failures += 1;
      if (failures >= input.failureThreshold) {
        openedAt = now.getTime();
      }
    },
    abandon: () => {
      halfOpenProbe = false;
    },
    state,
    retryAfterMs: (now) => {
      if (openedAt === null) return 0;
      return Math.max(0, openedAt + input.cooldownMs - now.getTime());
    },
  };
}
