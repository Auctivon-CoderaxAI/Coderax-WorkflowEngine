import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderDescriptor } from '../../src/models/router.js';
import { createRouter } from '../../src/models/router.js';
import { createRoutedGateway, isRouterExhausted } from '../../src/models/routed.js';
import type { ModelGateway } from '../../src/agents/native/types.js';

function provider(overrides?: Partial<ProviderDescriptor>): ProviderDescriptor {
  return {
    id: 'free',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [
      {
        ref: { providerId: 'free', modelId: 'fast' },
        label: 'Fast',
        costClass: 'free',
        profile: { coding: 0.2, reasoning: 0.1, speed: 1, toolCalling: false, multimodal: false, contextTokens: 8192 },
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
      {
        ref: { providerId: 'free', modelId: 'deep' },
        label: 'Deep',
        costClass: 'free',
        profile: { coding: 0.9, reasoning: 1, speed: 0.2, toolCalling: true, multimodal: true, contextTokens: 32_000 },
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
    ],
    ...(overrides ?? {}),
  };
}

test('fast and complex modes rank different models first', () => {
  const router = createRouter({ providers: [provider()] });
  const fast = router.select({ mode: 'fast' });
  const complex = router.select({ mode: 'complex' });
  assert.equal(fast.ok && fast.value.ref.modelId, 'fast');
  assert.equal(complex.ok && complex.value.ref.modelId, 'deep');
  assert.deepEqual(router.report('complex').route.map((ref) => ref.modelId), ['deep', 'fast']);
});

test('tool-capable and vision requirements exclude a model that cannot serve', () => {
  const router = createRouter({ providers: [provider()] });
  const tools = router.select({ mode: 'fast', requireTools: true });
  assert.equal(tools.ok && tools.value.ref.modelId, 'deep');
  const vision = router.select({ mode: 'auto', requireVision: true });
  assert.equal(vision.ok && vision.value.ref.modelId, 'deep');
});

test('a paid or unverified model is refused, never substituted', () => {
  const paid = provider({
    models: [
      {
        ref: { providerId: 'free', modelId: 'paid' },
        label: 'Paid',
        costClass: 'paid',
        profile: { coding: 1, reasoning: 1, speed: 1, toolCalling: true, multimodal: true, contextTokens: 128_000 },
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
    ],
  });
  const router = createRouter({ providers: [paid] });
  const requested = router.select({ mode: 'auto', requested: { providerId: 'free', modelId: 'paid' } });
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');
  assert.equal(router.select({ mode: 'auto' }).ok, false);

  const unverified = createRouter({ providers: [provider({ costEvidence: 'unverified' })] });
  const result = unverified.select({ mode: 'auto' });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'model_missing');
});

test('daily quota exhaustion fails closed instead of routing wider', () => {
  let now = new Date('2026-11-26T10:00:00.000Z');
  const only = provider({ quota: { requestsPerMinute: 2, requestsPerDay: 2, tokensPerDay: 100 } });
  const router = createRouter({
    providers: [{ ...only, models: (only.models ?? []).slice(0, 1) }],
    now: () => now,
  });
  const first = router.select({ mode: 'fast' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(router.reserve(first.value, now).ok, true);
  assert.equal(router.reserve(first.value, now).ok, true);
  assert.equal(router.reserve(first.value, now).ok, false);
  assert.equal(router.select({ mode: 'fast' }).ok, false);

  now = new Date('2026-11-27T00:00:01.000Z');
  assert.equal(router.select({ mode: 'fast' }).ok, true);
});

test('a retryable provider failure falls back to the next approved free model', async () => {
  const primary: ProviderDescriptor = {
    id: 'alpha',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [
      {
        ref: { providerId: 'alpha', modelId: 'deep' },
        label: 'Alpha deep',
        costClass: 'free',
        profile: { coding: 0.9, reasoning: 1, speed: 0.2, toolCalling: true, multimodal: false, contextTokens: 32_000 },
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
    ],
  };
  const secondary: ProviderDescriptor = {
    id: 'beta',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [
      {
        ref: { providerId: 'beta', modelId: 'fast' },
        label: 'Beta fast',
        costClass: 'free',
        profile: { coding: 0.2, reasoning: 0.1, speed: 1, toolCalling: false, multimodal: false, contextTokens: 8192 },
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
    ],
  };
  const router = createRouter({ providers: [primary, secondary] });
  const calls: string[] = [];
  const failing: ModelGateway = {
    id: 'primary',
    complete: async () => {
      calls.push('primary');
      throw new Error('provider responded with HTTP 429');
    },
  };
  const succeeding: ModelGateway = {
    id: 'secondary',
    complete: async ({ model }) => {
      calls.push(model.modelId);
      return { text: 'fallback answer', usage: { inputTokens: 2, outputTokens: 3 } };
    },
  };
  const gateway = createRoutedGateway({
    router,
    gateways: new Map([
      ['alpha', failing],
      ['beta', succeeding],
    ]),
    maxFallbacks: 1,
  });
  const completion = await gateway.complete({
    model: { providerId: 'alpha', modelId: 'deep' },
    system: 'system',
    prompt: 'prompt',
    signal: new AbortController().signal,
  });
  assert.equal(completion.text, 'fallback answer');
  assert.deepEqual(calls, ['primary', 'fast']);
});

test('an exhausted route is a stable fail-closed error', async () => {
  const router = createRouter({ providers: [provider({ quota: { requestsPerMinute: 1, requestsPerDay: 1, tokensPerDay: 10_000 } })] });
  const gateway = createRoutedGateway({
    router,
    gateways: new Map([
      [
        'free',
        {
          id: 'failing',
          complete: async () => {
            throw new Error('provider responded with HTTP 503');
          },
        },
      ],
    ]),
    maxFallbacks: 1,
  });
  await assert.rejects(
    () =>
      gateway.complete({
        model: { providerId: 'free', modelId: 'deep' },
        system: 'system',
        prompt: 'prompt',
        signal: new AbortController().signal,
      }),
    (error: unknown) => isRouterExhausted(error),
  );
});
