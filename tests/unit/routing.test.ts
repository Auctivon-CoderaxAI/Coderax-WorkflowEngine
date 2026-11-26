import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createModelRouter, inferRoutingMode, type ModelRouter } from '../../src/models/router.js';
import type {
  BenchmarkScore,
  DiscoveredModel,
  GatewayStreamEvent,
  ProviderAdapter,
  ProviderCompletion,
  ProviderCompletionRequest,
  ProviderSettings,
  ProviderStreamEvent,
} from '../../src/models/types.js';
import { ModelRoutingError, ProviderError } from '../../src/models/types.js';

const SETTINGS: ProviderSettings = {
  requestsPerMinute: 100,
  tokensPerMinute: 1_000_000,
  maxConcurrency: 4,
  requestTimeoutMs: 1_000,
  discoveryIntervalMs: 60_000,
};

function freeModel(id: string, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    ref: { providerId: 'p', modelId: id },
    label: id,
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: false, toolCalling: true, reasoning: true, streaming: true },
    pricing: { prompt: '0', completion: '0', request: '0' },
    ...overrides,
  };
}

function adapter(input: {
  id?: string;
  models: DiscoveredModel[] | (() => DiscoveredModel[]);
  complete?: (request: ProviderCompletionRequest) => Promise<ProviderCompletion>;
  stream?: (request: ProviderCompletionRequest) => AsyncIterable<ProviderStreamEvent>;
  discover?: () => Promise<DiscoveredModel[]>;
}): ProviderAdapter & { calls: number } {
  const provider = {
    id: input.id ?? 'p',
    kind: 'openai' as const,
    calls: 0,
    discover: async () => {
      if (input.discover) return input.discover();
      return typeof input.models === 'function' ? input.models() : input.models;
    },
    complete: async (request: ProviderCompletionRequest) => {
      provider.calls += 1;
      if (input.complete) return input.complete(request);
      return { text: `ok:${request.model.modelId}`, toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } };
    },
    ...(input.stream ? { stream: input.stream } : {}),
  };
  return provider;
}

function budget(maxRequests = 100, maxTokens = 1_000_000) {
  return createBudgetLedger({ maxRequestsPerDay: maxRequests, maxTokensPerDay: maxTokens });
}

function router(input: {
  adapters: Array<ProviderAdapter & { calls?: number }>;
  models?: DiscoveredModel[];
  attestations?: Parameters<typeof createModelRouter>[0]['attestations'];
  benchmarks?: BenchmarkScore[];
  preferredRoute?: Parameters<typeof createModelRouter>[0]['preferredRoute'];
  now?: () => Date;
  maxFallbacks?: number;
  maxCandidates?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  settings?: Partial<ProviderSettings>;
  ledger?: ReturnType<typeof budget>;
}): ModelRouter {
  return createModelRouter({
    providers: input.adapters.map((entry) => ({
      adapter: entry,
      settings: { ...SETTINGS, ...(input.settings ?? {}) },
    })),
    ...(input.attestations === undefined ? {} : { attestations: input.attestations }),
    ...(input.benchmarks === undefined ? {} : { benchmarks: input.benchmarks }),
    ...(input.preferredRoute === undefined ? {} : { preferredRoute: input.preferredRoute }),
    ...(input.now === undefined ? {} : { now: input.now }),
    maxFallbacks: input.maxFallbacks ?? 2,
    maxCandidates: input.maxCandidates ?? 4,
    failureThreshold: input.failureThreshold ?? 3,
    cooldownMs: input.cooldownMs ?? 30_000,
    budget: input.ledger ?? budget(),
  });
}

function benchmark(modelId: string, coding: number, reasoning: number): BenchmarkScore {
  return {
    providerId: 'p',
    modelId,
    suite: 'fixture-suite',
    suiteDigest: `sha256:${'a'.repeat(64)}`,
    measuredAt: new Date(Date.now() - 86_400_000).toISOString(),
    samples: 8,
    coding,
    reasoning,
  };
}

const request = (modelId: string, prompt = 'hello', providerId = 'p') => ({
  ownerId: 'owner',
  model: { providerId, modelId },
  mode: 'cloud' as const,
  routing: 'auto' as const,
  allowFallback: false,
  system: 'system',
  prompt,
  signal: new AbortController().signal,
});

test('only a zero price list or a live attestation establishes free cost', async () => {
  const free = freeModel('free');
  const paid = freeModel('paid', { ref: { providerId: 'p', modelId: 'paid' }, pricing: { prompt: '0.000001', completion: '0.000002' } });
  const negative = freeModel('negative', { ref: { providerId: 'p', modelId: 'negative' }, pricing: { prompt: '-1', completion: '0' } });
  const unknown = freeModel('unknown', { ref: { providerId: 'p', modelId: 'unknown' }, pricing: null });
  const engine = router({
    adapters: [adapter({ models: [free, paid, negative, unknown] })],
    preferredRoute: [paid.ref],
  });
  await engine.refresh();
  assert.deepEqual(engine.route(), [free.ref]);
  assert.equal(engine.resolve(paid.ref, 'cloud').ok, false);
  assert.equal(engine.resolve(negative.ref, 'cloud').ok, false);
  assert.equal(engine.resolve(unknown.ref, 'cloud').ok, false);
});

test('a provider key is irrelevant: no price and no attestation fails closed', async () => {
  const model = freeModel('unpriced', { pricing: null });
  const engine = router({ adapters: [adapter({ models: [model] })] });
  await engine.refresh();
  assert.deepEqual(engine.route(), []);
  const resolved = engine.resolve(null, 'cloud');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'model_missing');
  // An unknown cost is reported as paid, so an explicit request is refused by
  // the paid-model gate rather than treated as a missing free model.
  await assert.rejects(
    () => engine.complete(request('unpriced')),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'paid_model_refused',
  );
});

test('an unexpired exact-model attestation is accepted and expiry is not', async () => {
  const model = freeModel('unpriced', { pricing: null });
  const now = new Date('2026-11-26T12:00:00.000Z');
  const valid = {
    providerId: 'p',
    modelId: 'unpriced',
    evidenceUrl: 'https://provider.example/free-tier',
    verifiedAt: '2026-11-20T00:00:00.000Z',
    expiresAt: '2026-12-20T00:00:00.000Z',
  };
  const accepted = router({
    adapters: [adapter({ models: [model] })],
    attestations: [valid],
    now: () => now,
  });
  await accepted.refresh();
  assert.deepEqual(accepted.route(), [model.ref]);

  const expired = router({
    adapters: [adapter({ models: [model] })],
    attestations: [{ ...valid, expiresAt: '2026-11-25T00:00:00.000Z' }],
    now: () => now,
  });
  await expired.refresh();
  assert.deepEqual(expired.route(), []);
});

test('an attestation expiry between refreshes stops routing immediately', async () => {
  let now = new Date('2026-11-26T12:00:00.000Z');
  const model = freeModel('unpriced', {
    ref: { providerId: 'p', modelId: 'unpriced' },
    pricing: null,
  });
  const engine = router({
    adapters: [adapter({ models: [model] })],
    attestations: [
      {
        providerId: 'p',
        modelId: 'unpriced',
        evidenceUrl: 'https://provider.example/free-tier',
        verifiedAt: '2026-11-20T00:00:00.000Z',
        expiresAt: '2026-11-26T13:00:00.000Z',
      },
    ],
    now: () => now,
  });
  await engine.refresh();
  assert.equal(engine.route().length, 1);
  now = new Date('2026-11-26T14:00:00.000Z');
  assert.equal(engine.route().length, 0);
  assert.equal(engine.hasVerifiedFreeRoute(), false);
  const resolved = engine.resolve(null, 'cloud');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.code, 'model_missing');
});

test('benchmark evidence upgrades coding and reasoning; unmeasured coding stays unknown', async () => {
  const measured = freeModel('measured', { ref: { providerId: 'p', modelId: 'measured' } });
  const unmeasured = freeModel('unmeasured', { ref: { providerId: 'p', modelId: 'unmeasured' } });
  const engine = router({
    adapters: [adapter({ models: [measured, unmeasured] })],
    benchmarks: [benchmark('measured', 0.9, 0.8)],
    preferredRoute: [measured.ref, unmeasured.ref],
  });
  await engine.refresh();
  const plan = engine.plan({ mode: 'cloud', routing: 'complex' });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const byId = new Map(plan.value.candidates.map((entry) => [entry.model.ref.modelId, entry.model]));
  assert.equal(byId.get('measured')?.capabilities.coding, 'verified');
  assert.equal(byId.get('measured')?.capabilities.reasoning, 'verified');
  assert.equal(byId.get('unmeasured')?.capabilities.coding, 'unknown');
  assert.equal(byId.get('unmeasured')?.capabilities.reasoning, 'declared');
  assert.equal(plan.value.candidates[0]?.model.ref.modelId, 'measured');
});

test('Fast prefers measured latency, Complex prefers measured quality, Auto balances', async () => {
  const fast = freeModel('fast', { ref: { providerId: 'p', modelId: 'fast' } });
  const quality = freeModel('quality', { ref: { providerId: 'p', modelId: 'quality' } });
  const latencyAdapter = adapter({
    models: [fast, quality],
    complete: async (incoming) => {
      await new Promise((resolve) =>
        setTimeout(resolve, incoming.model.modelId === 'fast' ? 1 : 25),
      );
      return {
        text: incoming.model.modelId,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  const engine = router({
    adapters: [latencyAdapter],
    benchmarks: [benchmark('quality', 1, 1)],
    preferredRoute: [fast.ref, quality.ref],
  });
  await engine.refresh();
  await engine.complete(request('fast'));
  await engine.complete(request('quality'));

  assert.equal(engine.route('fast')[0]?.modelId, 'fast');
  assert.equal(engine.route('complex')[0]?.modelId, 'quality');
  assert.equal(engine.route('auto').length, 2);
});

test('an automatic preference that no longer fits falls back instead of failing', async () => {
  const small = freeModel('small', {
    ref: { providerId: 'p', modelId: 'small' },
    contextTokens: 300,
    maxOutputTokens: 100,
  });
  const large = freeModel('large', {
    ref: { providerId: 'p', modelId: 'large' },
    contextTokens: 20_000,
  });
  const engine = router({ adapters: [adapter({ models: [small, large] })], preferredRoute: [small.ref, large.ref] });
  await engine.refresh();
  const completed = await engine.complete({
    ownerId: 'owner',
    model: small.ref,
    mode: 'cloud',
    allowFallback: true,
    system: 's',
    prompt: 'x'.repeat(2_000),
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  });
  assert.deepEqual(completed.model, large.ref);
});

test('context validation excludes a model that cannot hold the request and its output', async () => {
  const small = freeModel('small', {
    ref: { providerId: 'p', modelId: 'small' },
    contextTokens: 300,
    maxOutputTokens: 100,
  });
  const large = freeModel('large', {
    ref: { providerId: 'p', modelId: 'large' },
    contextTokens: 20_000,
  });
  const engine = router({ adapters: [adapter({ models: [small, large] })], preferredRoute: [small.ref, large.ref] });
  await engine.refresh();
  const longPrompt = 'x'.repeat(2_000);
  const planned = engine.plan({
    mode: 'cloud',
    routing: 'auto',
    estimatedInputTokens: 800,
    maxOutputTokens: 100,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.deepEqual(planned.value.candidates.map((entry) => entry.model.ref.modelId), ['large']);
  const rejected = engine.resolve(small.ref, 'cloud', {
    estimatedInputTokens: 800,
    maxOutputTokens: 100,
  });
  assert.equal(rejected.ok, false);
  // An oversized request never reaches a provider.
  await assert.rejects(
    () =>
      engine.complete({
        ownerId: 'owner',
        model: small.ref,
        mode: 'cloud',
        allowFallback: false,
        system: 's',
        prompt: longPrompt,
        maxOutputTokens: 100,
        signal: new AbortController().signal,
      }),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'model_missing',
  );
});

test('a request and token budget fails closed without calling the provider', async () => {
  const provider = adapter({ models: [freeModel('only')] });
  const engine = router({ adapters: [provider], ledger: budget(1, 1_000_000) });
  await engine.refresh();
  await engine.complete(request('only'));
  assert.equal(provider.calls, 1);
  await assert.rejects(
    () => engine.complete(request('only')),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'budget_exhausted',
  );
  assert.equal(provider.calls, 1);
});

test('the local provider ceiling is per provider and avoids the call', async () => {
  const provider = adapter({ models: [freeModel('only')] });
  const engine = router({
    adapters: [provider],
    settings: { requestsPerMinute: 1 },
  });
  await engine.refresh();
  await engine.complete(request('only'));
  await assert.rejects(
    () => engine.complete(request('only')),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'engine_unavailable',
  );
  assert.equal(provider.calls, 1);
});

test('quota exhaustion cools the provider down and fallback uses another free model', async () => {
  const a = adapter({
    id: 'a',
    models: [freeModel('a', { ref: { providerId: 'a', modelId: 'a' } })],
    complete: async () => {
      throw new ProviderError('quota', 'free allowance exhausted', {
        retryAfterMs: 60_000,
        quotaExhausted: true,
      });
    },
  });
  const b = adapter({
    id: 'b',
    models: [freeModel('b', { ref: { providerId: 'b', modelId: 'b' } })],
  });
  const engine = router({
    adapters: [a, b],
    preferredRoute: [
      { providerId: 'a', modelId: 'a' },
      { providerId: 'b', modelId: 'b' },
    ],
  });
  await engine.refresh();
  const completed = await engine.complete({
    ...request('a', 'hello', 'a'),
    allowFallback: true,
  });
  assert.deepEqual(completed.model, { providerId: 'b', modelId: 'b' });
  assert.deepEqual(completed.attempts, [
    { providerId: 'a', modelId: 'a' },
    { providerId: 'b', modelId: 'b' },
  ]);
  const health = engine.health();
  const providerA = health.providers.find((entry) => entry.providerId === 'a');
  assert.ok(providerA?.quotaUntil);
  assert.deepEqual(engine.route().map((ref) => ref.providerId), ['b']);
});

test('a circuit opens after repeated failures and a half-open probe recovers it', async () => {
  let now = new Date('2026-11-26T12:00:00.000Z');
  let fail = true;
  const provider = adapter({
    models: [freeModel('only')],
    complete: async () => {
      if (fail) throw new ProviderError('server', 'unavailable', { retryable: true });
      return { text: 'recovered', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  const engine = router({
    adapters: [provider],
    now: () => now,
    failureThreshold: 2,
    cooldownMs: 5_000,
  });
  await engine.refresh();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => engine.complete(request('only')));
  }
  assert.equal(engine.hasVerifiedFreeRoute(), false);
  assert.equal(engine.health().models[0]?.circuit, 'open');

  now = new Date(now.getTime() + 5_001);
  fail = false;
  const completed = await engine.complete(request('only'));
  assert.equal(completed.text, 'recovered');
  assert.equal(engine.health().models[0]?.circuit, 'closed');
});

test('fallback is bounded to maxFallbacks and never falls through every provider', async () => {
  const providers = ['a', 'b', 'c'].map((id) =>
    adapter({
      id,
      models: [freeModel(id, { ref: { providerId: id, modelId: id } })],
      complete: async () => {
        throw new ProviderError('server', 'unavailable', { retryable: true });
      },
    }),
  );
  const engine = router({
    adapters: providers,
    maxFallbacks: 1,
    maxCandidates: 4,
    failureThreshold: 10,
    preferredRoute: providers.map((provider) => ({ providerId: provider.id, modelId: provider.id })),
  });
  await engine.refresh();
  await assert.rejects(
    () =>
      engine.complete({
        ...request('a', 'hello', 'a'),
        allowFallback: true,
      }),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'engine_unavailable',
  );
  assert.equal(providers.reduce((total, provider) => total + provider.calls, 0), 2);
});

test('refresh removes a model that is no longer free', async () => {
  let pricing: Record<string, unknown> = { prompt: '0', completion: '0' };
  const model = freeModel('changing', { pricing });
  const provider = adapter({ models: (): DiscoveredModel[] => [{ ...model, pricing }] });
  const engine = router({ adapters: [provider] });
  await engine.refresh();
  assert.equal(engine.route().length, 1);

  pricing = { prompt: '0.00001', completion: '0.00001' };
  await engine.refresh();
  assert.equal(engine.route().length, 0);
  const resolved = engine.resolve(model.ref, 'cloud');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'paid_model_refused');
});

test('a discovery failure excludes every model from that provider', async () => {
  let fail = false;
  const provider = adapter({
    models: [freeModel('only')],
    discover: async () => {
      if (fail) throw new ProviderError('server', 'discovery failed', { retryable: true });
      return [freeModel('only')];
    },
  });
  const engine = router({ adapters: [provider] });
  await engine.refresh();
  assert.equal(engine.hasVerifiedFreeRoute(), true);
  fail = true;
  await engine.refresh();
  assert.equal(engine.hasVerifiedFreeRoute(), false);
  assert.equal(engine.route().length, 0);
  assert.equal(engine.health().providers[0]?.available, false);
  assert.equal(engine.health().providers[0]?.verifiedFreeModels, 0);
});

test('the router normalizes a provider stream and records health', async () => {
  const model = freeModel('streamed');
  const provider = adapter({
    models: [model],
    complete: async () => ({ text: 'fallback', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
    stream: async function* () {
      yield { type: 'text', text: 'he' };
      yield { type: 'text', text: 'llo' };
      yield { type: 'tool', call: { id: 'c1', name: 'read', arguments: { path: 'a' } } };
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  });
  const engine = router({ adapters: [provider] });
  await engine.refresh();
  const events: GatewayStreamEvent[] = [];
  for await (const event of engine.stream(request('streamed'))) events.push(event);
  assert.equal(events.filter((event) => event.type === 'model').length, 1);
  assert.equal(
    events.filter((event) => event.type === 'text').map((event) => (event.type === 'text' ? event.text : '')).join(''),
    'hello',
  );
  assert.equal(events.filter((event) => event.type === 'tool').length, 1);
  const health = engine.health();
  assert.equal(health.models[0]?.attempts, 1);
  assert.equal(health.models[0]?.successes, 1);
  assert.ok((health.models[0]?.latencyMs ?? 0) >= 0);
});

test('an abandoned half-open stream probe does not strand the circuit', async () => {
  const model = freeModel('streamed');
  let fail = true;
  const provider = adapter({
    models: [model],
    complete: async () => {
      if (fail) {
        fail = false;
        throw new ProviderError('server', 'first call fails', { retryable: true });
      }
      return { text: 'recovered', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    stream: async function* () {
      yield { type: 'text' as const, text: 'first' };
      yield { type: 'text' as const, text: 'never read' };
    },
  });
  let current = new Date('2026-11-26T12:00:00.000Z');
  const engine = router({
    adapters: [provider],
    failureThreshold: 1,
    cooldownMs: 1_000,
    now: () => current,
  });
  await engine.refresh();

  await assert.rejects(
    () => engine.complete(request('streamed')),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'engine_unavailable',
  );
  current = new Date(current.getTime() + 2_000);
  for await (const event of engine.stream(request('streamed'))) {
    if (event.type === 'text') break;
  }
  const recovered = await engine.complete(request('streamed'));
  assert.equal(recovered.text, 'recovered');
});

test('stopping on the model event releases an unused reservation', async () => {
  const model = freeModel('streamed');
  const ledger = budget(1);
  const provider = adapter({
    models: [model],
    stream: async function* () {
      yield { type: 'text' as const, text: 'not reached' };
    },
  });
  const engine = router({ adapters: [provider], ledger });
  await engine.refresh();

  for await (const event of engine.stream(request('streamed'))) {
    if (event.type === 'model') break;
  }

  const completed = await engine.complete(request('streamed'));
  assert.equal(completed.text, 'ok:streamed');
  assert.equal(ledger.snapshot('owner', new Date()).requests, 1);
});

test('stopping a stream early releases the provider slot and settles the reservation', async () => {
  const model = freeModel('streamed');
  const ledger = budget();
  const provider = adapter({
    models: [model],
    stream: async function* () {
      yield { type: 'text' as const, text: 'first' };
      yield { type: 'text' as const, text: 'never read' };
    },
  });
  const engine = router({
    adapters: [provider],
    ledger,
    settings: { maxConcurrency: 1 },
  });
  await engine.refresh();

  for await (const event of engine.stream(request('streamed'))) {
    if (event.type === 'text') break;
  }

  // A leaked slot makes this fail with the local concurrency ceiling; a leaked
  // reservation leaves the request count at one instead of two.
  const completed = await engine.complete(request('streamed'));
  assert.equal(completed.text, 'ok:streamed');
  assert.equal(ledger.snapshot('owner', new Date()).requests, 2);
});

test('streaming fails over only before the first token', async () => {
  const a = adapter({
    id: 'a',
    models: [freeModel('a', { ref: { providerId: 'a', modelId: 'a' } })],
    complete: async () => ({ text: 'unused', toolCalls: [], usage: {} }),
    stream: async function* () {
      throw new ProviderError('server', 'stream unavailable', { retryable: true });
    },
  });
  const b = adapter({
    id: 'b',
    models: [freeModel('b', { ref: { providerId: 'b', modelId: 'b' } })],
    complete: async () => ({ text: 'unused', toolCalls: [], usage: {} }),
    stream: async function* () {
      yield { type: 'text', text: 'from b' };
      yield { type: 'done' };
    },
  });
  const engine = router({
    adapters: [a, b],
    preferredRoute: [
      { providerId: 'a', modelId: 'a' },
      { providerId: 'b', modelId: 'b' },
    ],
  });
  await engine.refresh();
  const events: GatewayStreamEvent[] = [];
  for await (const event of engine.stream({
    ...request('a', 'hello', 'a'),
    allowFallback: true,
  })) events.push(event);
  assert.ok(events.some((event) => event.type === 'text' && event.text === 'from b'));
});

test('a token-refused candidate falls back to a smaller free cap without consuming provider rate', async () => {
  const big = freeModel('big', { ref: { providerId: 'p', modelId: 'big' }, maxOutputTokens: 1_000 });
  const small = freeModel('small', { ref: { providerId: 'p', modelId: 'small' }, maxOutputTokens: 100 });
  const provider = adapter({ models: [big, small] });
  const ledger = budget(10, 250);
  const engine = router({
    adapters: [provider],
    preferredRoute: [big.ref, small.ref],
    ledger,
    settings: { requestsPerMinute: 1 },
  });
  await engine.refresh();
  const completed = await engine.complete({ ...request('big'), allowFallback: true });
  assert.deepEqual(completed.model, small.ref);
  assert.equal(provider.calls, 1);
  assert.equal(ledger.snapshot('owner', new Date()).requests, 1);
});

test('readiness requires a candidate that fits the default route context', async () => {
  const tiny = freeModel('tiny', { contextTokens: 500, maxOutputTokens: 4_096 });
  const engine = router({ adapters: [adapter({ models: [tiny] })] });
  await engine.refresh();
  assert.deepEqual(engine.route(), []);
  assert.equal(engine.hasVerifiedFreeRoute(), false);
});

test('a cancelled stream after output keeps the request charge', async () => {
  const model = freeModel('streamed');
  const ledger = budget();
  const provider = adapter({
    models: [model],
    stream: async function* () {
      yield { type: 'text' as const, text: 'partial' };
      throw new ProviderError('cancelled', 'cancelled');
    },
  });
  const engine = router({ adapters: [provider], ledger });
  await engine.refresh();
  await assert.rejects(
    async () => {
      for await (const _event of engine.stream(request('streamed'))) {
        // consume until the provider fails
      }
    },
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'cancelled',
  );
  assert.equal(ledger.snapshot('owner', new Date()).requests, 1);
});

test('a successful discovery does not close an open inference circuit', async () => {
  const now = new Date('2026-11-26T12:00:00.000Z');
  const provider = adapter({
    models: [freeModel('only')],
    complete: async () => {
      throw new ProviderError('server', 'unavailable', { retryable: true });
    },
  });
  const engine = router({
    adapters: [provider],
    now: () => now,
    failureThreshold: 1,
    cooldownMs: 5_000,
  });
  await engine.refresh();
  await assert.rejects(() => engine.complete(request('only')));
  assert.equal(engine.health().providers[0]?.circuit, 'open');
  await engine.refresh();
  assert.equal(engine.health().providers[0]?.circuit, 'open');
});

test('explicit resolution enforces vision and tool capabilities', async () => {
  const textOnly = freeModel('text-only', {
    capabilities: { vision: false, toolCalling: false, reasoning: false, streaming: true },
  });
  const engine = router({ adapters: [adapter({ models: [textOnly] })] });
  await engine.refresh();
  assert.equal(engine.resolve(textOnly.ref, 'cloud', { requireVision: true }).ok, false);
  assert.equal(engine.resolve(textOnly.ref, 'cloud', { requireTools: true }).ok, false);
  assert.equal(engine.resolve(textOnly.ref, 'cloud').ok, true);
});

test('a stale attestation does not mask a later active attestation', async () => {
  const now = new Date('2026-11-26T12:00:00.000Z');
  const model = freeModel('attested', { pricing: null });
  const engine = router({
    adapters: [adapter({ models: [model] })],
    attestations: [
      {
        providerId: 'p',
        modelId: 'attested',
        evidenceUrl: 'https://provider.example/old',
        verifiedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      },
      {
        providerId: 'p',
        modelId: 'attested',
        evidenceUrl: 'https://provider.example/current',
        verifiedAt: '2026-11-20T00:00:00.000Z',
        expiresAt: '2026-12-20T00:00:00.000Z',
      },
    ],
    now: () => now,
  });
  await engine.refresh();
  assert.deepEqual(engine.route(), [model.ref]);
});

test('an underflowing nonzero published price is not free', async () => {
  const underflow = freeModel('underflow', { pricing: { prompt: '1e-400', completion: '0' } });
  const engine = router({ adapters: [adapter({ models: [underflow] })] });
  await engine.refresh();
  assert.deepEqual(engine.route(), []);
});

test('streaming never falls back after the first output token', async () => {
  let bStarted = false;
  const a = adapter({
    id: 'a',
    models: [freeModel('a', { ref: { providerId: 'a', modelId: 'a' } })],
    stream: async function* () {
      yield { type: 'text' as const, text: 'partial' };
      throw new ProviderError('server', 'stream broke', { retryable: true });
    },
  });
  const b = adapter({
    id: 'b',
    models: [freeModel('b', { ref: { providerId: 'b', modelId: 'b' } })],
    stream: async function* () {
      bStarted = true;
      yield { type: 'text' as const, text: 'duplicate' };
    },
  });
  const engine = router({
    adapters: [a, b],
    preferredRoute: [
      { providerId: 'a', modelId: 'a' },
      { providerId: 'b', modelId: 'b' },
    ],
  });
  await engine.refresh();
  await assert.rejects(
    async () => {
      for await (const _event of engine.stream({ ...request('a', 'hello', 'a'), allowFallback: true })) {
        // consume the partial stream
      }
    },
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'engine_unavailable',
  );
  assert.equal(bStarted, false);
});

test('routing mode inference treats code and long objectives as complex', () => {
  assert.equal(inferRoutingMode({ objective: 'Hi' }), 'fast');
  assert.equal(inferRoutingMode({ objective: 'Explain this function ```const x = 1```' }), 'complex');
  assert.equal(inferRoutingMode({ objective: 'x'.repeat(2_000) }), 'complex');
  assert.equal(inferRoutingMode({ objective: 'Summarize the release notes' }), 'fast');
  assert.equal(inferRoutingMode({ objective: 'Compare the release notes' }), 'auto');
  assert.equal(inferRoutingMode({ objective: 'Use the tool', toolCount: 1 }), 'complex');
});
