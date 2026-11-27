import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetKey, createBudgetLedger, createMemoryBudgetStore } from '../../src/models/budget.js';

const NOW = new Date('2026-11-26T10:00:00.000Z');

test('the memory window admits one request and release returns it exactly once', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 10 });
  assert.equal(await ledger.available('owner', NOW), true);

  const first = await ledger.reserve('owner', NOW);
  assert.equal(first.allowed, true);
  assert.equal(first.requests, 1);

  const second = await ledger.reserve('owner', NOW);
  assert.equal(second.allowed, false);
  assert.equal(second.requests, 1);

  await first.release();
  await first.release();
  assert.equal((await ledger.snapshot('owner', NOW)).requests, 0);
  assert.equal(await ledger.available('owner', NOW), true);
  assert.equal((await ledger.reserve('owner', NOW)).allowed, true);
});

test('consumed usage closes the token ceiling and the UTC day is separate', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 10, maxTokensPerDay: 10 });
  assert.equal((await ledger.reserve('owner', NOW)).allowed, true);
  await ledger.consume('owner', { inputTokens: 6, outputTokens: 4 }, NOW);

  assert.deepEqual(await ledger.snapshot('owner', NOW), {
    requests: 1,
    inputTokens: 6,
    outputTokens: 4,
  });
  assert.equal(await ledger.available('owner', NOW), false);
  assert.equal((await ledger.reserve('owner', NOW)).allowed, false);

  const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(await ledger.available('owner', tomorrow), true);
});

test('release is idempotent per reservation id even through two ledgers', async () => {
  const store = createMemoryBudgetStore();
  const first = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 10, store });
  const second = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 10, store });

  const held = await first.reserve('owner', NOW);
  assert.equal(held.allowed, true);
  const key = budgetKey('owner', NOW);
  assert.equal(await store.release({ key, reservationId: held.id }), true);
  assert.equal(await store.release({ key, reservationId: held.id }), false);
  assert.equal((await second.snapshot('owner', NOW)).requests, 0);
});
