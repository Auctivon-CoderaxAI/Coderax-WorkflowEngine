import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRef } from '@coderax/contracts';
import { createBudgetLedger, createMemoryBudgetStore } from '../../src/models/budget.js';
import { createModelRouter } from '../../src/models/router.js';
import { createProviderPolicyRegistry, PROCESSING_OPERATIONS } from '../../src/models/policy.js';
import type { DiscoveredModel, ProviderAdapter } from '../../src/models/types.js';
import { ProviderError } from '../../src/models/types.js';

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
  const reservation = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10 });
  assert.equal(reservation.allowed, true);
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10 })).allowed,
    false,
  );
  if (reservation.allowed) await ledger.settle(reservation.reservation.id, { inputTokens: 10, outputTokens: 10 });
  const nextDay = new Date('2026-11-27T10:00:00.000Z');
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: nextDay, inputTokens: 10, outputTokens: 10 })).allowed,
    true,
  );
});

test('tokens are reserved, not merely counted after a call', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const first = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 60, outputTokens: 30 });
  assert.equal(first.allowed, true);
  // The second request cannot spend the 90 tokens already reserved.
  const second = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 20, outputTokens: 20 });
  assert.equal(second.allowed, false);
  if (first.allowed) await ledger.release(first.reservation.id);
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 20, outputTokens: 20 })).allowed,
    true,
  );
});

test('an external engine is charged once after its run, not reserved twice', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  await ledger.charge('owner', { inputTokens: 30, outputTokens: 20 }, now);
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 30,
    outputTokens: 20,
  });
  assert.equal(await ledger.available('owner', now), true);
  await ledger.charge('owner', { inputTokens: 40, outputTokens: 20 }, now);
  assert.equal(await ledger.available('owner', now), false);
});

test('partial provider usage is settled against the reservation, not zero', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({
    ownerId: 'owner',
    at: now,
    inputTokens: 80,
    outputTokens: 20,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.settle(reservation.reservation.id, { outputTokens: 5 });
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 80,
    outputTokens: 5,
  });
});

test('two replicas share one durable quota window', async () => {
  const store = createMemoryBudgetStore();
  const first = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 1_000, store });
  const second = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 1_000, store });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const outcomes = await Promise.all([
    first.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10 }),
    second.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10 }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.allowed).length, 1);
  assert.equal(await second.available('owner', now), false);
});

test('a replayed settlement charges the owner exactly once', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({
    ownerId: 'owner', at: now, inputTokens: 40, outputTokens: 10,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await Promise.all([
    ledger.settle(reservation.reservation.id, { inputTokens: 7, outputTokens: 3 }),
    ledger.settle(reservation.reservation.id, { inputTokens: 7, outputTokens: 3 }),
  ]);
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 7,
    outputTokens: 3,
  });
});

test('a replayed release charges one request, not two', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({
    ownerId: 'owner', at: now, inputTokens: 40, outputTokens: 10,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.release(reservation.reservation.id, { dispatched: true });
  await ledger.release(reservation.reservation.id, { dispatched: true });
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
});

test('a dispatched reservation keeps its request charge when it is released', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({
    ownerId: 'owner',
    at: now,
    inputTokens: 40,
    outputTokens: 10,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.release(reservation.reservation.id, { dispatched: true });
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
});
