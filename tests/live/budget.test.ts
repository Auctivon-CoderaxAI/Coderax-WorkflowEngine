import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { MongoCollectionLike } from '../../src/persistence/mongo.js';
import { createMongoBudgetStore, ensureBudgetIndexes } from '../../src/persistence/budgets.js';
import { createBudgetLedger } from '../../src/models/budget.js';

const uri = process.env.CODERAX_TEST_MONGO_URI ?? process.env.CODERAX_TEST_MONGODB_URI;
const required = process.env.CODERAX_REQUIRE_MONGO === '1' || process.env.CODERAX_REQUIRE_MONGODB === '1';
const skip = uri || required ? false : 'CODERAX_TEST_MONGO_URI is not set';

test('real MongoDB admits exactly one competing request and persists settlement across replicas',
  { skip, timeout: 30_000 }, async () => {
    assert.ok(uri, 'CODERAX_TEST_MONGO_URI is required');
    const client = new MongoClient(uri);
    await client.connect();
    const database = client.db(`coderax_live_budget_${process.pid}_${Date.now()}`);
    const raw = database.collection('budget_windows');
    const collection = raw as unknown as MongoCollectionLike;
    try {
      await ensureBudgetIndexes(collection);
      const indexes = await raw.listIndexes().toArray();
      assert.ok(indexes.some((index) => index.name === 'budget_window' && index.unique === true));
      const at = new Date('2026-11-26T10:00:00.000Z');
      const limits = { maxRequestsPerDay: 1, maxTokensPerDay: 10 };
      const replica = () => createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) });
      const a = replica();
      const b = replica();
      const reserve = (ledger: typeof a) => ledger.reserve({ ownerId: 'owner', at, inputTokens: 6, outputTokens: 4 });
      const outcomes = await Promise.all([reserve(a), reserve(b)]);
      assert.equal(outcomes.filter((outcome) => outcome.allowed).length, 1);
      const winner = outcomes.find((outcome) => outcome.allowed);
      assert.ok(winner?.allowed);
      assert.equal(await replica().available('owner', at), false);
      await Promise.all([a.release(winner.reservation.id), b.release(winner.reservation.id)]);
      assert.equal(await replica().available('owner', at), true);
      const next = await reserve(replica());
      assert.ok(next.allowed);
      await Promise.all([
        a.settle(next.reservation.id, { inputTokens: 7, outputTokens: 3 }),
        b.settle(next.reservation.id, { inputTokens: 7, outputTokens: 3 }),
      ]);
      assert.deepEqual(await replica().snapshot('owner', at), { requests: 1, inputTokens: 7, outputTokens: 3 });
      assert.equal(await replica().available('owner', at), false);
      const tokenLimits = { maxRequestsPerDay: 10, maxTokensPerDay: 10 };
      const tokenReplica = () => createBudgetLedger({ ...tokenLimits, store: createMongoBudgetStore(collection) });
      const tokenOutcomes = await Promise.all([0, 1].map(() =>
        tokenReplica().reserve({ ownerId: 'token-owner', at, inputTokens: 6, outputTokens: 4 })));
      assert.equal(tokenOutcomes.filter((outcome) => outcome.allowed).length, 1);
      assert.equal(tokenOutcomes.filter((outcome) => !outcome.allowed && outcome.reason === 'tokens').length, 1);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
