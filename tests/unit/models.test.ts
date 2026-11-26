import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createMongoQuotaStore } from '../../src/models/quota.js';
import { createFakeDatabase } from '../fakes/mongo.js';

const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function descriptor(ref: ModelDescriptor['ref'], costClass: 'free' | 'paid'): ModelDescriptor {
  return {
    ref,
    label: `${ref.providerId} ${ref.modelId}`,
    costClass,
    toolCalling: false,
    streaming: true,
    availability: ready,
  };
}

const free = descriptor({ providerId: 'openrouter', modelId: 'coderax:free' }, 'free');
const paid = descriptor({ providerId: 'openai', modelId: 'gpt-premium' }, 'paid');

test('the route selects the first available free candidate', () => {
  const catalog = createModelCatalog({
    descriptors: [free],
    route: [free.ref],
    allowPaid: false,
  });
  const chosen = catalog.resolve(null, 'cloud');
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.ok && chosen.value.ref, free.ref);
});

test('a paid model is refused, not silently replaced', () => {
  const catalog = createModelCatalog({
    descriptors: [free, paid],
    route: [free.ref],
    allowPaid: false,
  });
  const chosen = catalog.resolve(paid.ref, 'cloud');
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'paid_model_refused');
});

test('an unknown model is refused with a configuration error', () => {
  const catalog = createModelCatalog({ descriptors: [free], route: [free.ref], allowPaid: false });
  const chosen = catalog.resolve({ providerId: 'unknown', modelId: 'x' }, 'cloud');
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'engine_not_configured');
});

test('discovery never advertises paid routing', () => {
  const catalog = createModelCatalog({ descriptors: [free], route: [free.ref], allowPaid: false });
  assert.equal(catalog.list().allowPaid, false);
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
