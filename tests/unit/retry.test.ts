import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseConfig, createWorkspaces } from '../helpers.js';
import {
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  canRetryWithin,
  isRetryableStartFailure,
  normalizeRetryPolicy,
} from '../../src/execution/retry.js';

test('retry policy is bounded and clamps hostile values', () => {
  assert.deepEqual(normalizeRetryPolicy(null), { maxAttempts: 1, delayMs: 250 });
  assert.deepEqual(normalizeRetryPolicy({ maxAttempts: 99, delayMs: 99_999 }), {
    maxAttempts: MAX_ATTEMPTS,
    delayMs: MAX_DELAY_MS,
  });
  assert.deepEqual(normalizeRetryPolicy({ maxAttempts: -4, delayMs: -1 }), {
    maxAttempts: 1,
    delayMs: 0,
  });
});

test('a retry requires an explicit retryable marker, no cleanup and a replayable code', () => {
  assert.equal(isRetryableStartFailure({ code: 'provider_error', retryable: true }), true);
  assert.equal(isRetryableStartFailure({ code: 'server_unavailable', retryable: true }), true);
  assert.equal(isRetryableStartFailure({ code: 'provider_error', retryable: false }), false);
  assert.equal(
    isRetryableStartFailure({ code: 'provider_error', retryable: true, hasCleanup: true }),
    false,
  );
  assert.equal(isRetryableStartFailure({ code: 'cancelled', retryable: true }), false);
});

test('a retry must fit inside the first half of the claimed lease', () => {
  const claimedAt = Date.now();
  assert.equal(canRetryWithin(claimedAt, 10, 3_000), true);
  assert.equal(canRetryWithin(claimedAt, 5_000, 3_000), false);
});

test('configuration bounds come from the retry policy, not a second copy', () => {
  const workspace = createWorkspaces();
  try {
    assert.throws(
      () => baseConfig(workspace, { execution: { maxAttempts: MAX_ATTEMPTS + 1 } }),
      /maxAttempts|Too big|less than or equal/i,
    );
    assert.equal(
      baseConfig(workspace, { execution: { maxAttempts: MAX_ATTEMPTS } }).execution.maxAttempts,
      MAX_ATTEMPTS,
    );
  } finally {
    workspace.cleanup();
  }
});
