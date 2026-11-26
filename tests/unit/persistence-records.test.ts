import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeCollection } from '../fakes/mongo.js';
import { createAuditLog } from '../../src/observability/audit.js';
import { createMongoAuditLog, ensureAuditIndexes } from '../../src/persistence/mongo-audit.js';
import {
  createCheckpointStore,
  createMongoCheckpointStore,
  ensureCheckpointIndexes,
} from '../../src/persistence/checkpoints.js';
import {
  createIdempotencyStore,
  createMongoIdempotencyStore,
  ensureIdempotencyIndexes,
} from '../../src/persistence/idempotency.js';
import { createPermissionStore } from '../../src/permissions/store.js';
import { createPermissionTable } from '../../src/persistence/permissions.js';
import {
  createMongoPermissionTable,
  ensurePermissionIndexes,
} from '../../src/persistence/mongo-records.js';
import { createConversationRepository } from '../../src/persistence/conversations.js';
import { createNotificationStore } from '../../src/persistence/notifications.js';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import { createMemoryStore } from '../../src/memory/store.js';
import { createRetentionService } from '../../src/persistence/retention.js';
import { RetentionConfig } from '../../src/configuration/schema.js';
import type { Clock, IdGenerator } from '../../src/support/clock.js';
import type { CheckpointRecord, NotificationRecord } from '../../src/domain.js';
import { taskRecord } from '../helpers.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function mutableClock(): Clock & { advance: (ms: number) => void; nowMs: () => number } {
  let current = START;
  const clock = {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    nowMs: () => current,
  };
  return clock;
}

let seq = 0;
function ids(): IdGenerator {
  return {
    conversationId: () => `conv_${(seq += 1)}`,
    taskId: () => `task_${(seq += 1)}`,
    messageId: () => `msg_${(seq += 1)}`,
    eventId: () => `evt_${(seq += 1)}`,
    runToken: () => `run_${(seq += 1)}`,
    requestId: () => `req_${(seq += 1)}`,
    receipt: () => `rcpt_${(seq += 1)}`,
    checkpointId: () => `ckpt_${(seq += 1)}`,
    scheduleId: () => `sched_${(seq += 1)}`,
    artifactId: () => `art_${(seq += 1)}`,
  };
}

function accepted(taskId = 'task_accepted') {
  return {
    taskId,
    conversationId: 'conv_accepted',
    state: 'queued' as const,
    generation: 1,
    eventsPath: `/v1/work/${taskId}/events`,
  };
}

test('permission requests persist, decide once, scope approvals and prune', async () => {
  const collection = createFakeCollection();
  await ensurePermissionIndexes(collection);
  const clock = mutableClock();
  const store = createPermissionStore({
    clock,
    ids: ids(),
    table: createMongoPermissionTable(collection),
  });

  const request = await store.request({
    ownerId: 'owner',
    taskId: 'task_1',
    agent: 'coderax',
    scope: 'workspace.read',
    description: 'Read one file',
    resource: '/src/app.ts',
  });
  assert.equal((await store.list('owner', 'task_1')).requests.length, 1);
  assert.equal(await store.isApproved('task_1', 'workspace.read', '/src/app.ts'), false);
  assert.equal(await store.hasPending('task_1'), true);

  const decided = await store.decide({
    ownerId: 'owner',
    taskId: 'task_1',
    requestId: request.requestId,
    decision: 'approved',
  });
  assert.equal(decided.ok, true);
  assert.equal(await store.isApproved('task_1', 'workspace.read', '/src/app.ts'), true);
  assert.equal(await store.isApproved('task_1', 'workspace.read', '/src/other.ts'), false);

  // An unconsumed approval can be revoked; the durable decision is then final.
  const second = await store.decide({
    ownerId: 'owner',
    taskId: 'task_1',
    requestId: request.requestId,
    decision: 'denied',
  });
  assert.equal(second.ok, true);
  assert.equal(await store.isApproved('task_1', 'workspace.read', '/src/app.ts'), false);
  const third = await store.decide({
    ownerId: 'owner',
    taskId: 'task_1',
    requestId: request.requestId,
    decision: 'approved',
  });
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.code, 'conflict');

  assert.equal(await store.deleteByTaskIds(['task_1']), 1);
  assert.equal((await store.list('owner', 'task_1')).requests.length, 0);

  clock.advance(2 * 3_600_000);
  await store.request({
    ownerId: 'owner',
    taskId: 'task_2',
    agent: 'coderax',
    scope: 'workspace.read',
    description: 'Expired',
    resource: '/src/old.ts',
    ttlMs: 1_000,
  });
  clock.advance(2_000);
  assert.equal(await store.prune(clock.iso(), 100), 1);
});

test('audit receipts are append-only, paged, task-scoped and prunable', async () => {
  const collection = createFakeCollection();
  await ensureAuditIndexes(collection);
  const clock = mutableClock();
  const audit = createMongoAuditLog({ collection, clock, ids: ids() });

  clock.advance(1_000);
  await audit.record({
    actor: 'owner',
    action: 'work.accepted',
    taskId: 'task_1',
    conversationId: 'conv_1',
    outcome: 'accepted',
  });
  clock.advance(1_000);
  await audit.record({
    actor: 'owner',
    action: 'work.completed',
    taskId: 'task_1',
    conversationId: 'conv_1',
    outcome: 'completed',
  });
  clock.advance(1_000);
  await audit.record({
    actor: 'owner',
    action: 'other.note',
    taskId: 'task_2',
    outcome: 'accepted',
  });

  const first = await audit.list({ taskId: 'task_1', limit: 1 });
  assert.equal(first.receipts.length, 1);
  assert.equal(first.receipts[0]?.action, 'work.completed');
  assert.ok(first.nextCursor);
  const second = await audit.list({
    taskId: 'task_1',
    limit: 1,
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
  });
  assert.equal(second.receipts[0]?.action, 'work.accepted');

  assert.equal(await audit.deleteByTaskIds(['task_2']), 1);
  clock.advance(3 * 3_600_000);
  assert.equal(await audit.prune(clock.iso(), 100), 2);
});

test('the in-process audit log has the same paging and deletion semantics', async () => {
  const clock = mutableClock();
  const audit = createAuditLog({ clock, ids: ids() });
  clock.advance(1_000);
  await audit.record({
    actor: 'owner',
    action: 'work.accepted',
    taskId: 'task_1',
    outcome: 'accepted',
  });
  clock.advance(1_000);
  await audit.record({
    actor: 'owner',
    action: 'work.failed',
    taskId: 'task_1',
    outcome: 'failed',
  });
  const page = await audit.list({ taskId: 'task_1', limit: 5 });
  assert.deepEqual(page.receipts.map((entry) => entry.action), ['work.failed', 'work.accepted']);
  assert.equal(await audit.deleteByTaskIds(['task_1']), 2);
});

test('checkpoints append once, read back in order and prune', async () => {
  const collection = createFakeCollection();
  await ensureCheckpointIndexes(collection);
  const store = createMongoCheckpointStore(collection);
  const clock = mutableClock();
  const record = (overrides: Partial<CheckpointRecord>): CheckpointRecord => ({
    checkpointId: `ckpt_${Math.random()}`,
    taskId: 'task_1',
    ownerId: 'owner',
    conversationId: 'conv_1',
    generation: 1,
    completedSteps: [],
    text: '',
    kind: 'step',
    createdAt: clock.iso(),
    ...overrides,
  });

  const first = record({ checkpointId: 'ckpt_1', completedSteps: ['a'], text: 'one' });
  await store.append(first);
  await store.append(first);
  clock.advance(1_000);
  await store.append(record({ checkpointId: 'ckpt_2', completedSteps: ['a', 'b'], text: 'two' }));

  assert.deepEqual(
    (await store.list({ taskId: 'task_1' })).checkpoints.map((entry) => entry.checkpointId),
    ['ckpt_1', 'ckpt_2'],
  );
  assert.equal((await store.latest('task_1'))?.text, 'two');
  const page = await store.list({ taskId: 'task_1', limit: 1 });
  assert.equal(page.checkpoints.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(
    (await store.list({
      taskId: 'task_1',
      limit: 1,
      ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    })).checkpoints[0]?.checkpointId,
    'ckpt_2',
  );

  clock.advance(3 * 3_600_000);
  assert.equal(await store.prune(clock.iso(), 100), 2);
  await store.append(record({ checkpointId: 'ckpt_3', taskId: 'task_2' }));
  assert.equal(await store.deleteByTaskIds(['task_2']), 1);
  assert.equal((await createCheckpointStore().list({ taskId: 'missing' })).checkpoints.length, 0);
});

test('an idempotency reservation replays only the same request and expires', async () => {
  for (const store of [
    createIdempotencyStore(),
    (() => {
      const collection = createFakeCollection();
      void ensureIdempotencyIndexes(collection);
      return createMongoIdempotencyStore(collection);
    })(),
  ]) {
    const clock = mutableClock();
    const input = {
      ownerId: 'owner',
      key: 'key-00000001',
      requestHash: 'hash-a',
      now: clock.iso(),
      expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString(),
    };
    assert.equal((await store.reserve(input)).kind, 'reserved');
    assert.equal((await store.reserve(input)).kind, 'pending');
    assert.equal(
      (await store.reserve({ ...input, requestHash: 'hash-b' })).kind,
      'conflict',
    );

    await store.complete({
      ownerId: 'owner',
      key: input.key,
      response: accepted(),
      now: clock.iso(),
      expiresAt: input.expiresAt,
    });
    const replay = await store.reserve(input);
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.kind === 'replay' && replay.response.taskId, 'task_accepted');
    assert.equal(
      (await store.reserve({ ...input, requestHash: 'hash-b' })).kind,
      'conflict',
    );

    clock.advance(2 * 3_600_000);
    assert.equal(await store.prune(clock.iso(), 100), 1);
    assert.equal(await store.get('owner', input.key), null);
  }
});

test('a pending reservation is released so a failed submission can be retried', async () => {
  const store = createMongoIdempotencyStore(createFakeCollection());
  const clock = mutableClock();
  const input = {
    ownerId: 'owner',
    key: 'key-00000002',
    requestHash: 'hash',
    now: clock.iso(),
    expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString(),
  };
  assert.equal((await store.reserve(input)).kind, 'reserved');
  await store.release({ ownerId: 'owner', key: input.key });
  assert.equal((await store.reserve(input)).kind, 'reserved');
});

test('retention removes only rows older than each configured window', async () => {
  const clock = mutableClock();
  const config = RetentionConfig.parse({
    notificationMs: 3_600_000,
    auditMs: 3_600_000,
    permissionMs: 3_600_000,
    checkpointMs: 3_600_000,
    idempotencyMs: 3_600_000,
    sweepIntervalMs: 60_000,
    batchSize: 10,
  });
  const notifications = createNotificationStore();
  const audit = createAuditLog({ clock, ids: ids() });
  const permissions = createPermissionStore({
    clock,
    ids: ids(),
    table: createPermissionTable(),
  });
  const checkpoints = createCheckpointStore();
  const idempotency = createIdempotencyStore();

  clock.advance(1_000);
  const notification: NotificationRecord = {
    taskId: 'task_old',
    ownerId: 'owner',
    conversationId: 'conv_old',
    agent: 'coderax',
    mode: 'cloud',
    state: 'completed',
    createdAt: clock.iso(),
    read: false,
  };
  await notifications.record(notification);
  await audit.record({
    actor: 'owner',
    action: 'work.completed',
    taskId: 'task_old',
    outcome: 'completed',
  });
  const permission = await permissions.request({
    ownerId: 'owner',
    taskId: 'task_old',
    agent: 'coderax',
    scope: 'workspace.read',
    description: 'old',
    resource: '/old',
    ttlMs: 1_000,
  });
  assert.ok(permission.requestId);
  await checkpoints.append({
    checkpointId: 'ckpt_old',
    taskId: 'task_old',
    ownerId: 'owner',
    conversationId: 'conv_old',
    generation: 1,
    completedSteps: [],
    text: '',
    kind: 'settled',
    createdAt: clock.iso(),
  });
  await idempotency.reserve({
    ownerId: 'owner',
    key: 'key-old-0001',
    requestHash: 'hash',
    now: clock.iso(),
    expiresAt: new Date(clock.nowMs() + 60_000).toISOString(),
  });

  clock.advance(2 * 3_600_000);
  const retention = createRetentionService({
    clock,
    config,
    notifications,
    audit,
    permissions,
    checkpoints,
    idempotency,
  });
  const result = await retention.run();
  assert.deepEqual(result.deleted, {
    notifications: 1,
    audit: 1,
    permissions: 1,
    checkpoints: 1,
    idempotency: 1,
  });
  assert.equal(retention.last()?.deleted.notifications, 1);
  assert.equal((await notifications.list({ ownerId: 'owner' })).notifications.length, 0);
  assert.equal((await audit.list({ actor: 'owner' })).receipts.length, 0);
  assert.equal((await checkpoints.list({ taskId: 'task_old' })).checkpoints.length, 0);
});

test('task and conversation lists are bounded, stable and owner-scoped', async () => {
  const tasks = createTaskRepository();
  const clock = mutableClock();
  for (let index = 0; index < 3; index += 1) {
    await tasks.create(
      taskRecord({
        taskId: `task_${index}`,
        conversationId: `conv_task_${index}`,
        ownerId: 'owner',
        createdAt: clock.iso(),
        updatedAt: clock.iso(),
      }),
    );
    clock.advance(1_000);
  }
  const page = await tasks.listPage({ ownerId: 'owner', limit: 2 });
  assert.equal(page.tasks.length, 2);
  assert.equal(page.total, 3);
  assert.ok(page.nextCursor);
  const next = await tasks.listPage({
    ownerId: 'owner',
    limit: 2,
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
  });
  assert.equal(next.tasks.length, 1);
  assert.equal(
    new Set([...page.tasks, ...next.tasks].map((task) => task.taskId)).size,
    3,
  );
  const counts = await tasks.countByState();
  assert.equal(counts.queued, 3);

  const conversations = createConversationRepository();
  for (let index = 0; index < 3; index += 1) {
    await conversations.ensure({
      conversationId: `conv_${index}`,
      ownerId: 'owner',
      tenantId: null,
      mode: index === 2 ? 'private' : 'cloud',
      isWork: true,
      agent: 'coderax',
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    });
    clock.advance(1_000);
  }
  const conversationPage = await conversations.listPage({
    ownerId: 'owner',
    mode: 'cloud',
    limit: 1,
  });
  assert.equal(conversationPage.conversations.length, 1);
  assert.equal(conversationPage.total, 2);
  assert.equal(conversationPage.conversations[0]?.mode, 'cloud');
  const deleted = await conversations.delete('owner', 'conv_0');
  assert.deepEqual(deleted, { deleted: true, messages: 0 });
  assert.equal(await conversations.get('owner', 'conv_0'), null);
});

test('memory is paged by key and deletion is owner- and mode-scoped', async () => {
  const clock = mutableClock();
  const memory = createMemoryStore({ clock, maxValueLength: 100 });
  for (const key of ['a', 'b', 'c']) {
    await memory.put({ ownerId: 'owner', tenantId: null, mode: 'private', key, value: key });
  }
  const page = await memory.list({ ownerId: 'owner', mode: 'private', limit: 2 });
  assert.deepEqual(page.entries.map((entry) => entry.key), ['a', 'b']);
  assert.equal(page.nextCursor, 'b');
  const next = await memory.list({
    ownerId: 'owner',
    mode: 'private',
    limit: 2,
    cursor: 'b',
  });
  assert.deepEqual(next.entries.map((entry) => entry.key), ['c']);

  assert.equal(await memory.delete({ ownerId: 'other', mode: 'private', key: 'a' }), false);
  assert.equal(await memory.delete({ ownerId: 'owner', mode: 'cloud', key: 'a' }), false);
  assert.equal(await memory.delete({ ownerId: 'owner', mode: 'private', key: 'a' }), true);
  assert.equal(await memory.get({ ownerId: 'owner', mode: 'private', key: 'a' }), null);
});

test('notifications page without losing the unread total', async () => {
  const store = createNotificationStore();
  const clock = mutableClock();
  for (let index = 0; index < 3; index += 1) {
    await store.record({
      taskId: `task_${index}`,
      ownerId: 'owner',
      conversationId: 'conv_1',
      agent: 'coderax',
      mode: 'cloud',
      state: 'completed',
      createdAt: clock.iso(),
      read: false,
    });
    clock.advance(1_000);
  }
  const page = await store.list({ ownerId: 'owner', limit: 2 });
  assert.equal(page.notifications.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.unread, 3);
  assert.ok(page.nextCursor);
  await store.markRead('owner', ['task_2']);
  const after = await store.list({ ownerId: 'owner', limit: 2 });
  assert.equal(after.unread, 2);
  assert.equal(after.notifications.find((entry) => entry.taskId === 'task_2')?.read, true);
});
