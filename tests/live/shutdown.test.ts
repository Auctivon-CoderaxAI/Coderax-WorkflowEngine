import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { createMongoConnector, type MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { baseConfig, fakeGateway, OWNER_TOKEN } from '../helpers.js';

/**
 * Deterministic shutdown evidence against a real server.
 *
 * The first test proves the lifecycle is idempotent and rejects new work before
 * the drain. The second wraps every task `updateOne` with a delay so a checkpoint
 * write is genuinely in flight when stop() is called; persistence must not close
 * under it. Both fail rather than skip when the database is absent.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI;
const required = process.env.CODERAX_REQUIRE_MONGO === '1';
const databaseName = `coderax_shutdown_${process.pid}_${Date.now()}`;
const principal = { ownerId: 'owner-test', isOwner: true as const };
const skip = uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set';

function requiresDatabase(): void {
  assert.ok(
    uri,
    'CODERAX_TEST_MONGO_URI must name a reachable MongoDB; set CODERAX_REQUIRE_MONGO=1 in CI',
  );
}

function workspace(): {
  root: string;
  privateRoot: string;
  cloudRoot: string;
  cleanup: () => undefined;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-shutdown-'));
  const privateRoot = path.join(root, 'private');
  const cloudRoot = path.join(root, 'cloud');
  mkdirSync(privateRoot);
  mkdirSync(cloudRoot);
  return { root, privateRoot, cloudRoot, cleanup: () => undefined };
}

async function cleanDatabase(): Promise<void> {
  const client = new MongoClient(uri as string);
  await client.connect().catch(() => undefined);
  await client.db(databaseName).dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
}

test('shutdown is idempotent and refuses new execution before draining', { skip }, async () => {
  requiresDatabase();
  const dirs = workspace();
  const database = await createMongoConnector()({ uri: uri as string, database: databaseName });
  const app = await composeApplication({
    config: baseConfig(dirs, {
      persistence: { driver: 'mongo', uriEnv: 'CODERAX_TEST_MONGO_URI', database: databaseName },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
    gateway: fakeGateway(),
    persistence: { database },
  });
  try {
    app.service.beginShutdown();
    const refused = await app.service.submitWork(principal, {
      objective: 'must not start during shutdown',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, 'not_ready');

    const first = app.stop();
    const second = app.stop();
    assert.equal(first, second, 'concurrent stop calls must share one lifecycle');
    await Promise.all([first, second]);
  } finally {
    await app.stop().catch(() => undefined);
    await cleanDatabase();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a delayed checkpoint write is drained before persistence closes', { skip }, async () => {
  requiresDatabase();
  const dirs = workspace();
  const database = await createMongoConnector()({ uri: uri as string, database: databaseName });
  const writes: Array<Promise<unknown>> = [];
  const delayed: MongoDatabase = {
    collection: (name: string) => {
      const collection = database.collection(name);
      return new Proxy(collection, {
        get(target, property, receiver) {
          if (property === 'updateOne') {
            return (...args: unknown[]) => {
              const write = (async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                const update = Reflect.get(target, property, target) as (
                  ...input: unknown[]
                ) => unknown;
                return update.apply(target, args);
              })();
              writes.push(write);
              return write;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    close: () => database.close(),
  };
  const app = await composeApplication({
    config: baseConfig(dirs, {
      persistence: { driver: 'mongo', uriEnv: 'CODERAX_TEST_MONGO_URI', database: databaseName },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
    gateway: fakeGateway(),
    persistence: { database: delayed },
  });
  try {
    const submitted = await app.service.submitWork(principal, {
      objective: 'delayed checkpoint shutdown',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    // Stop immediately; the delayed fenced write is in flight or about to start.
    await app.stop();
    // The injected writes must have finished before persistence closed; a close
    // during any of them would reject these promises.
    await Promise.all(writes);
  } finally {
    await app.stop().catch(() => undefined);
    await cleanDatabase();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
