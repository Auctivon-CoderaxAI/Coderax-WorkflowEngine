import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouterCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger, createMemoryBudgetStore } from '../../src/models/budget.js';
import type { ProviderDescriptor, ProviderModel } from '../../src/models/router.js';
import { createRouter } from '../../src/models/router.js';

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

function model(
  providerId: string,
  modelId: string,
  eligibility: ProviderModel['eligibility'],
): ProviderModel {
  return {
    ref: { providerId, modelId },
    label: `${providerId} ${modelId}`,
    costClass: eligibility.costClass,
    eligibility,
    profile: { coding: 0.5, reasoning: 0.5, speed: 0.5, toolCalling: false, multimodal: false, contextTokens: 8192 },
    limits: { requestsPerMinute: 20, requestsPerDay: 500, tokensPerDay: 500_000, concurrentRequests: 1 },
    availability: ready,
  };
}

function provider(id: string, models: ProviderModel[]): ProviderDescriptor {
  return {
    id,
    costEvidence: models.every((entry) => entry.eligibility.verifiedFree) ? 'verified-free' : 'unverified',
    quota: { requestsPerMinute: 20, requestsPerDay: 500, tokensPerDay: 500_000 },
    models,
  };
}

const free = model('openrouter', 'coderax:free', verified());
const paid = model('openai', 'gpt-premium', { costClass: 'paid', verifiedFree: false, reason: 'price_not_zero' });

test('private mode fails closed while this branch has no provider policy registry', () => {
  const catalog = createRouterCatalog(createRouter({ providers: [provider('openrouter', [free])] }));

  // Cloud mode keeps its existing behavior.
  const cloud = catalog.resolve(null, 'cloud');
  assert.equal(cloud.ok, true);
  assert.deepEqual(catalog.route('cloud'), [free.ref]);

  // A verified-free hosted model is not selectable for private execution, and an
  // explicit pin does not bypass the refusal.
  const privateRoute = catalog.resolve(null, 'private');
  assert.equal(privateRoute.ok, false);
  assert.equal(privateRoute.ok === false && privateRoute.code, 'model_missing');
  assert.match(privateRoute.ok === false ? privateRoute.detail : '', /private mode/i);
  assert.equal(catalog.resolve(free.ref, 'private').ok, false);
  assert.deepEqual(catalog.route('private'), []);
});

test('the route resolves the verified free candidate', () => {
  const catalog = createRouterCatalog(createRouter({ providers: [provider('openrouter', [free])] }));
  const chosen = catalog.resolve(null, 'cloud');
  assert.equal(chosen.ok, true);
  assert.deepEqual(chosen.ok && chosen.value.ref, free.ref);
});

test('a paid model is refused, not silently replaced', () => {
  const catalog = createRouterCatalog(
    createRouter({ providers: [provider('openai', [paid]), provider('openrouter', [free])] }),
  );
  const chosen = catalog.resolve(paid.ref, 'cloud');
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'paid_model_refused');
});

test('a model labelled free without evidence is refused', () => {
  // The exact failure mode the zero-cost rule forbids: a descriptor that claims
  // `free` while its evidence says otherwise. The evidence wins.
  const labelled = { ...free, costClass: 'free' as const, eligibility: { ...verified(), verifiedFree: false, reason: 'terms_missing' as const } };
  const catalog = createRouterCatalog(createRouter({ providers: [provider('openrouter', [labelled])] }));
  const chosen = catalog.resolve(null, 'cloud');
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'model_missing');
});

test('an unknown model is refused with a stable failure', () => {
  const catalog = createRouterCatalog(createRouter({ providers: [provider('openrouter', [free])] }));
  const chosen = catalog.resolve({ providerId: 'unknown', modelId: 'x' }, 'cloud');
  assert.equal(chosen.ok, false);
  assert.equal(chosen.ok === false && chosen.code, 'model_missing');
});

test('discovery never advertises paid routing', () => {
  const catalog = createRouterCatalog(createRouter({ providers: [provider('openrouter', [free])] }));
  assert.equal(catalog.list().allowPaid, false);
});

test('an exhausted daily budget fails closed', async () => {
  const ledger = createBudgetLedger({
    store: createMemoryBudgetStore(),
    maxRequestsPerDay: 1,
    maxTokensPerDay: 100,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal((await ledger.reserve('owner', now)).allowed, true);
  assert.equal((await ledger.reserve('owner', now)).allowed, false);
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  assert.equal((await ledger.reserve('owner', nextDay)).allowed, true);
});

test('concurrent token reservations cannot exceed the daily ceiling', async () => {
  const ledger = createBudgetLedger({
    store: createMemoryBudgetStore(),
    maxRequestsPerDay: 1_000,
    maxTokensPerDay: 100,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () => ledger.reserveTokens({ ownerId: 'owner', tokens: 20, at: now })),
  );
  assert.equal(attempts.filter((attempt) => attempt.allowed).length, 5);
  const snapshot = await ledger.snapshot('owner', now);
  assert.equal(snapshot.reservedTokens, 100);

  // Settling with real usage releases the reservation and records the charge.
  await ledger.settle({
    ownerId: 'owner',
    at: now,
    reservedTokens: 20,
    usage: { inputTokens: 7, outputTokens: 9 },
  });
  const settled = await ledger.snapshot('owner', now);
  assert.equal(settled.reservedTokens, 80);
  assert.equal(settled.inputTokens, 7);
  assert.equal(settled.outputTokens, 9);
});
