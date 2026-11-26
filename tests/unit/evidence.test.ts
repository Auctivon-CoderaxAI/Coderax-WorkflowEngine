import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderDescriptor, ProviderModel } from '../../src/models/router.js';
import { createRouter } from '../../src/models/router.js';
import {
  evaluateEligibility,
  evaluateInference,
  recordedPromptTraining,
} from '../../src/models/eligibility.js';
import { verifiedTerms } from '../helpers.js';

const now = new Date('2026-11-26T12:00:00.000Z');
const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    ref: { providerId: 'free', modelId: 'vision' },
    label: 'Vision',
    costClass: 'free',
    eligibility: {
      costClass: 'free',
      verifiedFree: true,
      reason: 'verified_zero_price_list',
      source: 'https://provider.example/pricing',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
    profile: {
      coding: 0.5,
      reasoning: 0.5,
      speed: 0.5,
      toolCalling: true,
      multimodal: true,
      contextTokens: 32_000,
    },
    limits: {
      requestsPerMinute: 10,
      requestsPerDay: 10,
      tokensPerDay: 100_000,
      concurrentRequests: 1,
    },
    availability: ready,
    inference: {
      ready: true,
      reason: 'ready',
      detail: 'observed',
      source: 'https://provider.example/usage',
      observedAt: '2026-11-26T11:00:00.000Z',
    },
    promptTraining: 'prohibited',
    ...overrides,
  };
}

function provider(modelOverrides: Partial<ProviderModel> = {}): ProviderDescriptor {
  return {
    id: 'free',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 100_000 },
    models: [model(modelOverrides)],
  };
}

test('price evidence is evaluated against the clock, not a route label', () => {
  const terms = verifiedTerms({
    source: 'https://provider.example/pricing',
    observedAt: '2026-11-20T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  const eligibility = evaluateEligibility(
    {
      providerId: 'free',
      modelId: 'vision',
      source: terms.source as string,
      observedAt: terms.observedAt as string,
      expiresAt: terms.expiresAt as string,
      pricing: {
        currency: 'USD',
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        requestPerCall: 0,
      },
    },
    now,
  );
  assert.equal(eligibility.verifiedFree, true);
  assert.equal(eligibility.reason, 'verified_zero_price_list');
});

test('inference readiness is separate from a configured credential', () => {
  assert.equal(evaluateInference(undefined, now).ready, false);
  const future = evaluateInference(
    { source: 'https://provider.example/usage', observedAt: '2027-01-01T00:00:00.000Z' },
    now,
  );
  assert.equal(future.ready, false);
  assert.equal(future.reason, 'observed_at_in_future');
  const stale = evaluateInference(
    { source: 'https://provider.example/usage', observedAt: '2026-01-01T00:00:00.000Z' },
    now,
  );
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, 'observation_too_old');
  const current = evaluateInference(
    { source: 'https://provider.example/usage', observedAt: '2026-11-26T11:00:00.000Z' },
    now,
  );
  assert.equal(current.ready, true);
  assert.equal(recordedPromptTraining(undefined), 'unknown');
});

test('a price-verified model without observed inference is not selectable', () => {
  const noInference = provider({
    inference: {
      ready: false,
      reason: 'missing',
      detail: 'No successful inference has been observed for this model.',
    },
  });
  const router = createRouter({ providers: [noInference], now: () => now });
  const selected = router.select({ mode: 'auto' });
  assert.equal(selected.ok, false);
  assert.match(selected.ok === false ? selected.detail : '', /No verified zero-cost model/);
  const listed = router.list().models[0];
  assert.equal(listed?.availability.available, false);
  assert.match(listed?.availability.detail ?? '', /No successful inference/);
});

test('concurrent reservations cannot overrun the per-model ceiling', () => {
  const router = createRouter({ providers: [provider()], now: () => now });
  const selected = router.select({ mode: 'auto' });
  assert.equal(selected.ok, true);
  if (!selected.ok) return;

  const first = router.reserve(selected.value, now, 100);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(router.reserve(selected.value, now, 100).ok, false);

  router.settle(selected.value, {}, now, first.value.reservedTokens);
  assert.equal(router.reserve(selected.value, now, 100).ok, true);
});

test('media reporting names eligible vision models and keeps generation unavailable', () => {
  const textOnly = provider({
    profile: {
      coding: 0.5,
      reasoning: 0.5,
      speed: 0.5,
      toolCalling: true,
      multimodal: false,
      contextTokens: 32_000,
    },
  });
  const textRouter = createRouter({ providers: [textOnly], now: () => now });
  const textMedia = textRouter.list().media;
  assert.equal(textMedia?.imageInput.available, false);
  assert.equal(textMedia?.imageGeneration.available, false);
  assert.match(textMedia?.imageGeneration.detail ?? '', /does not fall back to a paid/);
  assert.equal(textMedia?.creativeText.available, true);
  assert.deepEqual(textMedia?.creativeText.formats, ['markdown', 'html', 'svg']);

  const visionRouter = createRouter({ providers: [provider()], now: () => now });
  const visionMedia = visionRouter.list().media;
  assert.equal(visionMedia?.imageInput.available, true);
  assert.deepEqual(visionMedia?.imageInput.models, [{ providerId: 'free', modelId: 'vision' }]);
  assert.equal(visionRouter.list().models[0]?.inputModalities?.includes('image'), true);
  assert.equal(visionRouter.list().models[0]?.promptTraining, 'prohibited');
});
