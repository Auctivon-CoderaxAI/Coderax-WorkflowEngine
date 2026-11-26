import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEligibilityIndex,
  evaluateEligibility,
  type EligibilityRecord,
} from '../../src/models/eligibility.js';
import { StartupError } from '../../src/bootstrap/startup-error.js';
import { fakeGateway, startTestApp, verifiedTerms } from '../helpers.js';

const at = new Date('2026-11-26T12:00:00.000Z');

function record(overrides?: Partial<EligibilityRecord>): EligibilityRecord {
  return {
    providerId: 'free',
    modelId: 'coderax-small',
    source: 'https://provider.example/pricing',
    observedAt: '2026-11-20T00:00:00.000Z',
    expiresAt: '2026-12-20T00:00:00.000Z',
    pricing: {
      currency: 'USD',
      inputPerMillionTokens: 0,
      outputPerMillionTokens: 0,
      requestPerCall: 0,
    },
    ...(overrides ?? {}),
  };
}

test('a published all-zero price list is the only thing that proves free', () => {
  const verdict = evaluateEligibility(record(), at);
  assert.equal(verdict.costClass, 'free');
  assert.equal(verdict.verifiedFree, true);
  assert.equal(verdict.reason, 'verified_zero_price_list');
});

test('unknown pricing is paid, never free', () => {
  const index = createEligibilityIndex([], at);
  const verdict = index.get({ providerId: 'free', modelId: 'unrecorded' });
  assert.equal(verdict.costClass, 'paid');
  assert.equal(verdict.verifiedFree, false);
  assert.equal(verdict.reason, 'terms_missing');
});

test('a non-zero price is paid even if one unit is zero', () => {
  for (const pricing of [
    { currency: 'USD' as const, inputPerMillionTokens: 0.1, outputPerMillionTokens: 0, requestPerCall: 0 },
    { currency: 'USD' as const, inputPerMillionTokens: 0, outputPerMillionTokens: 2, requestPerCall: 0 },
    { currency: 'USD' as const, inputPerMillionTokens: 0, outputPerMillionTokens: 0, requestPerCall: 0.001 },
  ]) {
    const verdict = evaluateEligibility(record({ pricing }), at);
    assert.equal(verdict.costClass, 'paid');
    assert.equal(verdict.reason, 'price_not_zero');
  }
});

test('expired, future-dated and over-long observations are refused', () => {
  assert.equal(
    evaluateEligibility(record({ expiresAt: '2026-11-25T00:00:00.000Z' }), at).reason,
    'expired',
  );
  assert.equal(
    evaluateEligibility(record({ observedAt: '2026-12-01T00:00:00.000Z' }), at).reason,
    'observed_at_in_future',
  );
  assert.equal(
    evaluateEligibility(record({ expiresAt: '2027-06-20T00:00:00.000Z' }), at).reason,
    'window_too_long',
  );
});

test('evidence that is not an HTTPS price page is refused', () => {
  assert.equal(evaluateEligibility(record({ source: 'http://provider.example' }), at).reason, 'source_not_https');
  assert.equal(evaluateEligibility(record({ source: 'free-tier' }), at).reason, 'source_not_https');
  assert.equal(
    evaluateEligibility(record({ source: 'https://user:secret@provider.example/pricing' }), at).reason,
    'source_not_https',
  );
});

test('invalid numbers are refused rather than coerced to zero', () => {
  const verdict = evaluateEligibility(
    record({
      pricing: {
        currency: 'USD',
        inputPerMillionTokens: Number.NaN,
        outputPerMillionTokens: 0,
        requestPerCall: 0,
      },
    }),
    at,
  );
  assert.equal(verdict.costClass, 'paid');
  assert.equal(verdict.reason, 'price_invalid');
});

test('duplicate records for one model are refused instead of merged', () => {
  const index = createEligibilityIndex([record(), record()], at);
  assert.equal(index.get({ providerId: 'free', modelId: 'coderax-small' }).reason, 'model_mismatch');
});

test('the index reports every refused record', () => {
  const index = createEligibilityIndex(
    [record(), record({ modelId: 'paid-one', pricing: { currency: 'USD', inputPerMillionTokens: 3, outputPerMillionTokens: 4, requestPerCall: 0 } })],
    at,
  );
  assert.equal(index.entries().length, 2);
  assert.deepEqual(index.refused().map((entry) => entry.ref.modelId), ['paid-one']);
});

test('startup fails closed when a key is configured but no price is verified', async () => {
  await assert.rejects(
    () =>
      startTestApp({
        gateway: fakeGateway(),
        config: {
          models: {
            route: [{ providerId: 'free', modelId: 'coderax-small' }],
            evidence: [{ providerId: 'free', modelId: 'coderax-small' }],
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupError);
      assert.match(error.issues.join(' '), /verified zero-cost|cost/i);
      return true;
    },
  );
});

test('startup fails closed when the recorded price is not zero', async () => {
  await assert.rejects(
    () =>
      startTestApp({
        gateway: fakeGateway(),
        config: {
          models: {
            route: [{ providerId: 'free', modelId: 'coderax-small' }],
            evidence: [
              {
                providerId: 'free',
                modelId: 'coderax-small',
                terms: verifiedTerms({ inputPerMillionTokens: 5 }),
              },
            ],
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupError);
      assert.match(error.issues.join(' '), /not zero|paid/i);
      return true;
    },
  );
});

test('startup succeeds with a verified all-zero record', async () => {
  const app = await startTestApp({ gateway: fakeGateway() });
  try {
    const models = app.app.service.models().models;
    assert.equal(models.length, 1);
    assert.equal(models[0]?.costClass, 'free');
    assert.equal(app.app.service.models().allowPaid, false);
  } finally {
    await app.close();
  }
});
