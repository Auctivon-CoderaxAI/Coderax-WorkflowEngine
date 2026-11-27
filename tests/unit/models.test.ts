import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRef, ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createMongoBudgetStore, ensureBudgetIndexes } from '../../src/persistence/budgets.js';
import { createModelRouter } from '../../src/models/router.js';
import { createProviderPolicyRegistry, PROCESSING_OPERATIONS } from '../../src/models/policy.js';
import { ProviderError, type ProviderAdapter, type DiscoveredModel } from '../../src/models/types.js';
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
function descriptor(ref: ModelRef, costClass: ModelDescriptor['costClass']): ModelDescriptor {
  return { ref, costClass, label: ref.modelId, toolCalling: false, streaming: false, availability: ready };
}
const free = descriptor(freeRef, 'free');
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

test('an image turn only routes to a model with verified vision', () => {
  const visionModel: ModelDescriptor = {
    ...descriptor({ providerId: 'openrouter', modelId: 'coderax-vision:free' }, 'free'),
    vision: true,
  };
  const catalog = createModelCatalog({
    descriptors: [free, visionModel],
    route: [free.ref, visionModel.ref],
    allowPaid: false,
  });
  const chosen = catalog.resolve(null, 'cloud', { requireVision: true });
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.ok && chosen.value.ref, visionModel.ref);

  const textOnly = createModelCatalog({
    descriptors: [free],
    route: [free.ref],
    allowPaid: false,
  });
  const refused = textOnly.resolve(null, 'cloud', { requireVision: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'model_missing');
  // An explicit model is refused the same way; capability is not bypassed.
  const explicit = textOnly.resolve(free.ref, 'cloud', { requireVision: true });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.ok === false && explicit.code, 'model_missing');
});

test('discovery never advertises paid routing', () => {
  const catalog = createModelCatalog({ descriptors: [free], route: [free.ref], allowPaid: false });
  assert.equal(catalog.list().allowPaid, false);
});

test('an exhausted daily budget fails closed', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, true);
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, false);
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: nextDay, inputTokens: 0, outputTokens: 0 })).allowed, true);
});

test('two replicas share one durable quota and both limits fail closed', async () => {
  const collection = createFakeDatabase().collection('quota');
  const replicaA = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoBudgetStore(collection),
  });
  const replicaB = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoBudgetStore(collection),
  });
  const now = new Date('2026-11-26T10:00:00.000Z');

  // The second replica sees the first replica's reservation, so the ceiling is
  // global rather than one budget per process.
  assert.equal((await replicaA.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, true);
  assert.equal((await replicaB.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, true);
  assert.equal((await replicaB.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, false);
  assert.equal((await replicaA.snapshot('owner', now)).requests, 0, 'a hold is not a dispatched call');

  await replicaB.recordUsage('owner', { inputTokens: 60, outputTokens: 50 }, now);
  assert.equal(await replicaA.available('owner', now), false);
  assert.equal((await replicaA.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, false);
});

test('a concurrent token settlement cannot slip a request past the ceiling', async () => {
  const collection = createFakeDatabase().collection('quota');
  await ensureBudgetIndexes(collection);
  const ledger = createBudgetLedger({ maxRequestsPerDay: 2, maxTokensPerDay: 100, store: createMongoBudgetStore(collection) });
  const request = { ownerId: 'owner', at: new Date('2026-11-26T10:00:00.000Z'), inputTokens: 0, outputTokens: 0 };
  const first = await ledger.reserve(request);
  assert.ok(first.allowed);
  const original = collection.findOneAndUpdate.bind(collection);
  let injected = false;
  collection.findOneAndUpdate = async (filter, update, options) => {
    if (!injected) {
      injected = true;
      await ledger.settle(first.reservation.id, { inputTokens: 100, outputTokens: 0 });
    }
    return original(filter, update, options);
  };
  const second = await ledger.reserve(request);
  assert.equal(second.allowed, false, 'the token ceiling is part of the atomic charge');
});

test('a released reservation does not charge quota for work that never ran', async () => {
  const collection = createFakeDatabase().collection('quota');
  const ledger = createBudgetLedger({
    maxRequestsPerDay: 2,
    maxTokensPerDay: 100,
    store: createMongoBudgetStore(collection),
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const held = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 });
  assert.ok(held.allowed);
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, true);
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, false);
  await ledger.release(held.reservation.id);
  assert.equal((await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed, true);
});
