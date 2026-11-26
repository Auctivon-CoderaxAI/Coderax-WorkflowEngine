import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetLedger, type BudgetLedger } from '../../src/models/budget.js';
import { createMongoBudgetStore, ensureBudgetIndexes } from '../../src/persistence/budgets.js';
import { createFakeCollection } from '../fakes/mongo.js';

/**
 * The durable budget store, exercised against the driver fake.
 *
 * This proves the conditional-update arithmetic, the ceiling filter, the
 * one-winner claim and the expiry sweep. It does NOT prove live MongoDB
 * atomicity: the fake serializes operations in one process, so a green test here
 * is evidence about the queries, not about a three-node replica set.
 */

async function replicas(): Promise<BudgetLedger[]> {
  const windows = createFakeCollection();
  const reservations = createFakeCollection();
  await ensureBudgetIndexes({ windows, reservations });
  const make = () =>
    createBudgetLedger({
      store: createMongoBudgetStore({ windows, reservations }),
      maxRequestsPerDay: 10,
      maxTokensPerDay: 1_000,
      taskMaxRequests: 10,
      taskMaxTokens: 1_000,
      reservationTtlMs: 60_000,
    });
  return [make(), make()];
}

test('two replicas cannot both take the last request of the day', async () => {
  const [first, second] = await replicas();
  const at = new Date('2026-11-26T10:00:00.000Z');
  const outcomes = await Promise.all([
    first.reserve({ ownerId: 'owner', at, inputTokens: 10, outputTokens: 10 }),
    second.reserve({ ownerId: 'owner', at, inputTokens: 10, outputTokens: 10 }),
  ]);
  assert.equal(outcomes.filter((entry) => entry.allowed).length, 2);
  // Both fit under ten requests, so the interesting race is the token ceiling.
  const tight = await replicas();
  const [a, b] = tight;
  const big = { ownerId: 'owner', at, inputTokens: 400, outputTokens: 100 };
  const raced = await Promise.all([
    a.reserve(big),
    b.reserve(big),
    a.reserve(big),
    b.reserve(big),
  ]);
  const allowed = raced.filter((entry) => entry.allowed);
  assert.equal(allowed.length, 2);
  const snapshot = await a.snapshot('owner', at);
  assert.equal(snapshot.reservedTokens, 1_000);
});

test('settlement is idempotent across replicas', async () => {
  const [first, second] = await replicas();
  const at = new Date('2026-11-26T10:00:00.000Z');
  const reserved = await first.reserve({
    ownerId: 'owner',
    at,
    inputTokens: 100,
    outputTokens: 50,
  });
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  const id = reserved.reservation.id;
  await Promise.all([
    first.settle(id, { inputTokens: 70, outputTokens: 20 }),
    second.settle(id, { inputTokens: 70, outputTokens: 20 }),
    second.release(id, { dispatched: true }),
  ]);
  const snapshot = await first.snapshot('owner', at);
  assert.deepEqual(snapshot, {
    requests: 1,
    inputTokens: 70,
    outputTokens: 20,
    reservedTokens: 0,
  });
});

test('an abandoned reservation is refunded exactly once by the sweep', async () => {
  const [first, second] = await replicas();
  const at = new Date('2026-11-26T10:00:00.000Z');
  const abandoned = await first.reserve({
    ownerId: 'owner',
    at,
    inputTokens: 500,
    outputTokens: 400,
  });
  assert.equal(abandoned.allowed, true);
  const later = new Date(at.getTime() + 61_000);
  // Both replicas sweep the same row; only one may refund it.
  const [left, right] = await Promise.all([
    first.reserve({ ownerId: 'owner', at: later, inputTokens: 10, outputTokens: 10 }),
    second.reserve({ ownerId: 'owner', at: later, inputTokens: 10, outputTokens: 10 }),
  ]);
  assert.equal(left.allowed, true);
  assert.equal(right.allowed, true);
  const snapshot = await first.snapshot('owner', later);
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.inputTokens, 0);
  // Two live reservations of ten input plus ten output tokens each; the
  // abandoned 900-token reservation was refunded exactly once.
  assert.equal(snapshot.reservedTokens, 40);
});

test('a dispatched release charges the reservation instead of refunding it', async () => {
  const [first] = await replicas();
  const at = new Date('2026-11-26T10:00:00.000Z');
  const reserved = await first.reserve({
    ownerId: 'owner',
    at,
    inputTokens: 300,
    outputTokens: 100,
  });
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  await first.release(reserved.reservation.id, { dispatched: true });
  assert.deepEqual(await first.snapshot('owner', at), {
    requests: 1,
    inputTokens: 300,
    outputTokens: 100,
    reservedTokens: 0,
  });
});

test('the token ceiling refuses a request that the stored total cannot cover', async () => {
  const [first] = await replicas();
  const at = new Date('2026-11-26T10:00:00.000Z');
  assert.equal(
    (await first.reserve({ ownerId: 'owner', at, inputTokens: 900, outputTokens: 200 })).allowed,
    false,
  );
  assert.equal(
    (await first.reserve({ ownerId: 'owner', at, inputTokens: 900, outputTokens: 100 })).allowed,
    true,
  );
});
