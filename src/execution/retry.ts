/**
 * Retry is bounded, stays on the same engine, and requires explicit proof that
 * nothing was dispatched.
 *
 * A failure code alone does not prove replay is safe: a provider call can fail
 * with `server_unavailable` after the engine accepted the task. Only the adapter
 * that owns the transport can say a start never dispatched, and it says so with
 * `retryable: true` and no cleanup to settle. A retry never changes engine;
 * switching engines is an owner decision, not a recovery path.
 */

export type RetryPolicy = {
  /** Total attempts, including the first. 1 disables retry. */
  maxAttempts: number;
  delayMs: number;
};

export const MAX_ATTEMPTS = 5;
export const MAX_DELAY_MS = 1_000;

export function normalizeRetryPolicy(input?: Partial<RetryPolicy> | null): RetryPolicy {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const resolved = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, resolved));
  };
  return {
    maxAttempts: clamp(input?.maxAttempts, 1, 1, MAX_ATTEMPTS),
    delayMs: clamp(input?.delayMs, 250, 0, MAX_DELAY_MS),
  };
}

const RETRYABLE_START_CODES = new Set(['server_unavailable', 'provider_error']);

export function isRetryableStartFailure(failure: {
  code: string;
  retryable?: boolean;
  hasCleanup?: boolean;
}): boolean {
  return (
    failure.hasCleanup !== true &&
    failure.retryable === true &&
    RETRYABLE_START_CODES.has(failure.code)
  );
}

/**
 * A retry may only start while the claimed lease is comfortably still ours.
 * Another replica can claim a task whose lease expired, so a retry that could
 * outlive the lease would risk two engines running one task.
 */
export function canRetryWithin(claimedAt: number, delayMs: number, leaseTtlMs: number): boolean {
  return Date.now() + delayMs <= claimedAt + Math.floor(leaseTtlMs / 2);
}

export function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
