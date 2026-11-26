import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import type { EngineConfig } from '../../src/configuration/schema.js';
import { MongoUnavailableError } from '../../src/persistence/mongo-connect.js';
import { createFakeCollection } from '../fakes/mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_TOKEN,
  type TestWorkspace,
} from '../helpers.js';

const ENV = { CODERAX_OWNER_TOKEN: OWNER_TOKEN };

function mongoConfig(workspace: TestWorkspace, persistence: Record<string, unknown> = {}): EngineConfig {
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
      gateway: fakeGateway(),
    });
    assert.deepEqual(app.persistence, { driver: 'memory' });
    await app.stop();
  } finally {
    workspace.cleanup();
  }
});

test('selecting mongo puts the composed lease store on the collection', async () => {
  const workspace = createWorkspaces();
  const collection = createFakeCollection();
  try {
    const app = await composeApplication({
      config: mongoConfig(workspace),
      env: ENV,
      gateway: fakeGateway(),
      persistence: { workRuns: collection },
    });
    assert.deepEqual(app.persistence, { driver: 'mongo' });
    // Startup bootstrapped the indexes, so the table is usable and not assumed.
    assert.ok(
      collection.indexes.some(
        (index) => index.keys.key === 1 && index.options?.unique === true,
      ),
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30_000);
    assert.equal(
      await app.dependencies.lease.claim({
        key: 'owner-test|conv_1',
        owner: 'replica-a',
        token: 'token-a',
        now,
        expiresAt,
      }),
      true,
    );
    assert.equal(collection.documents.length, 1);
    assert.equal(collection.documents[0]?.token, 'token-a');

    // A second replica is refused by the unique key, not by process memory.
    assert.equal(
      await app.dependencies.lease.claim({
        key: 'owner-test|conv_1',
        owner: 'replica-b',
        token: 'token-b',
        now,
        expiresAt,
      }),
      false,
    );

    await app.stop();
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
          gateway: fakeGateway(),
        }),
      (error: unknown) => {
        const issue = startupIssue(error);
        assert.match(issue, /CODERAX_MONGODB_URI is not set/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('the connection string is read from the configured variable name', async () => {
  const workspace = createWorkspaces();
  const collection = createFakeCollection();
  const seen: Array<{ uri: string; database: string; collection: string }> = [];
  try {
    const app = await composeApplication({
      config: mongoConfig(workspace, {
        uriEnv: 'CODERAX_TEST_MONGO',
        database: 'engine_test',
        workRunsCollection: 'leases',
      }),
      env: { ...ENV, CODERAX_TEST_MONGO: 'mongodb://127.0.0.1:27017' },
      gateway: fakeGateway(),
      persistence: {
        connect: async (input) => {
          seen.push(input);
          return { collection, close: async () => undefined };
        },
      },
    });
    assert.deepEqual(seen, [
      { uri: 'mongodb://127.0.0.1:27017', database: 'engine_test', collection: 'leases' },
    ]);
    assert.deepEqual(app.persistence, { driver: 'mongo' });
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
          gateway: fakeGateway(),
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
  const collection = createFakeCollection();
  collection.createIndex = async () => {
    throw new Error('not authorized on coderax');
  };
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: mongoConfig(workspace),
          env: ENV,
          gateway: fakeGateway(),
          persistence: { workRuns: collection },
        }),
      (error: unknown) => {
        assert.match(startupIssue(error), /work_runs collection is unusable/);
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
    assert.throws(() =>
      baseConfig(workspace, { persistence: { driver: 'postgres' } }),
    );
  } finally {
    workspace.cleanup();
  }
});
