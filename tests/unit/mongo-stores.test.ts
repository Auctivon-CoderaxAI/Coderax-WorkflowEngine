import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationRecord, NotificationRecord, StoredMessage } from '../../src/domain.js';
import { createMongoConversationRepository } from '../../src/persistence/mongo-tables.js';
import { createMongoMemoryStore } from '../../src/persistence/mongo-tables.js';
import { createMongoNotificationStore } from '../../src/persistence/mongo-tables.js';
import { createMongoTaskRepository } from '../../src/persistence/mongo-tables.js';
import {
  ensureConversationIndexes,
  ensureMemoryIndexes,
  ensureNotificationIndexes,
  ensureTaskIndexes,
} from '../../src/persistence/mongo-tables.js';
import { createFakeCollection } from '../fakes/mongo.js';
import { taskRecord } from '../helpers.js';

const NOW = '2026-11-26T00:00:00.000Z';

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationId: 'conv_1',
    ownerId: 'owner-test',
    tenantId: null,
    title: 'Persisted',
    mode: 'cloud',
    isWork: true,
    agent: 'coderax',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    messageId: 'msg_1',
    conversationId: 'conv_1',
    role: 'user',
    text: 'First objective',
    createdAt: NOW,
    ...overrides,
  };
}

function notification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    taskId: 'task_1',
    ownerId: 'owner-test',
    conversationId: 'conv_1',
    agent: 'coderax',
    mode: 'cloud',
    state: 'completed',
    createdAt: NOW,
    read: false,
    ...overrides,
  };
}

test('tasks are inserted once and read back', async () => {
  const collection = createFakeCollection();
  await ensureTaskIndexes(collection);
  const tasks = createMongoTaskRepository(collection);

  const task = taskRecord({ taskId: 'task_1', conversationId: 'conv_1' });
  assert.deepEqual(await tasks.create(task), { ok: true, task });
  assert.deepEqual(await tasks.create(task), { ok: false, reason: 'exists' });

  const loaded = await tasks.get('task_1');
  assert.equal(loaded?.taskId, 'task_1');
  assert.equal(loaded?.state, 'queued');
  assert.equal(loaded?.objective, 'Do the thing');
});

test('a second live task in the same conversation is refused', async () => {
  const tasks = createMongoTaskRepository(createFakeCollection());
  await tasks.create(taskRecord({ taskId: 'task_1', conversationId: 'conv_1', runToken: 'run-1' }));
  assert.deepEqual(
    await tasks.create(taskRecord({ taskId: 'task_2', conversationId: 'conv_1' })),
    { ok: false, reason: 'conversation_busy' },
  );
  // A settled conversation accepts a new task.
  await tasks.updateFenced({
    taskId: 'task_1',
    token: 'run-1',
    patch: { state: 'completed' },
  });
  const settled = await tasks.create(
    taskRecord({ taskId: 'task_3', conversationId: 'conv_1', runToken: 'run-3' }),
  );
  assert.equal(settled.ok, true);
});

test('a fenced write is refused for a superseded generation and after a terminal state', async () => {
  const tasks = createMongoTaskRepository(createFakeCollection());
  await tasks.create(taskRecord({ taskId: 'task_1', runToken: 'run-1' }));

  assert.deepEqual(
    await tasks.updateFenced({ taskId: 'task_1', token: 'run-0', patch: { state: 'running' } }),
    { applied: false, reason: 'superseded' },
  );

  const applied = await tasks.updateFenced({
    taskId: 'task_1',
    token: 'run-1',
    patch: { state: 'completed', updatedAt: NOW },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.applied && applied.task.state, 'completed');

  assert.deepEqual(
    await tasks.updateFenced({ taskId: 'task_1', token: 'run-1', patch: { state: 'failed' } }),
    { applied: false, reason: 'terminal' },
  );
  assert.deepEqual(
    await tasks.updateFenced({ taskId: 'missing', token: 'run-1', patch: { state: 'failed' } }),
    { applied: false, reason: 'not_found' },
  );
});

test('a task is never settled through the unclaimed path', async () => {
  const tasks = createMongoTaskRepository(createFakeCollection());
  await tasks.create(taskRecord({ taskId: 'task_1', runToken: 'run-1' }));
  assert.equal(
    await tasks.abandon({ taskId: 'task_1', patch: { state: 'failed' } }),
    false,
  );

  await tasks.create(
    taskRecord({ taskId: 'task_2', conversationId: 'conv_2', state: 'queued', runToken: null }),
  );
  assert.equal(
    await tasks.abandon({ taskId: 'task_2', patch: { state: 'failed' } }),
    true,
  );
  assert.equal((await tasks.get('task_2'))?.state, 'failed');
});

test('reissue claims a new generation and refuses a live task', async () => {
  const tasks = createMongoTaskRepository(createFakeCollection());
  await tasks.create(taskRecord({ taskId: 'task_1', runToken: 'run-1', state: 'failed',
    checkpoint: { text: 'previous', completedSteps: ['first'] } }));

  const issued = await tasks.reissue({
    taskId: 'task_1',
    token: 'run-2',
    now: NOW,
    leaseExpiresAt: NOW,
  });
  assert.equal(issued.applied, true);
  assert.deepEqual(issued.applied && issued.task.checkpoint, { text: '', completedSteps: ['first'] });
  assert.equal(issued.applied && issued.task.generation, 2);
  assert.equal(issued.applied && issued.task.state, 'queued');
  assert.equal(issued.applied && issued.task.runToken, 'run-2');

  assert.deepEqual(
    await tasks.reissue({ taskId: 'task_1', token: 'run-3', now: NOW, leaseExpiresAt: NOW }),
    { applied: false, reason: 'superseded' },
  );
});

test('tasks are listed by conversation, owner and settlement', async () => {
  const tasks = createMongoTaskRepository(createFakeCollection());
  await tasks.create(taskRecord({ taskId: 'task_1', conversationId: 'conv_1', runToken: 'run-1' }));
  await tasks.create(taskRecord({ taskId: 'task_2', conversationId: 'conv_2', runToken: 'run-2' }));
  await tasks.updateFenced({
    taskId: 'task_2',
    token: 'run-2',
    patch: { state: 'completed' },
  });

  assert.deepEqual(
    (await tasks.listByConversation('conv_1')).map((task) => task.taskId),
    ['task_1'],
  );
  assert.deepEqual(
    (await tasks.listUnsettled()).map((task) => task.taskId),
    ['task_1'],
  );
  assert.deepEqual(
    (await tasks.listByOwner('owner-test')).map((task) => task.taskId).sort(),
    ['task_1', 'task_2'],
  );
});

test('conversations are created once, listed and never shared across owners', async () => {
  const input = { conversations: createFakeCollection(), messages: createFakeCollection() };
  await ensureConversationIndexes(input);
  const conversations = createMongoConversationRepository(input);

  const first = await conversations.ensure(conversation());
  assert.equal(first.conversationId, 'conv_1');
  const again = await conversations.ensure(conversation({ title: 'Different title' }));
  assert.equal(again.title, 'Persisted');

  await assert.rejects(
    () => conversations.ensure(conversation({ ownerId: 'someone-else' })),
    /identity collision/,
  );

  assert.equal(await conversations.get('owner-test', 'conv_1').then(Boolean), true);
  assert.equal(await conversations.get('someone-else', 'conv_1').then(Boolean), false);
});

test('messages are appended once, ordered, and reflected in the conversation', async () => {
  const input = { conversations: createFakeCollection(), messages: createFakeCollection() };
  await ensureConversationIndexes(input);
  const conversations = createMongoConversationRepository(input);
  await conversations.ensure(conversation());

  assert.equal(
    await conversations.appendMessage(message({ messageId: 'msg_unknown', conversationId: 'nope' })),
    false,
  );
  assert.equal(await conversations.appendMessage(message()), true);
  assert.equal(await conversations.appendMessage(message()), false);
  assert.equal(
    await conversations.appendMessage(
      message({ messageId: 'msg_2', role: 'assistant', text: 'Done.', createdAt: '2026-11-26T00:00:01.000Z' }),
    ),
    true,
  );

  assert.deepEqual(
    (await conversations.messages('conv_1')).map((entry) => entry.messageId),
    ['msg_1', 'msg_2'],
  );
  const record = await conversations.get('owner-test', 'conv_1');
  assert.ok(record);
  if (record) {
    assert.equal(record.updatedAt, '2026-11-26T00:00:01.000Z');
    const contract = await conversations.toContract(record);
    assert.deepEqual(contract.messages.map((entry) => entry.role), ['user', 'assistant']);
    assert.equal(contract.mode, 'cloud');
  }

  await conversations.updateAgent('conv_1', 'opencode');
  assert.equal((await conversations.get('owner-test', 'conv_1'))?.agent, 'opencode');
  assert.deepEqual(
    (await conversations.list('owner-test')).conversations.map((entry) => entry.conversationId),
    ['conv_1'],
  );

  await conversations.removeMessage('wrong_conversation', 'msg_1');
  assert.equal((await conversations.messages('conv_1')).length, 2);
  await conversations.removeMessage('conv_1', 'msg_1');
  await conversations.removeMessage('conv_1', 'msg_1');
  assert.deepEqual((await conversations.messages('conv_1')).map((entry) => entry.messageId), ['msg_2']);
});

test('memory is partitioned by mode and replaced on write', async () => {
  const collection = createFakeCollection();
  await ensureMemoryIndexes(collection);
  let tick = 0;
  const memory = createMongoMemoryStore({
    collection,
    clock: {
      now: () => new Date(NOW),
      iso: () => `2026-11-26T00:00:0${tick}.000Z`,
    } as never,
    maxValueLength: 10,
  });

  await memory.put({ ownerId: 'owner-test', tenantId: null, mode: 'private', key: 'note', value: 'a' });
  tick = 1;
  await memory.put({ ownerId: 'owner-test', tenantId: null, mode: 'private', key: 'note', value: 'b' });
  await memory.put({ ownerId: 'owner-test', tenantId: null, mode: 'cloud', key: 'note', value: 'c' });

  const privateEntries = await memory.list({ ownerId: 'owner-test', mode: 'private' });
  assert.deepEqual(privateEntries.entries.map((entry) => entry.value), ['b']);
  assert.equal(collection.documents.length, 2);
  assert.equal(
    (await memory.get({ ownerId: 'owner-test', mode: 'cloud', key: 'note' }))?.value,
    'c',
  );
  assert.equal(await memory.get({ ownerId: 'other', mode: 'private', key: 'note' }), null);

  await assert.rejects(
    () => memory.put({ ownerId: 'owner-test', tenantId: null, mode: 'private', key: 'big', value: 'x'.repeat(11) }),
    /bound/,
  );
});

test('notifications are written once per task and marked read per owner', async () => {
  const collection = createFakeCollection();
  await ensureNotificationIndexes(collection);
  const notifications = createMongoNotificationStore(collection);

  await notifications.record(notification());
  await notifications.record(notification({ summary: 'Finished.' }));

  const listed = await notifications.list('owner-test');
  assert.equal(listed.notifications.length, 1);
  assert.equal(listed.notifications[0]?.summary, 'Finished.');
  assert.equal(listed.unread, 1);

  // Another owner cannot mark this notification read.
  await notifications.markRead('someone-else', 'task_1');
  assert.equal((await notifications.list('owner-test')).unread, 1);

  await notifications.markRead('owner-test', 'task_1');
  assert.equal((await notifications.list('owner-test')).unread, 0);
});
