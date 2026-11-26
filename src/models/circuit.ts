/**
 * A circuit breaker is what stops a failing free provider from being retried
 * forever. It is intentionally per key (provider, or provider plus model) so one
 * broken model does not remove a provider's other verified-free models.
 *
 * `closed` admits traffic. `open` refuses it until a cooldown ends. `half_open`
 * admits exactly one probe: a success closes the circuit, a failure re-opens it
 * for another cooldown. The state is derived from the clock, so no timer is
 * needed and a process restart simply starts closed again.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

type Breaker = {
  failures: number;
  openedAt: number | null;
  openedUntil: number | null;
  probing: boolean;
};

export type CircuitBreakers = {
  allow: (key: string, at: Date) => boolean;
  success: (key: string) => void;
  failure: (key: string, at: Date, retryAfterMs?: number) => void;
  state: (key: string, at: Date) => BreakerState;
  snapshot: (at: Date) => Array<{ key: string; state: BreakerState; failures: number }>;
};

export function createCircuitBreakers(input?: {
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
}): CircuitBreakers {
  const threshold = Math.max(1, input?.failureThreshold ?? 3);
  const cooldownMs = Math.max(1, input?.cooldownMs ?? 60_000);
  const maxCooldownMs = Math.max(cooldownMs, input?.maxCooldownMs ?? 10 * 60_000);
  const breakers = new Map<string, Breaker>();

  function breaker(key: string): Breaker {
    const existing = breakers.get(key);
    if (existing) return existing;
    const created: Breaker = { failures: 0, openedAt: null, openedUntil: null, probing: false };
    breakers.set(key, created);
    return created;
  }

  function state(key: string, at: Date): BreakerState {
    const entry = breaker(key);
    if (entry.openedUntil === null) return 'closed';
    if (at.getTime() < entry.openedUntil) return 'open';
    return 'half_open';
  }

  return {
    allow: (key, at) => {
      const current = state(key, at);
      if (current === 'closed') return true;
      if (current === 'open') return false;
      const entry = breaker(key);
      // One probe at a time: a second caller waits for the first result.
      if (entry.probing) return false;
      entry.probing = true;
      return true;
    },
    success: (key) => {
      breakers.set(key, { failures: 0, openedAt: null, openedUntil: null, probing: false });
    },
    failure: (key, at, retryAfterMs) => {
      const entry = breaker(key);
      entry.probing = false;
      entry.failures += 1;
      const wasOpen = state(key, at) === 'half_open';
      if (!wasOpen && entry.failures < threshold) return;
      // A provider that states when to retry decides the cooldown, bounded by
      // the local maximum so a hostile header cannot park a provider forever.
      const requested =
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : cooldownMs;
      const duration = Math.min(Math.max(requested, cooldownMs), maxCooldownMs);
      entry.openedAt = at.getTime();
      entry.openedUntil = at.getTime() + duration;
    },
    state,
    snapshot: (at) =>
      [...breakers.entries()].map(([key]) => ({
        key,
        state: state(key, at),
        failures: breaker(key).failures,
      })),
  };
}

/**
 * A provider may state its own retry window. Prefer the standards-shaped
 * `retry-after` in seconds, then the millisecond form some gateways use, then
 * the reset epoch in `x-ratelimit-reset-requests`. Anything unparseable is
 * ignored rather than guessed.
 */
export function retryAfterMs(headers: { get: (name: string) => string | null }): number | undefined {
  const seconds = Number(headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const milliseconds = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.round(milliseconds);
  const reset = headers.get('x-ratelimit-reset-requests');
  if (reset && /^\d+(?:\.\d+)?s$/.test(reset)) {
    return Math.round(Number(reset.slice(0, -1)) * 1000);
  }
  return undefined;
}
