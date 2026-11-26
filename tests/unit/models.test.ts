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

function budget(overrides: {
  maxRequestsPerDay?: number;
  maxTokensPerDay?: number;
  taskMaxRequests?: number;
  taskMaxTokens?: number;
  reservationTtlMs?: number;
} = {}) {
  return createBudgetLedger({
    store: createMemoryBudgetStore(),
    maxRequestsPerDay: overrides.maxRequestsPerDay ?? 100,
    maxTokensPerDay: overrides.maxTokensPerDay ?? 100_000,
    taskMaxRequests: overrides.taskMaxRequests ?? 100,
    taskMaxTokens: overrides.taskMaxTokens ?? 100_000,
    ...(overrides.reservationTtlMs === undefined
      ? {}
      : { reservationTtlMs: overrides.reservationTtlMs }),
  });
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
    providers: [{ adapter: provider([discovered(freeRef, { prompt: '0', completion: '0' })    ]), settings: { requestsPerMinute: 10, tokensPerMinute: 10_000, maxConcurrency: 1, requestTimeoutMs: 1_000, discoveryIntervalMs: 60_000 } }],
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
  const ledger = budget({ maxRequestsPerDay: 1, maxTokensPerDay: 100 });
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
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const first = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 60, outputTokens: 30 });
  assert.equal(first.allowed, true);
  // The second request cannot spend the 90 tokens already reserved.
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 20, outputTokens: 20 })).allowed,
    false,
  );
  if (first.allowed) await ledger.release(first.reservation.id);
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 20, outputTokens: 20 })).allowed,
    true,
  );
});

test('a dispatched attempt is charged its reservation instead of refunding it', async () => {
  // A timeout or a dropped stream is ambiguous: the provider may already have
  // consumed the inference. Releasing the allowance would let a failing endpoint
  // spend an unbounded number of requests while the ledger reported zero.
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 40, outputTokens: 10 });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.release(reservation.reservation.id, { dispatched: true });
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 40,
    outputTokens: 10,
    reservedTokens: 0,
  });
});

test('an attempt that never reached the provider refunds its whole reservation', async () => {
  const ledger = budget({ maxRequestsPerDay: 2, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 40, outputTokens: 10 });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.release(reservation.reservation.id);
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reservedTokens: 0,
  });
});

test('partial provider usage is settled against the reservation, not zero', async () => {
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
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
    reservedTokens: 0,
  });
});

test('duplicate settlement charges the allowance exactly once', async () => {
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 1_000 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 30, outputTokens: 10 });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  const id = reservation.reservation.id;
  await ledger.settle(id, { inputTokens: 12, outputTokens: 8 });
  await ledger.settle(id, { inputTokens: 500, outputTokens: 500 });
  await ledger.release(id, { dispatched: true });
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 12,
    outputTokens: 8,
    reservedTokens: 0,
  });
});

test('an abandoned reservation expires and is refunded once', async () => {
  // A process that reserves and then dies must not hold the day's allowance
  // forever; the next reservation sweeps the stale row.
  const ledger = budget({
    maxRequestsPerDay: 10,
    maxTokensPerDay: 100,
    reservationTtlMs: 60_000,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const abandoned = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 80, outputTokens: 20 });
  assert.equal(abandoned.allowed, true);
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 20, outputTokens: 20 })).allowed,
    false,
  );
  const later = new Date(now.getTime() + 61_000);
  const after = await ledger.reserve({ ownerId: 'owner', at: later, inputTokens: 20, outputTokens: 20 });
  assert.equal(after.allowed, true);
  // A late settlement for the expired reservation must not resurrect it.
  if (abandoned.allowed) {
    await ledger.settle(abandoned.reservation.id, { inputTokens: 80, outputTokens: 20 });
  }
  assert.deepEqual(await ledger.snapshot('owner', later), {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    reservedTokens: 40,
  });
});

test('reported usage above the reservation stops the next request', async () => {
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const reservation = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 60, outputTokens: 30 });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await ledger.settle(reservation.reservation.id, { inputTokens: 200, outputTokens: 50 });
  assert.equal(await ledger.available('owner', now), false);
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 1, outputTokens: 1 })).allowed,
    false,
  );
});

test('a task window refuses before the owner allowance is consumed', async () => {
  const ledger = budget({
    maxRequestsPerDay: 10,
    maxTokensPerDay: 10_000,
    taskMaxRequests: 1,
    taskMaxTokens: 1_000,
  });
  const now = new Date('2026-11-26T10:00:00.000Z');
  const first = await ledger.reserve({
    ownerId: 'owner',
    at: now,
    inputTokens: 10,
    outputTokens: 10,
    taskId: 'task-a',
  });
  assert.equal(first.allowed, true);
  const refused = await ledger.reserve({
    ownerId: 'owner',
    at: now,
    inputTokens: 10,
    outputTokens: 10,
    taskId: 'task-a',
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.reason, 'task_requests');
  // The refused reservation must not have consumed an owner slot.
  assert.equal(
    (await ledger.reserve({
      ownerId: 'owner',
      at: now,
      inputTokens: 10,
      outputTokens: 10,
      taskId: 'task-b',
    })).allowed,
    true,
  );
});

test('an external engine is charged once after its run, not reserved twice', async () => {
  const ledger = budget({ maxRequestsPerDay: 10, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  await ledger.charge('owner', { inputTokens: 30, outputTokens: 20 }, now);
  assert.deepEqual(await ledger.snapshot('owner', now), {
    requests: 1,
    inputTokens: 30,
    outputTokens: 20,
    reservedTokens: 0,
  });
  assert.equal(await ledger.available('owner', now), true);
  await ledger.charge('owner', { inputTokens: 40, outputTokens: 20 }, now);
  assert.equal(await ledger.available('owner', now), false);
});
