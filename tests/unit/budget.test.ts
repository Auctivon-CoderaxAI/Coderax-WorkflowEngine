import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetLedger, createMemoryBudgetStore } from '../../src/models/budget.js';

const at = new Date('2026-11-26T10:00:00.000Z');
const limits = { maxRequestsPerDay: 2, maxTokensPerDay: 10 };

test('shared memory window reserves tokens and releases idempotently across ledgers', async () => {
  const store = createMemoryBudgetStore();
  const a = createBudgetLedger({ ...limits, store });
  const b = createBudgetLedger({ ...limits, store });
  const reserve = (ledger: typeof a, inputTokens = 6) =>
    ledger.reserve({ ownerId: 'owner', at, inputTokens, outputTokens: 4 });
  const outcomes = await Promise.all([reserve(a), reserve(b)]);
  assert.equal(outcomes.filter((x) => x.allowed).length, 1);
  const winner = outcomes.find((x) => x.allowed);
  assert.ok(winner?.allowed);
  assert.equal(await b.available('owner', at), false);
  await Promise.all([a.release(winner.reservation.id), b.release(winner.reservation.id)]);
  assert.equal(await b.available('owner', at), true);
  const next = await reserve(b);
  assert.ok(next.allowed);
  await Promise.all([
    a.settle(next.reservation.id, { inputTokens: 6, outputTokens: 4 }),
    b.settle(next.reservation.id, { inputTokens: 6, outputTokens: 4 }),
  ]);
  assert.deepEqual(await a.snapshot('owner', at), { requests: 1, inputTokens: 6, outputTokens: 4 });
  assert.equal(await b.available('owner', at), false);
  assert.equal(await b.available('owner', new Date(at.getTime() + 86400000)), true);
});

test('dispatched reservation consumes one request and cannot be refunded by replay', async () => {
  const store = createMemoryBudgetStore();
  const a = createBudgetLedger({ ...limits, store });
  const b = createBudgetLedger({ ...limits, store });
  const held = await a.reserve({ ownerId: 'owner', at, inputTokens: 1, outputTokens: 1 });
  assert.ok(held.allowed);
  await b.release(held.reservation.id, { dispatched: true });
  await a.release(held.reservation.id);
  assert.deepEqual(await a.snapshot('owner', at), { requests: 1, inputTokens: 0, outputTokens: 0 });
});
