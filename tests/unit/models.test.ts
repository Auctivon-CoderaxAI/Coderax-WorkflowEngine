import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createMemoryBudgetStore } from '../../src/persistence/budgets.js';

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
  const ledger = createBudgetLedger({
    store: createMemoryBudgetStore(),
    maxRequestsPerDay: 1,
    maxTokensPerDay: 100,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const first = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0, reservationId: 'r1' });
  assert.equal(first.allowed, true);
  const second = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0, reservationId: 'r2' });
  assert.equal(second.allowed, false);
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  const third = await ledger.reserve({ ownerId: 'owner', at: nextDay, inputTokens: 0, outputTokens: 0, reservationId: 'r3' });
  assert.equal(third.allowed, true);
});

test('a released reservation must reserve again instead of reusing its row', async () => {
  const ledger = createBudgetLedger({
    store: createMemoryBudgetStore(),
    maxRequestsPerDay: 1,
    maxTokensPerDay: 100,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const first = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10, reservationId: 'same' });
  assert.equal(first.allowed, true);
  assert.equal(await ledger.release('same'), true);
  const again = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10, reservationId: 'same' });
  assert.equal(again.allowed, true, 'the released slot is available again');
  const other = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0, reservationId: 'other' });
  assert.equal(other.allowed, false, 'the re-admission consumed the only slot');
});
