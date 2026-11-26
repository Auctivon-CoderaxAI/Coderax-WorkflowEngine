import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoveredModel, FreeTierAttestation } from '../../src/models/types.js';
import { verifyFreeTier } from '../../src/models/verify.js';
import { testAttestation } from '../helpers.js';

/**
 * A free *allowance* is not a free tier. These tests pin the difference: only a
 * record that establishes a hard zero spending boundary for one named account,
 * within a bounded window, can make an unpriced model routable.
 */

const now = new Date('2026-11-26T12:00:00.000Z');

function unpriced(modelId = 'coderax-small'): DiscoveredModel {
  return {
    ref: { providerId: 'free', modelId },
    label: 'Unpriced model',
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: false, toolCalling: true, reasoning: false, streaming: true },
    pricing: null,
  };
}

function verdict(attestation: FreeTierAttestation) {
  return verifyFreeTier({ model: unpriced(), attestations: [attestation], now });
}

test('a complete zero-spending attestation is the only way an unpriced model is free', () => {
  const result = verdict(testAttestation());
  assert.equal(result.costClass, 'free');
  assert.equal(result.basis, 'attestation');
  assert.deepEqual(result.quota, { requestsPerDay: 1_000, tokensPerDay: 1_000_000 });
});

test('no attestation leaves an unpriced model refused', () => {
  const result = verifyFreeTier({ model: unpriced(), attestations: [], now });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /no free-tier attestation/i);
});

test('a non-zero spending cap is billed overage, not a free tier', () => {
  const result = verdict({ ...testAttestation(), spendCapUsd: 5 });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /spending cap/i);
});

test('an account with no billing boundary named is not evidence', () => {
  const result = verdict({
    ...testAttestation(),
    billing: 'unknown' as unknown as FreeTierAttestation['billing'],
  });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /billing boundary/i);
});

test('an attestation must name the account it was verified against', () => {
  const result = verdict({ ...testAttestation(), accountRef: '   ' });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /account/i);
});

test('a claim in another currency cannot prove a zero amount', () => {
  const result = verdict({ ...testAttestation(), currency: 'EUR' as FreeTierAttestation['currency'] });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /USD/i);
});

test('a validity window longer than 90 days is refused', () => {
  const result = verdict(
    testAttestation({
      verifiedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
    }),
  );
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /90 days/i);
});

test('a future-dated or expired attestation is not evidence', () => {
  const future = verdict(testAttestation({ verifiedAt: '2027-01-01T00:00:00.000Z' }));
  assert.equal(future.costClass, 'paid');
  const expired = verdict(
    testAttestation({
      verifiedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
    }),
  );
  assert.equal(expired.costClass, 'paid');
});

test('an attestation without a published allowance cannot bound the engine', () => {
  const result = verdict({
    ...testAttestation(),
    quota: { requestsPerDay: 0, tokensPerDay: 1_000 },
  });
  assert.equal(result.costClass, 'paid');
  assert.match(result.detail, /allowance/i);
});

test('a published zero price list still takes precedence over an attestation', () => {
  const priced: DiscoveredModel = {
    ...unpriced(),
    pricing: { prompt: 0, completion: 0, request: 0 },
  };
  const result = verifyFreeTier({ model: priced, attestations: [], now });
  assert.equal(result.costClass, 'free');
  assert.equal(result.basis, 'pricing');
});

test('a non-zero price is paid even when an attestation exists', () => {
  const priced: DiscoveredModel = {
    ...unpriced(),
    pricing: { prompt: '0', completion: '0.000002' },
  };
  const result = verifyFreeTier({
    model: priced,
    attestations: [testAttestation()],
    now,
  });
  assert.equal(result.costClass, 'paid');
  assert.equal(result.basis, 'pricing');
});
