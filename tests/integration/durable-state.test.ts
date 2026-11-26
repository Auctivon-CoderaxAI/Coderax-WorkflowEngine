import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { ExecutionEvent } from '@coderax/contracts';
import { CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { workRunKey } from '../../src/execution/lease.js';
import {
  REAL_MONGO_SKIP,
  configuredMongo,
  requireRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  waitFor,
  type TestWorkspace,
} from '../helpers.js';

/**
 * The rest of the durable state, against a real MongoDB server.
 *
 * The artifact test covers descriptors and bytes. This covers the three pieces a
 * restart is otherwise allowed to forget: the Work run lease, the submission
 * key that makes a retry replay one task, and the execution events a client
 * replays from a cursor. Each engine is a separate process object with its own
 * connection; nothing is shared but the database.
 */

const maybeMongo = configuredMongo();
requireRealMongo(maybeMongo);

type Engine = {
  app: Application;
  api: CoderaxClient;
  database: MongoDatabase;
};

/**
 * One throwaway database and the engines opened against it. Each `engine()` call
 * opens a new connection, so reading through it cannot be satisfied by anything
 * the previous process kept in memory.
 */
function scenario(real: RealMongo) {
  const databaseName = `coderax_state_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const connect = createMongoConnector();
  const connections: MongoDatabase[] = [];
  const apps: Application[] = [];
  const workspaces: TestWorkspace[] = [];

  return {
    async engine(): Promise<Engine> {
      const database = await connect({ uri: real.uri, database: databaseName });
      connections.push(database);
      const workspace = createWorkspaces();
      workspaces.push(workspace);
      const app = await composeApplication({
        config: baseConfig(workspace, {
          persistence: { driver: 'mongo', database: databaseName },
        }),
        env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
        gateway: fakeGateway(),
        persistence: { database },
      });
      apps.push(app);
      const { url } = await app.start();
      return { app, api: new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN }), database };
    },

    async close(): Promise<void> {
      for (const app of apps) await app.stop().catch(() => undefined);
      for (const connection of connections) await connection.close().catch(() => undefined);
      for (const workspace of workspaces) workspace.cleanup();
      // The service container is discarded after the run; a local server is not,
      // so remove the throwaway database these tests created.
      const cleanup = new MongoClient(real.uri);
      await cleanup
        .connect()
        .then(() => cleanup.db(databaseName).dropDatabase())
        .catch(() => undefined)
        .finally(() => cleanup.close().catch(() => undefined));
    },
  };
}

test(
  'a Work lease keeps its holder, expiry and cancellation flag across restarts',
  { skip: maybeMongo === null ? REAL_MONGO_SKIP : false },
  async () => {
    const run = scenario(maybeMongo as RealMongo);
    try {
      const first = await run.engine();
      const key = workRunKey({ ownerId: OWNER_ID, tenantId: null, conversationId: 'conv_lease' });
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);

      assert.equal(
        await first.app.dependencies.lease.claim({
          key,
          owner: 'replica-a',
          token: 'gen-1',
          now,
          expiresAt,
        }),
        true,
      );
      // A live lease is the sole authority, so a second replica is refused.
      assert.equal(
        await first.app.dependencies.lease.claim({
          key,
          owner: 'replica-b',
          token: 'gen-2',
          now,
          expiresAt,
        }),
        false,
      );
      await first.app.stop();

      const second = await run.engine();
      const at = new Date(now.getTime() + 1_000);
      const restored = await second.app.dependencies.lease.read({ key, now: at });
      assert.equal(restored?.token, 'gen-1');
      assert.equal(restored?.owner, 'replica-a');
      assert.equal(restored?.expiresAt.getTime(), expiresAt.getTime());
      assert.equal(restored?.live, true);
      assert.equal(restored?.cancelRequested, false);

      // The stored expiry, not a process clock, decides when the lease dies: at
      // a later `now` the row is claimable and the previous token is fenced out.
      const later = new Date(now.getTime() + 120_000);
      const renewedUntil = new Date(later.getTime() + 60_000);
      assert.equal(
        await second.app.dependencies.lease.claim({
          key,
          owner: 'replica-b',
          token: 'gen-2',
          now: later,
          expiresAt: renewedUntil,
        }),
        true,
      );
      assert.deepEqual(
        await second.app.dependencies.lease.renew({
          key,
          token: 'gen-1',
          now: later,
          expiresAt: renewedUntil,
        }),
        { renewed: false, cancelRequested: false },
      );
      assert.equal(await second.app.dependencies.lease.cancel({ key, now: later }), 'requested');
      assert.deepEqual(
        await second.app.dependencies.lease.renew({
          key,
          token: 'gen-2',
          now: later,
          expiresAt: renewedUntil,
        }),
        { renewed: true, cancelRequested: true },
      );

      const rows = await second.database.collection('work_runs').find({}).toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.token, 'gen-2');
      assert.equal(rows[0]?.cancelRequested, true);
      await second.app.stop();

      // A cancellation is a durable flag precisely because the request may land
      // on a replica that is not running the task; a third process must still
      // see it, and the release that follows must retire the row.
      const third = await run.engine();
      const flagged = await third.app.dependencies.lease.read({ key, now: later });
      assert.equal(flagged?.token, 'gen-2');
      assert.equal(flagged?.cancelRequested, true);
      assert.equal(await third.app.dependencies.lease.release({ key, token: 'gen-1' }), false);
      assert.equal(await third.app.dependencies.lease.release({ key, token: 'gen-2' }), true);
      assert.equal(await third.app.dependencies.lease.read({ key, now: later }), null);
    } finally {
      await run.close();
    }
  },
);

test(
  'an idempotency key replays its task and a pending reservation survives a restart',
  { skip: maybeMongo === null ? REAL_MONGO_SKIP : false },
  async () => {
    const run = scenario(maybeMongo as RealMongo);
    try {
      const first = await run.engine();
      const accepted = await first.api.submitWork({
        objective: 'One durable submission',
        idempotencyKey: 'durable-key-0001',
      });
      await waitFor(async () => {
        const row = await first.database.collection('tasks').findOne({ taskId: accepted.taskId });
        return row?.state === 'completed' ? row : null;
      });

      // Reserved before the task exists and never confirmed: a restart must keep
      // it unconfirmed rather than let a second run start on the same intent.
      const pending = {
        ownerId: OWNER_ID,
        key: 'durable-inflight-0001',
        taskId: 'task_inflight',
      };
      assert.deepEqual(await first.app.dependencies.idempotency.reserve(pending), { ok: true });
      await first.app.stop();

      const second = await run.engine();
      const replayed = await second.api.submitWork({
        objective: 'One durable submission',
        idempotencyKey: 'durable-key-0001',
      });
      assert.equal(replayed.taskId, accepted.taskId);
      assert.equal(replayed.replayed, true);
      assert.equal(
        (await second.database.collection('tasks').find({}).toArray()).length,
        1,
        'a replayed key must not create a second task',
      );

      assert.deepEqual(await second.app.dependencies.idempotency.reserve(pending), { ok: false });
      await second.app.dependencies.idempotency.release(pending);
      assert.deepEqual(await second.app.dependencies.idempotency.reserve(pending), { ok: true });

      // An expired reservation is taken over, and its task is not replayed.
      const expired = {
        ownerId: OWNER_ID,
        key: 'durable-expired-0001',
        taskId: 'task_fresh',
      };
      await second.database.collection('idempotency').insertOne({
        ownerId: expired.ownerId,
        key: expired.key,
        taskId: 'task_stale',
        expiresAt: new Date(Date.now() - 60_000),
      });
      assert.deepEqual(await second.app.dependencies.idempotency.reserve(expired), { ok: true });

      const keys = await second.database.collection('idempotency').find({}).toArray();
      assert.equal(keys.length, 3, 'one row per submission key');
      assert.equal(
        keys.find((row) => row.key === 'durable-key-0001')?.taskId,
        accepted.taskId,
      );
    } finally {
      await run.close();
    }
  },
);

test(
  'execution events replay from stored history after a restart',
  { skip: maybeMongo === null ? REAL_MONGO_SKIP : false },
  async () => {
    const run = scenario(maybeMongo as RealMongo);
    try {
      const first = await run.engine();
      const accepted = await first.api.submitWork({ objective: 'Durable events' });

      const before: ExecutionEvent[] = [];
      for await (const event of first.api.events(accepted.taskId, { after: 0 })) before.push(event);
      assert.equal(before.at(-1)?.type, 'task.completed');
      assert.ok(before.length > 1);
      await first.app.stop();

      // The live buffer died with that process; everything below is read from
      // MongoDB through a connection this process opened itself.
      const second = await run.engine();
      const after: ExecutionEvent[] = [];
      for await (const event of second.api.events(accepted.taskId, {
        after: 0,
        signal: AbortSignal.timeout(10_000),
      })) {
        after.push(event);
      }
      assert.deepEqual(
        after.map((event) => [event.seq, event.eventId, event.type]),
        before.map((event) => [event.seq, event.eventId, event.type]),
        'a replay must keep the original sequence, identity and order',
      );

      // A mid cursor still selects only the remainder of the stored history.
      const cursor = before[1]?.seq ?? 0;
      const rest: ExecutionEvent[] = [];
      for await (const event of second.api.events(accepted.taskId, {
        after: cursor,
        signal: AbortSignal.timeout(10_000),
      })) {
        rest.push(event);
      }
      assert.deepEqual(
        rest.map((event) => event.seq),
        before.slice(2).map((event) => event.seq),
      );
      assert.equal(rest.at(-1)?.type, 'task.completed');

      const rows = await second.database.collection('events').find({}).toArray();
      assert.equal(rows.length, before.length, 'every published event must be stored exactly once');
      assert.ok(rows.every((row) => row.taskId === accepted.taskId));
      assert.equal(
        new Set(rows.map((row) => row.eventId)).size,
        rows.length,
        'stored event ids must be unique',
      );
    } finally {
      await run.close();
    }
  },
);
