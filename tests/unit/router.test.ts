import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderDescriptor, ProviderModel } from '../../src/models/router.js';
import { createRouter } from '../../src/models/router.js';
import { createCircuitBreakers } from '../../src/models/circuit.js';
import { createRoutedGateway, isRouterExhausted } from '../../src/models/routed.js';
import type { ModelGateway } from '../../src/agents/native/types.js';

const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function verified(): ProviderModel['eligibility'] {
  return {
    costClass: 'free',
    verifiedFree: true,
    reason: 'verified_zero_price_list',
    source: 'https://provider.example/pricing',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function entry(
  providerId: string,
  modelId: string,
  profile: ProviderModel['profile'],
  overrides?: Partial<ProviderModel>,
): ProviderModel {
  const eligibility = overrides?.eligibility ?? verified();
  return {
    ref: { providerId, modelId },
    label: modelId,
    costClass: eligibility.costClass,
    eligibility,
    profile,
    limits: {
      requestsPerMinute: 10,
      requestsPerDay: 10,
      tokensPerDay: 10_000,
      concurrentRequests: 1,
    },
    availability: ready,
    ...(overrides ?? {}),
  };
}

function provider(overrides?: Partial<ProviderDescriptor>): ProviderDescriptor {
  return {
    id: 'free',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [
      entry('free', 'fast', {
        coding: 0.2,
        reasoning: 0.1,
        speed: 1,
        toolCalling: false,
        multimodal: false,
        contextTokens: 8192,
      }),
      entry('free', 'deep', {
        coding: 0.9,
        reasoning: 1,
        speed: 0.2,
        toolCalling: true,
        multimodal: true,
        contextTokens: 32_000,
      }),
    ],
    ...(overrides ?? {}),
  };
}

function isolated(
  id: string,
  modelId: string,
  profile: ProviderModel['profile'],
): ProviderDescriptor {
  return {
    id,
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [entry(id, modelId, profile)],
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

test('a paid model is refused, never substituted', () => {
  const paid = provider({
    models: [
      entry('free', 'paid', {
        coding: 1,
        reasoning: 1,
        speed: 1,
        toolCalling: true,
        multimodal: true,
        contextTokens: 128_000,
      }, {
        costClass: 'paid',
        eligibility: { costClass: 'paid', verifiedFree: false, reason: 'price_not_zero' },
      }),
    ],
  });
  const router = createRouter({ providers: [paid] });
  const requested = router.select({ mode: 'auto', requested: { providerId: 'free', modelId: 'paid' } });
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');
  assert.equal(router.select({ mode: 'auto' }).ok, false);
});

test('a provider-level verified flag cannot admit an unverified model', () => {
  const labelled = provider({
    models: [
      entry('free', 'unverified', {
        coding: 1,
        reasoning: 1,
        speed: 1,
        toolCalling: true,
        multimodal: true,
        contextTokens: 128_000,
      }, {
        eligibility: { costClass: 'free', verifiedFree: false, reason: 'terms_missing' },
      }),
    ],
  });
  // The descriptor still claims `free`; the evidence does not, so nothing routes.
  assert.equal(labelled.costEvidence, 'verified-free');
  const router = createRouter({ providers: [labelled] });
  assert.equal(router.select({ mode: 'auto' }).ok, false);
});

test('daily quota exhaustion fails closed instead of routing wider', () => {
  let now = new Date('2026-11-26T10:00:00.000Z');
  const only = provider({ quota: { requestsPerMinute: 2, requestsPerDay: 2, tokensPerDay: 100 } });
  const router = createRouter({
    providers: [{ ...only, models: only.models.slice(0, 1) }],
    now: () => now,
  });
  const first = router.select({ mode: 'fast' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(router.reserve(first.value, now, 1).ok, true);
  assert.equal(router.reserve(first.value, now, 1).ok, true);
  assert.equal(router.reserve(first.value, now, 1).ok, false);
  assert.equal(router.select({ mode: 'fast' }).ok, false);

  now = new Date('2026-11-27T00:00:01.000Z');
  assert.equal(router.select({ mode: 'fast' }).ok, true);
});

test('a token reservation larger than the provider ceiling is refused', () => {
  const router = createRouter({ providers: [provider()] });
  const selected = router.select({ mode: 'fast' });
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(router.reserve(selected.value, new Date(), 10_001).ok, false);
});

test('an open circuit stops routing to the failing model', () => {
  const model = entry('free', 'deep', {
    coding: 0.9,
    reasoning: 1,
    speed: 0.2,
    toolCalling: true,
    multimodal: false,
    contextTokens: 32_000,
  });
  const only: ProviderDescriptor = {
    id: 'free',
    costEvidence: 'verified-free',
    quota: { requestsPerMinute: 10, requestsPerDay: 10, tokensPerDay: 10_000 },
    models: [model],
  };
  const circuits = createCircuitBreakers({ failureThreshold: 2, cooldownMs: 30_000 });
  let now = new Date('2026-11-26T10:00:00.000Z');
  const router = createRouter({ providers: [only], circuits, now: () => now });

  router.recordFailure(model, now);
  assert.equal(router.select({ mode: 'auto' }).ok, true);
  router.recordFailure(model, now);
  const broken = router.select({ mode: 'auto' });
  assert.equal(broken.ok, false);
  assert.equal(router.health(now).providers[0]?.models[0]?.circuit, 'open');

  // Half-open after the cooldown, closed again by one success.
  now = new Date('2026-11-26T10:00:31.000Z');
  assert.equal(router.select({ mode: 'auto' }).ok, true);
  router.recordSuccess(model);
  assert.equal(router.health(now).providers[0]?.models[0]?.circuit, 'closed');
});

test('a provider retry-after parks the provider until its own reset', () => {
  let now = new Date('2026-11-26T10:00:00.000Z');
  const one = isolated('alpha', 'deep', {
    coding: 0.9,
    reasoning: 1,
    speed: 0.2,
    toolCalling: false,
    multimodal: false,
    contextTokens: 32_000,
  });
  const router = createRouter({ providers: [one], now: () => now });
  const model = one.models[0];
  assert.ok(model);
  router.recordFailure(model, now, 120_000);
  assert.equal(router.select({ mode: 'auto' }).ok, false);

  now = new Date('2026-11-26T10:01:59.000Z');
  assert.equal(router.select({ mode: 'auto' }).ok, false);
  now = new Date('2026-11-26T10:02:01.000Z');
  assert.equal(router.select({ mode: 'auto' }).ok, true);
});

test('a retryable provider failure falls back to the next verified free model', async () => {
  const primary = isolated('alpha', 'deep', {
    coding: 0.9,
    reasoning: 1,
    speed: 0.2,
    toolCalling: true,
    multimodal: false,
    contextTokens: 32_000,
  });
  const secondary = isolated('beta', 'fast', {
    coding: 0.2,
    reasoning: 0.1,
    speed: 1,
    toolCalling: false,
    multimodal: false,
    contextTokens: 8192,
  });
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

test('a provider that reports no usage is still accounted for', async () => {
  const one = isolated('alpha', 'deep', {
    coding: 0.9,
    reasoning: 1,
    speed: 0.2,
    toolCalling: false,
    multimodal: false,
    contextTokens: 32_000,
  });
  const router = createRouter({ providers: [one] });
  const gateway = createRoutedGateway({
    router,
    gateways: new Map([
      ['alpha', { id: 'alpha', complete: async () => ({ text: 'twelve chars' }) }],
    ]),
    maxFallbacks: 0,
  });
  const completion = await gateway.complete({
    model: { providerId: 'alpha', modelId: 'deep' },
    system: 'system prompt',
    prompt: 'a prompt',
    toolSchemaText: '{"name":"fs.read"}',
    signal: new AbortController().signal,
  });
  assert.ok(completion.usage?.inputTokens && completion.usage.inputTokens > 0);
  assert.ok(completion.usage?.outputTokens && completion.usage.outputTokens > 0);
});
