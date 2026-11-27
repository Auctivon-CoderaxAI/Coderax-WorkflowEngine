import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';

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

test('an exhausted daily budget fails closed', () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal(ledger.reserve('owner', now).allowed, true);
  assert.equal(ledger.reserve('owner', now).allowed, false);
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  assert.equal(ledger.reserve('owner', nextDay).allowed, true);
});
