import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { buildPersistence } from '../../src/bootstrap/persistence.js';
import { workRunKey } from '../../src/execution/lease.js';
import { describeTarget } from '../../src/persistence/mongo-connect.js';
import { createClock } from '../../src/support/clock.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  taskRecord,
  waitFor,
} from '../helpers.js';

/**
 * Real MongoDB integration: the only database evidence the gate accepts.
 *
 * This file is deliberately not named `*.test.ts`, so the default suite cannot
 * report it as skipped or silently pass it. `npm run test:mongo:live` requires
 * `CODERAX_TEST_MONGO_URI`; without a server every test fails rather than
 * skipping. The fake-collection suites in `tests/unit/mongo-*.test.ts` remain a
 * separate, explicitly named layer and are not accepted as database evidence.
 *
 * Covered against a real server: index arbitration, two-replica leases,
 * generation fencing, reissue races, idempotent creation, conversation and
 * message isolation, durable notifications, crash-to-interrupted recovery and
 * restart persistence. Durable approvals, atomic quotas, artifacts, durable
 * events and durable schedules do not exist on this branch; their owning pull
 * requests must add live cases here rather than claim an in-memory path.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI?.trim() ?? '';
const DATABASE = 'coderax_gate';

function requireDatabase(): void {
  assert.ok(
    uri.length > 0,
    'CODERAX_TEST_MONGO_URI is required: this is the real database gate, not the fake collection suite',
  );
}

function prefix(label: string): string {
  return `gate_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_`;
}

function settings(label: string): { prefix: string } {
  return { prefix: prefix(label) };
}

async function dropPrefix(namePrefix: string): Promise<void> {
  if (!uri) return;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const database = client.db(DATABASE);
    const collections = await database.listCollections().toArray();
    for (const collection of collections) {
      if (!collection.name.startsWith(namePrefix)) continue;
      await database.collection(collection.name).drop().catch(() => undefined);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

test('REAL MongoDB: unique indexes exist and two replicas cannot own one lease', { timeout: 30_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('lease');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const clock = createClock();
  const stores = await buildPersistence({
    config,
    env: { CODERAX_MONGODB_URI: uri },
    clock,
  });
  const replica = await buildPersistence({
    config,
    env: { CODERAX_MONGODB_URI: uri },
    clock,
  });
  try {
    assert.equal(stores.driver, 'mongo');

    const client = new MongoClient(uri);
    await client.connect();
    try {
      const database = client.db(DATABASE);
      const expected = [
        { collection: 'work_runs', index: 'work_run_key' },
        { collection: 'tasks', index: 'task_id' },
        { collection: 'conversations', index: 'conversation_id' },
        { collection: 'messages', index: 'message_id' },
        { collection: 'notifications', index: 'notification_task' },
        { collection: 'memory', index: 'memory_partition' },
      ];
      for (const entry of expected) {
        const indexes = await database
          .collection(`${namePrefix}${entry.collection}`)
          .listIndexes()
          .toArray();
        assert.ok(
          indexes.some((index) => index.name === entry.index && index.unique === true),
          `${entry.collection} must carry the unique ${entry.index} index: ${JSON.stringify(indexes)}`,
        );
      }
    } finally {
      await client.close();
    }

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
      await replica.lease.claim({
        key,
        owner: 'owner_live',
        token: 'token-replica',
        now,
        expiresAt,
      }),
      false,
    );
    assert.equal((await replica.lease.read({ key, now }))?.token, 'token-a');
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

    process.stdout.write(
      `REAL MongoDB integration passed against ${describeTarget(uri)} (prefix ${namePrefix})\n`,
    );
  } finally {
    await replica.close();
    await stores.close();
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

test('REAL MongoDB: generation fencing and a two-store reissue race', { timeout: 30_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('fence');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const clock = createClock();
  const first = await buildPersistence({ config, env: { CODERAX_MONGODB_URI: uri }, clock });
  const second = await buildPersistence({ config, env: { CODERAX_MONGODB_URI: uri }, clock });
  try {
    const taskId = 'task_fence_live';
    const created = await first.tasks.create(
      taskRecord({
        taskId,
        conversationId: 'conv_fence_live',
        ownerId: 'owner_live',
        state: 'running',
        runToken: 'token-old',
      }),
    );
    assert.equal(created.ok, true);
    assert.deepEqual(
      await first.tasks.updateFenced({
        taskId,
        token: 'token-new',
        patch: { state: 'completed' },
      }),
      { applied: false, reason: 'superseded' },
    );
    assert.equal(
      (
        await first.tasks.updateFenced({
          taskId,
          token: 'token-old',
          patch: { state: 'completed', result: { summary: 'live database result', artifacts: [] } },
        })
      ).applied,
      true,
    );
    assert.deepEqual(
      await second.tasks.updateFenced({
        taskId,
        token: 'token-old',
        patch: { state: 'completed' },
      }),
      { applied: false, reason: 'terminal' },
    );
    assert.equal((await second.tasks.get(taskId))?.result?.summary, 'live database result');

    // Two replicas resuming the same task must not both issue a generation.
    const now = clock.iso();
    const expiresAt = new Date(clock.now().getTime() + 30_000).toISOString();
    const claimedByFirst = await first.tasks.reissue({
      taskId,
      token: 'token-gen-1',
      now,
      leaseExpiresAt: expiresAt,
    });
    assert.equal(claimedByFirst.applied, true);
    const claimedBySecond = await second.tasks.reissue({
      taskId,
      token: 'token-gen-2',
      now,
      leaseExpiresAt: expiresAt,
    });
    assert.deepEqual(claimedBySecond, { applied: false, reason: 'superseded' });
    assert.equal((await second.tasks.get(taskId))?.generation, 2);
  } finally {
    await second.close();
    await first.close();
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

test('REAL MongoDB: idempotent creation and conversation isolation', { timeout: 30_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('identity');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const clock = createClock();
  const stores = await buildPersistence({ config, env: { CODERAX_MONGODB_URI: uri }, clock });
  try {
    const task = taskRecord({
      taskId: 'task_idempotent_live',
      conversationId: 'conv_identity_a',
      ownerId: 'owner_live',
      state: 'running',
      runToken: 'token-a',
    });
    assert.equal((await stores.tasks.create(task)).ok, true);
    assert.deepEqual(await stores.tasks.create(task), { ok: false, reason: 'exists' });
    assert.deepEqual(
      await stores.tasks.create(
        taskRecord({
          taskId: 'task_second_live',
          conversationId: 'conv_identity_a',
          ownerId: 'owner_live',
          state: 'queued',
        }),
      ),
      { ok: false, reason: 'conversation_busy' },
    );

    const now = clock.iso();
    const conversationA = {
      conversationId: 'conv_identity_a',
      ownerId: 'owner_live',
      tenantId: null,
      mode: 'cloud' as const,
      isWork: true,
      agent: 'coderax' as const,
      createdAt: now,
      updatedAt: now,
    };
    const conversationB = {
      ...conversationA,
      conversationId: 'conv_identity_b',
    };
    await stores.conversations.ensure(conversationA);
    await stores.conversations.ensure(conversationB);

    const message = {
      messageId: 'message_a',
      conversationId: 'conv_identity_a',
      role: 'user' as const,
      text: 'private conversation A',
      createdAt: now,
    };
    assert.equal(await stores.conversations.appendMessage(message), true);
    assert.equal(await stores.conversations.appendMessage(message), false);
    assert.deepEqual(await stores.conversations.messages('conv_identity_b'), []);
    assert.equal((await stores.conversations.get('owner_other', 'conv_identity_a')), null);
    await assert.rejects(
      stores.conversations.ensure({ ...conversationA, ownerId: 'owner_other' }),
      /collision/,
    );
  } finally {
    await stores.close();
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

test('REAL MongoDB: notifications are durable across replicas and mark-read sticks', { timeout: 30_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('notify');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const clock = createClock();
  const first = await buildPersistence({ config, env: { CODERAX_MONGODB_URI: uri }, clock });
  const second = await buildPersistence({ config, env: { CODERAX_MONGODB_URI: uri }, clock });
  try {
    await first.notifications.record({
      taskId: 'task_notify_live',
      ownerId: 'owner_live',
      conversationId: 'conv_notify_live',
      agent: 'coderax',
      mode: 'cloud',
      state: 'completed',
      summary: 'durable notification',
      createdAt: clock.iso(),
      read: false,
    });
    const before = await second.notifications.list('owner_live');
    assert.equal(before.unread, 1);
    assert.equal(before.notifications[0]?.taskId, 'task_notify_live');
    await second.notifications.markRead('owner_live', 'task_notify_live');
    const after = await first.notifications.list('owner_live');
    assert.equal(after.unread, 0);
    assert.equal(after.notifications[0]?.read, true);
    assert.equal((await second.notifications.list('owner_other')).unread, 0);
  } finally {
    await second.close();
    await first.close();
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

test('REAL MongoDB: a completed task and its transcript survive a restart', { timeout: 60_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('restart');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const env = { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_MONGODB_URI: uri };
  const principal = { ownerId: OWNER_ID, isOwner: true as const };
  const first = await composeApplication({ config, env, gateway: fakeGateway({ text: 'durable result' }) });
  let taskId = '';
  let conversationId = '';
  let stopped = false;
  try {
    await first.start();
    const submitted = await first.service.submitWork(principal, {
      objective: 'Persist this work on a real server',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    taskId = submitted.value.taskId;
    conversationId = submitted.value.conversationId;
    await waitFor(async () => {
      const status = await first.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    // Settlement writes the terminal notification after the task patch; wait for
    // the whole run to leave the scheduler before closing the database client.
    await first.dependencies.scheduler.idle();
    await waitFor(async () => {
      const listed = await first.dependencies.notifications.list(principal.ownerId);
      return listed.notifications.some((entry) => entry.taskId === taskId) ? listed : null;
    });
    await first.stop();
    stopped = true;

    const second = await composeApplication({
      config,
      env,
      gateway: fakeGateway({ text: 'durable result' }),
    });
    try {
      await second.start();
      const status = await second.service.task(principal, taskId);
      assert.equal(status.ok && status.value.state, 'completed');
      assert.match(status.ok ? (status.value.result?.summary ?? '') : '', /durable result/);
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
    if (!stopped) await first.stop().catch(() => undefined);
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

test('REAL MongoDB: startup recovers an expired run and a resumed run completes', { timeout: 60_000 }, async () => {
  requireDatabase();
  const workspace = createWorkspaces();
  const { prefix: namePrefix } = settings('recovery');
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo', database: DATABASE, collectionPrefix: namePrefix },
  });
  const env = { CODERAX_OWNER_TOKEN: OWNER_TOKEN, CODERAX_MONGODB_URI: uri };
  const principal = { ownerId: OWNER_ID, isOwner: true as const };
  const app = await composeApplication({
    config,
    env,
    gateway: fakeGateway({ text: 'resumed result' }),
  });
  try {
    const taskId = 'task_recovery_live';
    const conversationId = 'conv_recovery_live';
    const token = 'token-crashed';
    const crashedAt = new Date(Date.now() - 60_000);
    assert.equal(
      await app.dependencies.lease.claim({
        key: workRunKey({ tenantId: null, ownerId: principal.ownerId, conversationId }),
        owner: principal.ownerId,
        token,
        now: crashedAt,
        expiresAt: new Date(crashedAt.getTime() + 1_000),
      }),
      true,
    );
    assert.equal(
      (
        await app.dependencies.tasks.create(
          taskRecord({
            taskId,
            conversationId,
            ownerId: principal.ownerId,
            state: 'running',
            runToken: token,
            leaseExpiresAt: new Date(crashedAt.getTime() + 1_000).toISOString(),
          }),
        )
      ).ok,
      true,
    );

    // start() runs the startup ownership verification, not a test-only path.
    await app.start();
    const recovered = await app.service.task(principal, taskId);
    assert.equal(recovered.ok && recovered.value.state, 'interrupted');
    const generation = recovered.ok ? recovered.value.generation : 0;
    assert.ok(generation > 0, 'the recovered task must keep a resumable generation');

    const resumed = await app.service.resumeTask(principal, taskId, generation);
    assert.equal(resumed.ok, true);
    await waitFor(async () => {
      const status = await app.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    const notifications = await app.dependencies.notifications.list(principal.ownerId);
    assert.ok(notifications.notifications.some((entry) => entry.taskId === taskId));
  } finally {
    await app.stop().catch(() => undefined);
    await dropPrefix(namePrefix);
    workspace.cleanup();
  }
});

