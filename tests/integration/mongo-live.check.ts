import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPersistence } from '../../src/bootstrap/persistence.js';
import { workRunKey } from '../../src/execution/lease.js';
import {
  createMongoConnector,
  describeTarget,
} from '../../src/persistence/mongo-connect.js';
import { createClock } from '../../src/support/clock.js';
import { baseConfig, createWorkspaces, taskRecord } from '../helpers.js';

/**
 * Real MongoDB integration.
 *
 * This file is deliberately not named `*.test.ts`, so the default suite cannot
 * report it as skipped or silently pass it. `npm run test:mongo:live` requires
 * `CODERAX_TEST_MONGO_URI` and fails when it is absent; the fake-collection tests
 * in `tests/fakes/mongo.ts` remain a separate, explicitly named layer.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI;
const COLLECTIONS = [
  'work_runs',
  'tasks',
  'conversations',
  'messages',
  'memory',
  'notifications',
];

test('REAL MongoDB: durable leases, fencing and task state', { timeout: 30_000 }, async () => {
  assert.ok(
    uri && uri.trim().length > 0,
    'CODERAX_TEST_MONGO_URI is required: this is the real database gate, not the fake collection suite',
  );
  const workspace = createWorkspaces();
  const prefix = `gate_${Date.now()}_`;
  const config = baseConfig(workspace, {
    persistence: {
      driver: 'mongo',
      database: 'coderax_gate',
      collectionPrefix: prefix,
    },
  });
  const clock = createClock();
  const stores = await buildPersistence({
    config,
    env: { CODERAX_MONGODB_URI: uri },
    clock,
  });
  try {
    assert.equal(stores.driver, 'mongo');

    const scope = { ownerId: 'owner_live', tenantId: null, conversationId: 'conv_live' };
    const key = workRunKey(scope);
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + 30_000);

    assert.equal(
      await stores.lease.claim({ key, owner: 'owner_live', token: 'token-a', now, expiresAt }),
      true,
    );
    assert.equal(
      await stores.lease.claim({ key, owner: 'owner_live', token: 'token-b', now, expiresAt }),
      false,
    );
    assert.equal(
      (await stores.lease.renew({ key, token: 'token-b', now, expiresAt })).renewed,
      false,
    );
    assert.equal(await stores.lease.cancel({ key, now }), 'requested');
    const snapshot = await stores.lease.read({ key, now });
    assert.equal(snapshot?.token, 'token-a');
    assert.equal(snapshot?.cancelRequested, true);
    assert.equal(snapshot?.live, true);
    assert.equal(await stores.lease.release({ key, token: 'token-b' }), false);
    assert.equal(await stores.lease.release({ key, token: 'token-a' }), true);

    const created = await stores.tasks.create(
      taskRecord({
        taskId: 'task_live',
        conversationId: 'conv_live',
        ownerId: 'owner_live',
        state: 'running',
        runToken: 'token-a',
      }),
    );
    assert.equal(created.ok, true);
    assert.deepEqual(
      await stores.tasks.updateFenced({
        taskId: 'task_live',
        token: 'token-b',
        patch: { state: 'completed' },
      }),
      { applied: false, reason: 'superseded' },
    );
    const applied = await stores.tasks.updateFenced({
      taskId: 'task_live',
      token: 'token-a',
      patch: {
        state: 'completed',
        result: { summary: 'live database result', artifacts: [] },
      },
    });
    assert.equal(applied.applied, true);
    const loaded = await stores.tasks.get('task_live');
    assert.equal(loaded?.state, 'completed');
    assert.equal(loaded?.result?.summary, 'live database result');

    process.stdout.write(
      `REAL MongoDB integration passed against ${describeTarget(uri)} (prefix ${prefix})\n`,
    );
  } finally {
    const cleanup = await createMongoConnector()({ uri, database: 'coderax_gate' });
    for (const name of COLLECTIONS) {
      await cleanup.collection(`${prefix}${name}`).deleteMany({});
    }
    await cleanup.close();
    await stores.close();
    workspace.cleanup();
  }
});
