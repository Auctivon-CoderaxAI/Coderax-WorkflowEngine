import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoCollectionLike } from '../../src/persistence/mongo.js';
import { createMongoBudgetStore, ensureBudgetIndexes } from '../../src/persistence/budgets.js';
import { budgetKey, createBudgetLedger } from '../../src/models/budget.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../../src/persistence/mongo.js';
import { createLeaseStore } from '../../src/persistence/work-runs.js';
import { workRunKey } from '../../src/execution/lease.js';
import { baseConfig, fakeGateway, fakeProvider, OWNER_TOKEN, taskRecord, waitFor } from '../helpers.js';

/**
 * Real MongoDB only.
 *
 * This suite is deliberately not backed by `tests/fakes/mongo.ts`: it opens the
 * official driver against a server, proves the indexes exist and exercises
 * fencing/leases across two independent connections. The fake suite remains the
 * fast semantic test; this one is the evidence that a real database behaves the
 * same way. `CODERAX_REQUIRE_MONGO=1` turns a missing server into a failure
 * instead of a skip, and CI sets it.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI;
const required = process.env.CODERAX_REQUIRE_MONGO === '1';
const databaseName = `coderax_ci_${process.pid}_${Date.now()}`;
const config = baseConfig;

function requiresDatabase(): void {
  assert.ok(
    uri,
    'CODERAX_TEST_MONGO_URI must name a reachable MongoDB; set CODERAX_REQUIRE_MONGO=1 in CI',
  );
}

test(
  'the official driver opens the configured database and bootstraps indexes',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const workspace = mkdtempSync(path.join(tmpdir(), 'coderax-live-mongo-'));
    const privateRoot = path.join(workspace, 'private');
    const cloudRoot = path.join(workspace, 'cloud');
    mkdirSync(privateRoot);
    mkdirSync(cloudRoot);
    const client = new MongoClient(uri as string);
    try {
      await client.connect();
      await client.db(databaseName).command({ ping: 1 });

      const app = await composeApplication({
        config: config(
          { root: workspace, privateRoot, cloudRoot, cleanup: () => undefined },
          {
            persistence: {
              driver: 'mongo',
              uriEnv: 'CODERAX_TEST_MONGO_URI',
              database: databaseName,
              collectionPrefix: 'live_',
            },
          },
        ),
        env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
        providers: [{ adapter: fakeProvider() }],
        gateway: fakeGateway(),
      });
      try {
        assert.deepEqual(app.persistence, { driver: 'mongo' });

        const indexes = await client
          .db(databaseName)
          .collection('live_work_runs')
          .listIndexes()
          .toArray();
        assert.ok(
          indexes.some(
            (index) =>
              index.key.key === 1 &&
              index.unique === true &&
              index.name === 'work_run_key',
          ),
          JSON.stringify(indexes),
        );
      } finally {
        await app.stop();
      }
    } finally {
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'two independent real connections cannot both claim one lease',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const connector = createMongoConnector();
    const first = await connector({ uri: uri as string, database: databaseName });
    try {
      const second = await connector({ uri: uri as string, database: databaseName });
      try {
        const collection = first.collection('live_lease_race');
        await ensureWorkRunIndexes(collection);
        const a = createLeaseStore(createMongoWorkRunTable(collection));
        const b = createLeaseStore(createMongoWorkRunTable(second.collection('live_lease_race')));
        const key = '["","owner","conversation"]';
        const now = new Date();
        assert.equal(
          await a.claim({
            key,
            owner: 'owner',
            token: 'token-a',
            now,
            expiresAt: new Date(now.getTime() + 30_000),
          }),
          true,
        );
        assert.equal(
          await b.claim({
            key,
            owner: 'owner',
            token: 'token-b',
            now,
            expiresAt: new Date(now.getTime() + 30_000),
          }),
          false,
        );
        assert.equal(
          (await b.renew({
            key,
            token: 'token-b',
            now,
            expiresAt: new Date(now.getTime() + 30_000),
          })).renewed,
          false,
        );
        assert.equal(await a.cancel({ key, now }), 'requested');
        assert.equal(
          (await a.renew({
            key,
            token: 'token-a',
            now,
            expiresAt: new Date(now.getTime() + 30_000),
          })).cancelRequested,
          true,
        );
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  },
);

test(
  'a real database preserves a completed task across a restart',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const workspace = mkdtempSync(path.join(tmpdir(), 'coderax-live-mongo-'));
    const privateRoot = path.join(workspace, 'private');
    const cloudRoot = path.join(workspace, 'cloud');
    mkdirSync(privateRoot);
    mkdirSync(cloudRoot);
    const settings = {
      persistence: {
        driver: 'mongo',
        uriEnv: 'CODERAX_TEST_MONGO_URI',
        database: databaseName,
        collectionPrefix: 'live_task_',
      },
    };
    const appConfig = config(
      { root: workspace, privateRoot, cloudRoot, cleanup: () => undefined },
      settings,
    );
    const env = { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string };
    const principal = { ownerId: 'owner-test', isOwner: true as const };
    const first = await composeApplication({
      config: appConfig,
      env,
      providers: [{ adapter: fakeProvider() }],
      gateway: fakeGateway(),
    });
    let taskId = '';
    let conversationId = '';
    let firstStopped = false;
    const client = new MongoClient(uri as string);
    try {
      const submitted = await first.service.submitWork(principal, {
        objective: 'Persist this on a real server',
        mode: 'cloud',
        requireApproval: true,
      });
      assert.equal(submitted.ok, true);
      if (!submitted.ok) return;
      taskId = submitted.value.taskId;
      conversationId = submitted.value.conversationId;
      await waitFor(async () => {
        const status = await first.service.task(principal, taskId);
        return status.ok && status.value.state === 'completed' ? status.value : null;
      });
      await first.stop();
      firstStopped = true;

      const second = await composeApplication({
        config: appConfig,
        env,
        providers: [{ adapter: fakeProvider() }],
        gateway: fakeGateway(),
      });
      try {
        const status = await second.service.task(principal, taskId);
        assert.equal(status.ok, true);
        assert.equal(status.ok && status.value.state, 'completed');
        const conversation = await second.service.conversation(principal, conversationId);
        assert.equal(conversation.ok, true);
        assert.deepEqual(
          conversation.ok && conversation.value.messages.map((message) => message.role),
          ['user', 'assistant'],
        );
      } finally {
        await second.stop();
      }
    } finally {
      await client.connect().catch(() => undefined);
      await client.db(databaseName).dropDatabase().catch(() => undefined);
      await client.close().catch(() => undefined);
      rmSync(workspace, { recursive: true, force: true });
      if (!firstStopped) await first.stop().catch(() => undefined);
    }
  },
);

test(
  'a real database enforces generation fencing across two stores',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const workspace = mkdtempSync(path.join(tmpdir(), 'coderax-live-fence-'));
    const privateRoot = path.join(workspace, 'private');
    const cloudRoot = path.join(workspace, 'cloud');
    mkdirSync(privateRoot);
    mkdirSync(cloudRoot);
    const app = await composeApplication({
      config: config(
        { root: workspace, privateRoot, cloudRoot, cleanup: () => undefined },
        {
          persistence: {
            driver: 'mongo',
            uriEnv: 'CODERAX_TEST_MONGO_URI',
            database: databaseName,
            collectionPrefix: 'live_fence_',
          },
        },
      ),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
      providers: [{ adapter: fakeProvider() }],
      gateway: fakeGateway(),
    });
    try {
      const taskId = 'task_fence_live';
      const created = await app.dependencies.tasks.create(
        taskRecord({
          taskId,
          conversationId: 'conv_fence_live',
          ownerId: 'owner-test',
          state: 'running',
          runToken: 'token-old',
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      );
      assert.equal(created.ok, true);

      const wrong = await app.dependencies.tasks.updateFenced({
        taskId,
        token: 'token-new',
        patch: { state: 'completed' },
      });
      assert.deepEqual(wrong, { applied: false, reason: 'superseded' });

      const right = await app.dependencies.tasks.updateFenced({
        taskId,
        token: 'token-old',
        patch: { state: 'failed', failure: { code: 'provider_error', detail: 'fenced', retryable: false } },
      });
      assert.equal(right.applied, true);
      assert.equal((await app.dependencies.tasks.get(taskId))?.state, 'failed');

      const afterTerminal = await app.dependencies.tasks.updateFenced({
        taskId,
        token: 'token-old',
        patch: { state: 'completed' },
      });
      assert.deepEqual(afterTerminal, { applied: false, reason: 'terminal' });
    } finally {
      await app.stop().catch(() => undefined);
      const cleanup = new MongoClient(uri as string);
      await cleanup.connect().catch(() => undefined);
      await cleanup.db(databaseName).dropDatabase().catch(() => undefined);
      await cleanup.close().catch(() => undefined);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'a real database recovers an expired generation as interrupted and resumes it',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const workspace = mkdtempSync(path.join(tmpdir(), 'coderax-live-recovery-'));
    const privateRoot = path.join(workspace, 'private');
    const cloudRoot = path.join(workspace, 'cloud');
    mkdirSync(privateRoot);
    mkdirSync(cloudRoot);
    const app = await composeApplication({
      config: config(
        { root: workspace, privateRoot, cloudRoot, cleanup: () => undefined },
        {
          persistence: {
            driver: 'mongo',
            uriEnv: 'CODERAX_TEST_MONGO_URI',
            database: databaseName,
            collectionPrefix: 'live_recovery_',
          },
        },
      ),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
      providers: [{ adapter: fakeProvider() }],
      gateway: fakeGateway(),
    });
    const principal = { ownerId: 'owner-test', isOwner: true as const };
    try {
      const taskId = 'task_recovery_live';
      const conversationId = 'conv_recovery_live';
      const token = 'token-crashed';
      const expired = new Date(Date.now() - 60_000);
      const claimed = await app.dependencies.lease.claim({
        key: workRunKey({ tenantId: null, ownerId: principal.ownerId, conversationId }),
        owner: principal.ownerId,
        token,
        now: expired,
        expiresAt: new Date(expired.getTime() + 1_000),
      });
      assert.equal(claimed, true);
      assert.equal(
        (
          await app.dependencies.tasks.create(
            taskRecord({
              taskId,
              conversationId,
              ownerId: principal.ownerId,
              state: 'running',
              runToken: token,
              leaseExpiresAt: new Date(expired.getTime() + 1_000).toISOString(),
            }),
          )
        ).ok,
        true,
      );

      const recovered = await app.service.recoverInterrupted();
      assert.equal(recovered.interrupted, 1);
      const interrupted = await app.service.task(principal, taskId);
      assert.equal(interrupted.ok && interrupted.value.state, 'interrupted');

      const generation = interrupted.ok ? interrupted.value.generation : 1;
      const resumed = await app.service.resumeTask(principal, taskId, generation);
      assert.equal(resumed.ok, true);
      await app.dependencies.scheduler.idle();
      const completed = await app.service.task(principal, taskId);
      assert.equal(completed.ok && completed.value.state, 'completed');
      const notifications = await app.dependencies.notifications.list(principal.ownerId);
      assert.ok(notifications.notifications.some((entry) => entry.taskId === taskId));
    } finally {
      await app.stop().catch(() => undefined);
      const cleanup = new MongoClient(uri as string);
      await cleanup.connect().catch(() => undefined);
      await cleanup.db(databaseName).dropDatabase().catch(() => undefined);
      await cleanup.close().catch(() => undefined);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'a real database keeps notifications unread across a restart and supports mark-read',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const workspace = mkdtempSync(path.join(tmpdir(), 'coderax-live-notify-'));
    const privateRoot = path.join(workspace, 'private');
    const cloudRoot = path.join(workspace, 'cloud');
    mkdirSync(privateRoot);
    mkdirSync(cloudRoot);
    const appConfig = config(
      { root: workspace, privateRoot, cloudRoot, cleanup: () => undefined },
      {
        persistence: {
          driver: 'mongo',
          uriEnv: 'CODERAX_TEST_MONGO_URI',
          database: databaseName,
          collectionPrefix: 'live_notify_',
        },
      },
    );
    const env = { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string };
    const first = await composeApplication({ config: appConfig, env, providers: [{ adapter: fakeProvider() }], gateway: fakeGateway() });
    const notification = {
      taskId: 'task_notify_live',
      ownerId: 'owner-test',
      conversationId: 'conv_notify_live',
      agent: 'coderax' as const,
      mode: 'cloud' as const,
      state: 'completed' as const,
      summary: 'durable notification',
      createdAt: new Date().toISOString(),
      read: false,
    };
    let firstStopped = false;
    try {
      await first.dependencies.notifications.record(notification);
      await first.stop();
      firstStopped = true;

      const second = await composeApplication({ config: appConfig, env, providers: [{ adapter: fakeProvider() }], gateway: fakeGateway() });
      try {
        const before = await second.dependencies.notifications.list(notification.ownerId);
        assert.equal(before.unread, 1);
        assert.equal(before.notifications[0]?.summary, 'durable notification');
        await second.dependencies.notifications.markRead(notification.ownerId, notification.taskId);
      } finally {
        await second.stop();
      }

      const third = await composeApplication({ config: appConfig, env, providers: [{ adapter: fakeProvider() }], gateway: fakeGateway() });
      try {
        const after = await third.dependencies.notifications.list(notification.ownerId);
        assert.equal(after.unread, 0);
        assert.equal(after.notifications[0]?.read, true);
      } finally {
        await third.stop();
      }
    } finally {
      if (!firstStopped) await first.stop().catch(() => undefined);
      const cleanup = new MongoClient(uri as string);
      await cleanup.connect().catch(() => undefined);
      await cleanup.db(databaseName).dropDatabase().catch(() => undefined);
      await cleanup.close().catch(() => undefined);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'two racing replicas in a real database produce exactly one quota winner',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const client = new MongoClient(uri as string);
    await client.connect();
    // A database of this test's own. The tests above drop the shared database
    // when they finish, so a quota assertion must not depend on which test ran
    // first or on a concurrent insert race to produce a result.
    const database = client.db(`${databaseName}_quota`);
    const collection = database.collection('budget_windows') as unknown as MongoCollectionLike;
    try {
      await ensureBudgetIndexes(collection);
      const indexes = await database.collection('budget_windows').listIndexes().toArray();
      assert.ok(
        indexes.some((index) => index.name === 'budget_window' && index.unique === true),
        JSON.stringify(indexes),
      );

      const now = new Date('2026-11-26T10:00:00.000Z');
      const limits = { maxRequestsPerDay: 1, maxTokensPerDay: 1_000 };
      const replicas = [0, 1].map(() =>
        createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) }),
      );

      // Both replicas share one durable window and reserve in the same tick.
      // Which replica wins is a scheduling detail; that exactly one wins is the
      // constraint the unique index and the conditional update enforce.
      const outcomes = await Promise.all(
        replicas.map((replica) =>
          replica.reserve({ ownerId: 'owner', at: now, inputTokens: 10, outputTokens: 10 }),
        ),
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.allowed).length,
        1,
        JSON.stringify(outcomes),
      );
      const winnerIndex = outcomes.findIndex((outcome) => outcome.allowed);
      const winner = outcomes[winnerIndex];
      const winnerLedger = replicas[winnerIndex];
      assert.ok(winner && winnerLedger && winner.allowed);
      if (!winner || !winnerLedger || !winner.allowed) return;
      const loser = outcomes.find((outcome) => !outcome.allowed);
      assert.ok(loser && loser.allowed === false);
      if (!loser || loser.allowed !== false) return;
      assert.equal(loser.reason, 'requests');
      assert.equal(loser.requests, 1);

      // The durable window holds the winner's reservation, not two.
      const shared = createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) });
      assert.deepEqual(await shared.snapshot('owner', now), {
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      assert.equal(await shared.available('owner', now), false);

      // Settlement is applied once. Replaying the same reservation through a
      // fresh store (as another replica would) is a no-op, not a second charge.
      await winnerLedger.settle(winner.reservation.id, { inputTokens: 7, outputTokens: 3 });
      const replay = await createMongoBudgetStore(collection).settle({
        key: budgetKey('owner', now),
        reservationId: winner.reservation.id,
        reservedTokens: 20,
        reservedInputTokens: 10,
        reservedOutputTokens: 10,
        usage: { inputTokens: 7, outputTokens: 3 },
      });
      assert.equal(replay, false);

      // A fresh process reads the same durable window, not a local copy.
      const restarted = createBudgetLedger({ ...limits, store: createMongoBudgetStore(collection) });
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
