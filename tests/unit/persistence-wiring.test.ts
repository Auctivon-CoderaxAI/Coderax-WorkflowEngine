import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import type { EngineConfig } from '../../src/configuration/schema.js';
import { createMongoConnector, MongoUnavailableError } from '../../src/persistence/mongo-connect.js';
import { createFakeCollection, createFakeDatabase } from '../fakes/mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeProvider,
  OWNER_TOKEN,
  waitFor,
  type TestWorkspace,
} from '../helpers.js';

const ENV = { CODERAX_OWNER_TOKEN: OWNER_TOKEN };
const principal = { ownerId: 'owner-test', isOwner: true as const };

function mongoConfig(
  workspace: TestWorkspace,
  persistence: Record<string, unknown> = {},
): EngineConfig {
  return baseConfig(workspace, {
    persistence: { driver: 'mongo', ...persistence },
  });
}

function startupIssue(error: unknown): string {
  assert.ok(error instanceof StartupError);
  return error.issues.join('\n');
}

test('the default persistence driver is memory', async () => {
  const workspace = createWorkspaces();
  try {
    const app = await composeApplication({
      config: baseConfig(workspace),
      env: ENV,
      providers: [{ adapter: fakeProvider() }],
    });
    assert.deepEqual(app.persistence, { driver: 'memory' });
    await app.stop();
  } finally {
    workspace.cleanup();
  }
});

test('selecting mongo persists a task, its transcript and its notification across a restart', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  try {
    const first = await composeApplication({
      config: mongoConfig(workspace),
      env: ENV,
      providers: [{ adapter: fakeProvider() }],
      persistence: { database },
    });
    assert.deepEqual(first.persistence, { driver: 'mongo' });

    // Every store was bootstrapped with its own indexes at startup.
    assert.ok(
      database.collections.get('tasks')?.indexes.some(
        (index) => index.keys.taskId === 1 && index.options?.unique === true,
      ),
    );
    assert.ok(database.collections.get('messages')?.indexes.some((index) => index.keys.messageId === 1));
    assert.ok(
      database.collections.get('memory')?.indexes.some((index) => index.options?.unique === true),
    );
    assert.ok(
      database.collections.get('notifications')?.indexes.some(
        (index) => index.keys.taskId === 1 && index.options?.unique === true,
      ),
    );

    const submitted = await first.service.submitWork(principal, {
      objective: 'Persist this task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const { taskId, conversationId } = submitted.value;

    await waitFor(async () => {
      const status = await first.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    await first.stop();

    // A new process with no memory of the first: everything is read from MongoDB.
    const second = await composeApplication({
      config: mongoConfig(workspace),
      env: ENV,
      providers: [{ adapter: fakeProvider() }],
      persistence: { database },
    });
    try {
      const status = await second.service.task(principal, taskId);
      assert.equal(status.ok, true);
      assert.equal(status.ok && status.value.state, 'completed');
      assert.ok(status.ok && status.value.result?.summary?.includes('A verified result.'));

      const conversation = await second.service.conversation(principal, conversationId);
      assert.equal(conversation.ok, true);
      if (conversation.ok) {
        assert.deepEqual(
          conversation.value.messages.map((entry) => entry.role),
          ['user', 'assistant'],
        );
        assert.equal(conversation.value.messages[0]?.text, 'Persist this task');
      }

      const notifications = await second.service.notifications(principal);
      assert.equal(notifications.unread, 1);
      assert.equal(notifications.notifications[0]?.taskId, taskId);
      assert.equal(notifications.notifications[0]?.state, 'completed');

      // The lease was released on settlement, so nothing is left claiming the run.
      assert.equal(database.collections.get('work_runs')?.documents.length, 0);
      assert.equal(database.collections.get('tasks')?.documents.length, 1);
      assert.equal(database.collections.get('messages')?.documents.length, 2);
    } finally {
      await second.stop();
    }
  } finally {
    workspace.cleanup();
  }
});

test('mongo without a connection string fails startup and names the variable', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: mongoConfig(workspace),
          env: ENV,
          providers: [{ adapter: fakeProvider() }],
        }),
      (error: unknown) => {
        assert.match(startupIssue(error), /CODERAX_MONGODB_URI is not set/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('the connection string is read from the configured variable name', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const seen: Array<{ uri: string; database: string }> = [];
  try {
    const app = await composeApplication({
      config: mongoConfig(workspace, {
        uriEnv: 'CODERAX_TEST_MONGO',
        database: 'engine_test',
        collectionPrefix: 'test_',
      }),
      env: { ...ENV, CODERAX_TEST_MONGO: 'mongodb://127.0.0.1:27017' },
      providers: [{ adapter: fakeProvider() }],
      persistence: {
        connect: async (input) => {
          seen.push(input);
          return database;
        },
      },
    });
    assert.deepEqual(seen, [{ uri: 'mongodb://127.0.0.1:27017', database: 'engine_test' }]);
    assert.deepEqual(app.persistence, { driver: 'mongo' });
    assert.ok(database.collections.has('test_work_runs'));
    assert.ok(database.collections.has('test_tasks'));
    await app.stop();
  } finally {
    workspace.cleanup();
  }
});

test('an unreachable deployment fails startup instead of downgrading', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: mongoConfig(workspace),
          env: { ...ENV, CODERAX_MONGODB_URI: 'mongodb://127.0.0.1:1/coderax' },
          providers: [{ adapter: fakeProvider() }],
          persistence: {
            connect: async () => {
              throw new MongoUnavailableError(
                'persistence.driver is mongo but 127.0.0.1:1/coderax is not reachable: refused',
              );
            },
          },
        }),
      (error: unknown) => {
        assert.match(startupIssue(error), /is not reachable/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('a collection that cannot be indexed fails startup', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const broken = createFakeCollection();
  broken.createIndex = async () => {
    throw new Error('not authorized on coderax');
  };
  const original = database.collection.bind(database);
  database.collection = (name) => (name === 'tasks' ? broken : original(name));
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: mongoConfig(workspace),
          env: ENV,
          providers: [{ adapter: fakeProvider() }],
          persistence: { database },
        }),
      (error: unknown) => {
        assert.match(startupIssue(error), /database coderax is unusable/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('an unknown persistence driver is refused by configuration', () => {
  const workspace = createWorkspaces();
  try {
    assert.throws(() => baseConfig(workspace, { persistence: { driver: 'postgres' } }));
  } finally {
    workspace.cleanup();
  }
});

test('the Mongo connector requires TLS for remote or discoverable connections', async () => {
  const seen: Array<boolean | undefined> = [];
  const result = createFakeCollection();
  let settings: {
    tls?: boolean;
    srvHost?: string;
    hosts: Array<{ host: string }>;
  } = { hosts: [{ host: 'db.example.test' }] };
  const connect = createMongoConnector(async () => ({
    MongoClient: class {
      readonly options;
      constructor(_uri: string, options?: Record<string, unknown>) {
        this.options = { ...settings, directConnection: options?.directConnection === true };
      }
      async connect() {
        seen.push(this.options.directConnection);
      }
      db() {
        return { command: async () => undefined, collection: () => result };
      }
      async close() {}
    },
  }));
  const target = { uri: 'fixture', database: 'engine' };

  await assert.rejects(connect(target), /Remote MongoDB connections require TLS/);
  settings = { hosts: [], srvHost: 'db.example.test', tls: false };
  await assert.rejects(connect(target), /Remote MongoDB connections require TLS/);
  assert.deepEqual(seen, []);

  settings = { hosts: [{ host: 'db.example.test' }], tls: true };
  const database = await connect(target);
  assert.equal(database.collection('leases'), result);
  await database.close();
  settings = { hosts: [{ host: 'localhost' }] };
  await (await connect(target)).close();
  assert.deepEqual(seen, [false, true]);
});

test('a second replica can decide a stored approval and exactly one replica consumes it', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const options = { config: mongoConfig(workspace), providers: [{ adapter: fakeProvider() }], env: ENV, persistence: { database } };
  const first = await composeApplication(options);
  const second = await composeApplication(options);
  try {
    const args = { ownerId: 'owner', taskId: 'task', scope: 'browser.use' as const,
      resource: 'browser', binding: 'action-A', consume: true };
    const store = first.dependencies.permissions;
    const other = second.dependencies.permissions;
    const request = await store.request({ ...args, agent: 'coderax', description: 'One action' });
    assert.ok((await other.decide({ ...args, requestId: request.requestId, decision: 'approved' })).ok);
    assert.equal(await store.lookup({ ...args, binding: 'action-B' }), null);
    const results = await Promise.all([store.lookup(args), other.lookup(args)]);
    assert.equal(results.filter(result => result?.decision === 'granted').length, 1);
  } finally {
    await first.stop();
    await second.stop();
    workspace.cleanup();
  }
});
