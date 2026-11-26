import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../../src/persistence/mongo.js';
import { createLeaseStore } from '../../src/persistence/work-runs.js';
import { baseConfig, fakeGateway, OWNER_TOKEN, waitFor } from '../helpers.js';

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
        gateway: fakeGateway(),
      });
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
      await app.stop();
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
    const second = await connector({ uri: uri as string, database: databaseName });
    const collection = first.collection('live_lease_race');
    await ensureWorkRunIndexes(collection);
    const a = createLeaseStore(createMongoWorkRunTable(collection));
    const b = createLeaseStore(createMongoWorkRunTable(second.collection('live_lease_race')));
    const key = '["","owner","conversation"]';
    const now = new Date();
    try {
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
      await first.close();
      await second.close();
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
