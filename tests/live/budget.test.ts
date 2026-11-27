import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { MongoCollectionLike } from '../../src/persistence/mongo.js';
import { createMongoBudgetStore, ensureBudgetIndexes } from '../../src/persistence/budgets.js';
import { budgetKey, createBudgetLedger } from '../../src/models/budget.js';

/**
 * Real MongoDB only.
 *
 * This suite deliberately does not use `tests/fakes/mongo.ts`: it opens the
 * official driver against a server, proves the unique window index exists, and
 * races two independent ledger instances for the last request slot. The fast
 * unit suite covers the same semantics in memory; this is the evidence that a
 * real database enforces them.
 */

const uri = process.env.CODERAX_TEST_MONGODB_URI;
const required = process.env.CODERAX_REQUIRE_MONGODB === '1';
const skip = uri ? false : required ? false : 'CODERAX_TEST_MONGODB_URI is not set';

test(
  'two racing replicas in a real database produce exactly one quota winner',
  { skip, timeout: 30_000 },
  async () => {
    assert.ok(
      uri,
      'CODERAX_TEST_MONGODB_URI must name a reachable MongoDB; set CODERAX_REQUIRE_MONGODB=1 in CI',
    );
    const client = new MongoClient(uri);
    await client.connect();
    const database = client.db(`coderax_live_budget_${process.pid}_${Date.now()}`);
    const collection = database.collection('budget_windows') as unknown as MongoCollectionLike;
    try {
      await ensureBudgetIndexes(collection);
      const indexes = await database.collection('budget_windows').listIndexes().toArray();
      assert.ok(
        indexes.some((index) => index.name === 'budget_window' && index.unique === true),
        JSON.stringify(indexes),
      );

      const now = new Date('2026-11-26T10:00:00.000Z');
      const limits = { maxRequestsPerDay: 1, maxTokensPerDay: 10 };
      const replicas = [0, 1].map(() =>
        createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) }),
      );

      // Both replicas share one durable window and reserve in the same tick.
      // Which replica wins is a scheduling detail; that exactly one wins is the
      // constraint the unique index and the conditional update enforce.
      const outcomes = await Promise.all(
        replicas.map((replica) => replica.reserve('owner', now)),
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.allowed).length,
        1,
        JSON.stringify(outcomes),
      );
      const winnerIndex = outcomes.findIndex((outcome) => outcome.allowed);
      const winner = outcomes[winnerIndex];
      assert.ok(winner && winner.allowed);
      if (!winner || !winner.allowed) return;
      assert.equal(winner.requests, 1);

      const loser = outcomes.find((outcome) => !outcome.allowed);
      assert.ok(loser);
      if (!loser) return;
      assert.equal(loser.allowed, false);
      assert.equal(loser.requests, 1);

      // The durable window holds the winner's reservation, not two.
      const shared = createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) });
      assert.deepEqual(await shared.snapshot('owner', now), {
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      assert.equal(await shared.available('owner', now), false);

      // Release is idempotent by reservation id, including a replay through a
      // store that has never seen this process's reservation object.
      await winner.release();
      const replay = await createMongoBudgetStore(collection).release({
        key: budgetKey('owner', now),
        reservationId: winner.id,
      });
      assert.equal(replay, false);
      assert.equal((await shared.snapshot('owner', now)).requests, 0);
      assert.equal(await shared.available('owner', now), true);

      // A fresh process can spend the returned slot and charge usage to the same
      // durable window.
      const again = await shared.reserve('owner', now);
      assert.equal(again.allowed, true);
      await shared.consume('owner', { inputTokens: 7, outputTokens: 3 }, now);

      const restarted = createBudgetLedger({
        ...limits,
        store: createMongoBudgetStore(collection),
      });
      assert.deepEqual(await restarted.snapshot('owner', now), {
        requests: 1,
        inputTokens: 7,
        outputTokens: 3,
      });
      assert.equal(await restarted.available('owner', now), false);
    } finally {
      await database.dropDatabase().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  },
);
