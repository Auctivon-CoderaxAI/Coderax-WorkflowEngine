/**
 * Provider-specific request and token ceilings, enforced locally before a call.
 * The buckets are deliberately conservative: the provider can also throttle a
 * request the local budget thought was allowed, and that response is handled by
 * the router's quota and circuit paths. Limits are per provider, not global,
 * because free tiers are metered per provider and per model.
 */
export type LimiterOutcome =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: 'requests' | 'tokens' | 'concurrency'; retryAfterMs: number };

export type ProviderLimiter = {
  acquire: (input: { tokens: number; now: Date }) => LimiterOutcome;
  inFlight: () => number;
};

export function createProviderLimiter(input: {
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrency: number;
}): ProviderLimiter {
  const requestCapacity = Math.max(1, input.requestsPerMinute);
  const tokenCapacity = Math.max(1, input.tokensPerMinute);
  let requestTokens = requestCapacity;
  let tokenTokens = tokenCapacity;
  let updatedAt: number | null = null;
  let inFlight = 0;

  function refill(now: number): void {
    if (updatedAt === null) {
      updatedAt = now;
      return;
    }
    const elapsed = Math.max(0, now - updatedAt);
    updatedAt = now;
    requestTokens = Math.min(
      requestCapacity,
      requestTokens + (elapsed / 60_000) * requestCapacity,
    );
    tokenTokens = Math.min(
      tokenCapacity,
      tokenTokens + (elapsed / 60_000) * tokenCapacity,
    );
  }

  return {
    inFlight: () => inFlight,
    acquire: ({ tokens, now }) => {
      refill(now.getTime());
      if (inFlight >= input.maxConcurrency) {
        return { allowed: false, reason: 'concurrency', retryAfterMs: 1_000 };
      }
      if (requestTokens < 1) {
        return {
          allowed: false,
          reason: 'requests',
          retryAfterMs: Math.ceil(((1 - requestTokens) / requestCapacity) * 60_000),
        };
      }
      const wanted = Math.max(1, Math.ceil(tokens));
      if (wanted > tokenCapacity) {
        return {
          allowed: false,
          reason: 'tokens',
          retryAfterMs: Math.ceil((wanted / tokenCapacity) * 60_000),
        };
      }
      if (tokenTokens < wanted) {
        return {
          allowed: false,
          reason: 'tokens',
          retryAfterMs: Math.ceil(((wanted - tokenTokens) / tokenCapacity) * 60_000),
        };
      }
      requestTokens -= 1;
      tokenTokens -= wanted;
      inFlight += 1;
      let released = false;
      return {
        allowed: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },
  };
}
