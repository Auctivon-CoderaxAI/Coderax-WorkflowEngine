import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createMongoQuotaStore } from '../../src/models/quota.js';
import { createFakeDatabase } from '../fakes/mongo.js';

const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function discovered(
  ref: ModelRef,
  pricing: Record<string, unknown> | null,
  overrides: Partial<DiscoveredModel> = {},
): DiscoveredModel {
  return {
    ref,
    label: `${ref.providerId} ${ref.modelId}`,
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: false, toolCalling: true, reasoning: true, streaming: true },
    pricing,
    ...overrides,
  };
}

function provider(models: DiscoveredModel[], fail = false): ProviderAdapter {
  return {
    id: 'free',
    kind: 'openai',
    discover: async () => models,
    complete: async () => {
      if (fail) throw new ProviderError('server', 'provider unavailable', { retryable: true });
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function budget() {
  return createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 100_000 });
}

function policy(providerId = 'free') {
  return createProviderPolicyRegistry([
    {
      providerId,
      retention: 'transient',
      training: 'prohibited',
      location: 'owner-region',
      credentials: 'deployment-managed',
      modes: ['cloud', 'private'],
      grants: PROCESSING_OPERATIONS.map((operation) => ({
        operation,
        mode: 'cloud' as const,
        location: 'owner-region' as const,
      })),
      evidenceUrl: 'https://provider.example/terms',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ]);
}

const freeRef = { providerId: 'free', modelId: 'coderax:free' };
const paidRef = { providerId: 'paid', modelId: 'gpt-premium' };

test('the route selects the first available verified-free candidate', async () => {
  const router = createModelRouter({
    providers: [{ adapter: provider([discovered(freeRef, { prompt: '0', completion: '0' })]), settings: { requestsPerMinute: 10, tokensPerMinute: 10_000, maxConcurrency: 1, requestTimeoutMs: 1_000, discoveryIntervalMs: 60_000 } }],
    preferredRoute: [freeRef],
    budget: budget(),
    policy: policy(),
  });
  await router.refresh();
  const chosen = router.resolve(null, 'cloud', { operation: 'chat' });
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.ok && chosen.value.ref, freeRef);
  assert.equal(router.list().allowPaid, false);
});

test('a paid model is refused, not silently replaced', async () => {
  const router = createModelRouter({
    providers: [{ adapter: provider([
      discovered(freeRef, { prompt: '0', completion: '0' }),
      discovered(paidRef, { prompt: '0.000001', completion: '0.000002' }),
    ]), settings: { requestsPerMinute: 10, tokensPerMinute: 10_000, maxConcurrency: 1, requestTimeoutMs: 1_000, discoveryIntervalMs: 60_000 } }],
    preferredRoute: [paidRef, freeRef],
    budget: budget(),
    policy: policy(),
  });
  await router.refresh();
  const chosen = router.resolve(paidRef, 'cloud', { operation: 'chat' });
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'paid_model_refused');
  assert.deepEqual(router.route(), [freeRef]);
});

test('an unknown model is refused with a configuration error', async () => {
  const router = createModelRouter({
    providers: [{ adapter: provider([discovered(freeRef, { prompt: '0', completion: '0' })]), settings: { requestsPerMinute: 10, tokensPerMinute: 10_000, maxConcurrency: 1, requestTimeoutMs: 1_000, discoveryIntervalMs: 60_000 } }],
    budget: budget(),
    policy: policy(),
  });
  await router.refresh();
  const chosen = router.resolve({ providerId: 'unknown', modelId: 'x' }, 'cloud', {
    operation: 'chat',
  });
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'engine_not_configured');
});

test('discovery never advertises paid routing', async () => {
  const router = createModelRouter({
    providers: [{ adapter: provider([discovered(freeRef, { prompt: '0', completion: '0' })]), settings: { requestsPerMinute: 10, tokensPerMinute: 10_000, maxConcurrency: 1, requestTimeoutMs: 1_000, discoveryIntervalMs: 60_000 } }],
    budget: budget(),
    policy: policy(),
  });
  await router.refresh();
  assert.equal(router.list().allowPaid, false);
  assert.equal(router.list().models[0]?.availability.available, ready.available);
});

test('an exhausted daily budget fails closed', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal((await ledger.reserve('owner', now)).allowed, true);
  assert.equal((await ledger.reserve('owner', now)).allowed, false);
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  assert.equal((await ledger.reserve('owner', nextDay)).allowed, true);
});

test('two replicas share one durable quota and both limits fail closed', async () => {
  const collection = createFakeDatabase().collection('quota');
  const replicaA = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoQuotaStore({ collection }),
  });
  const replicaB = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoQuotaStore({ collection }),
  });
  const now = new Date('2026-11-26T10:00:00.000Z');

  // The second replica sees the first replica's reservation, so the ceiling is
  // global rather than one budget per process.
  assert.equal((await replicaA.reserve('owner', now)).allowed, true);
  assert.equal((await replicaB.reserve('owner', now)).allowed, true);
  assert.equal((await replicaB.reserve('owner', now)).allowed, false);
  assert.equal((await replicaA.snapshot('owner', now)).requests, 2);

  await replicaB.consume('owner', { inputTokens: 60, outputTokens: 50 }, now);
  assert.equal(await replicaA.available('owner', now), false);
  assert.equal((await replicaA.reserve('owner', now)).allowed, false);
});

test('a concurrent token settlement cannot slip a request past the ceiling', async () => {
  const collection = createFakeDatabase().collection('quota');
  const store = createMongoQuotaStore({ collection });
  const ownerId = 'owner';
  const day = '2026-11-26';
  await store.reserve({ ownerId, day, maxRequests: 2, maxTokens: 100 });

  // Simulate a second replica settling the whole token allowance between this
  // replica's read and its compare-and-swap charge.
  const original = collection.updateOne.bind(collection);
  let injected = false;
  collection.updateOne = async (filter, update, options) => {
    if (!injected && filter._id === `${ownerId}:${day}` && update.$inc && 'requests' in update.$inc) {
      injected = true;
      await store.settle({
        ownerId,
        day,
        usage: { requests: 0, inputTokens: 100, outputTokens: 0 },
      });
    }
    return original(filter, update, options);
  };

  const second = await store.reserve({ ownerId, day, maxRequests: 2, maxTokens: 100 });
  assert.equal(second.allowed, false, 'the token ceiling is part of the atomic charge');
});

test('a released reservation does not charge quota for work that never ran', async () => {
  const collection = createFakeDatabase().collection('quota');
  const ledger = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoQuotaStore({ collection }),
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal((await ledger.reserve('owner', now)).allowed, true);
  assert.equal((await ledger.reserve('owner', now)).allowed, true);
  assert.equal((await ledger.reserve('owner', now)).allowed, false);
  await ledger.release('owner', 1, now);
  assert.equal((await ledger.reserve('owner', now)).allowed, true);
});
