import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { createMongoConnector, type MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { baseConfig, fakeGateway, OWNER_TOKEN, taskRecord } from '../helpers.js';

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

async function assertRejectedRun(query: { conversationId: string } | { taskId: string }, generation: number): Promise<void> {
  const reader = await createMongoConnector()({ uri: uri as string, database: databaseName });
  try {
    const task = await reader.collection('tasks').findOne(query);
    assert.equal(task?.state, 'failed');
    assert.equal(task.generation, generation);
    assert.deepEqual(task.failure, {
      code: 'server_unavailable',
      detail: 'The engine shut down before the run could be scheduled.',
      retryable: true,
    });
    assert.equal(await reader.collection('work_runs').findOne({ token: task.runToken }), null);
  } finally {
    await reader.close();
  }
}

test('shutdown settles a rejected submitWork before closing persistence', { skip }, async () => {
  requiresDatabase();
  const dirs = workspace();
  const database = await createMongoConnector()({ uri: uri as string, database: databaseName });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  let hold = true;
  const delayed: MongoDatabase = {
    collection: (name) => {
      const collection = database.collection(name);
      return new Proxy(collection, {
        get(target, property, receiver) {
          if (name.endsWith('conversations') && property === 'findOne') {
            return async (...args: Parameters<typeof target.findOne>) => {
              if (hold) {
                hold = false;
                signalEntered();
                await released;
                assert.equal(closed, false);
              }
              return target.findOne(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    close: () => {
      closed = true;
      return database.close();
    },
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
    const conversationId = 'conv_shutdown_submit';
    const request = { conversationId, objective: 'finish admitting work during shutdown', mode: 'cloud' as const, requireApproval: true };
    const admission = app.service.submitWork(principal, request);
    await entered;
    const stopped = app.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    const refused = await app.service.submitWork(principal, request);
    assert.ok(!refused.ok && refused.code === 'not_ready');
    release();
    const reply = await admission;
    assert.ok(!reply.ok && reply.code === 'not_ready');
    await stopped;
    assert.equal(closed, true);
    await assertRejectedRun({ conversationId }, 1);
  } finally {
    release();
    await app.stop().catch(() => undefined);
    await cleanDatabase();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('shutdown drains admitted chat through its assistant write', { skip }, async () => {
  requiresDatabase();
  const dirs = workspace();
  const database = await createMongoConnector()({ uri: uri as string, database: databaseName });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  const app = await composeApplication({
    config: baseConfig(dirs, {
      persistence: { driver: 'mongo', uriEnv: 'CODERAX_TEST_MONGO_URI', database: databaseName },
    }),
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
    gateway: fakeGateway({ beforeReturn: async () => { signalEntered(); await released; } }),
    persistence: { database: { collection: database.collection, close: () => {
      closed = true;
      return database.close();
    } } },
  });
  try {
    const request = { message: 'finish before closing', mode: 'cloud' as const, agent: 'coderax' as const };
    const chat = app.service.chat(principal, request);
    await entered;
    const stopped = app.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    const refused = await app.service.chat(principal, request);
    assert.ok(!refused.ok && refused.code === 'not_ready');
    release();
    const reply = await chat;
    assert.ok(reply.ok);
    await stopped;
    assert.equal(closed, true);
    const reader = await createMongoConnector()({ uri: uri as string, database: databaseName });
    try {
      const saved = await reader.collection('messages').findOne({ messageId: reply.value.messageId });
      assert.equal(saved?.role, 'assistant');
      assert.equal(saved?.text, reply.value.text);
    } finally {
      await reader.close();
    }
  } finally {
    release();
    await app.stop().catch(() => undefined);
    await cleanDatabase();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

for (const method of ['resumeTask', 'retryTask'] as const) {
  test(`shutdown drains an admitted ${method} through reissue`, { skip }, async () => {
    requiresDatabase();
    const dirs = workspace();
    const database = await createMongoConnector()({ uri: uri as string, database: databaseName });
    let closed = false;
    const app = await composeApplication({
      config: baseConfig(dirs, {
        persistence: { driver: 'mongo', uriEnv: 'CODERAX_TEST_MONGO_URI', database: databaseName },
      }),
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_TEST_MONGO_URI: uri as string },
      gateway: fakeGateway(),
      persistence: { database: { collection: database.collection, close: () => {
        closed = true;
        return database.close();
      } } },
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let admission: ReturnType<typeof app.service.resumeTask> | undefined;
    try {
      const tasks = app.dependencies.tasks;
      const task = taskRecord({
        ownerId: principal.ownerId,
        state: method === 'resumeTask' ? 'awaiting_approval' : 'failed',
      });
      assert.ok((await tasks.create(task)).ok);
      const get = tasks.get;
      tasks.get = async (taskId) => {
        signalEntered();
        await released;
        return get(taskId);
      };

      admission = app.service[method](principal, task.taskId, task.generation);
      await entered;
      const stopping = app.stop();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
      const refused = await app.service[method](principal, task.taskId, task.generation);
      assert.ok(!refused.ok && refused.code === 'not_ready');
      release();
      const reply = await admission;
      assert.ok(!reply.ok && reply.code === 'not_ready');
      await stopping;
      assert.equal(closed, true);
      await assertRejectedRun({ taskId: task.taskId }, task.generation + 1);
    } finally {
      release();
      await admission?.catch(() => undefined);
      await app.stop().catch(() => undefined);
      await cleanDatabase();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
}
