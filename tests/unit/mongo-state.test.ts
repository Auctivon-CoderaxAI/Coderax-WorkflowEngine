import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import type { ExecutionEvent } from '@coderax/contracts';
import {
  createMongoEventLog,
  createMongoIdempotencyStore,
  ensureEventIndexes,
  ensureIdempotencyIndexes,
} from '../../src/persistence/mongo-state.js';
import { createClock } from '../../src/support/clock.js';
import { createFakeCollection } from '../fakes/mongo.js';

const NOW = '2026-11-26T00:00:00.000Z';

function event(seq: number, eventId = `evt_${seq}`, taskId = 'task_1'): ExecutionEvent {
  return {
    v: EVENT_SCHEMA_VERSION,
    eventId,
    taskId,
    seq,
    at: NOW,
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  } as ExecutionEvent;
}

async function idempotency() {
  const collection = createFakeCollection();
  await ensureIdempotencyIndexes(collection);
  return {
    collection,
    store: createMongoIdempotencyStore({ collection, clock: createClock(), ttlMs: 60_000 }),
  };
}

test('the idempotency key index is unique and completed rows expire', async () => {
  const { collection } = await idempotency();
  assert.deepEqual(collection.indexes[0]?.keys, { ownerId: 1, key: 1 });
  assert.equal(collection.indexes[0]?.options?.unique, true);
  assert.deepEqual(collection.indexes[1]?.keys, { expiresAt: 1 });
  assert.equal(collection.indexes[1]?.options?.expireAfterSeconds, 0);
});

test('a reservation blocks a concurrent retry and replays a completed one', async () => {
  const { store } = await idempotency();
  const request = { ownerId: 'owner-test', key: 'key-0001', taskId: 'task_a' };
  assert.deepEqual(await store.reserve(request), { ok: true });
  // In flight: no task id, because the first submission is not confirmed yet.
  assert.deepEqual(await store.reserve({ ...request, taskId: 'task_b' }), { ok: false });

  await store.complete(request);
  assert.deepEqual(await store.reserve({ ...request, taskId: 'task_b' }), {
    ok: false,
    completedTaskId: 'task_a',
  });

  // Only the holder may release the key.
  await store.release({ ...request, taskId: 'task_b' });
  assert.deepEqual(await store.reserve({ ...request, taskId: 'task_b' }), {
    ok: false,
    completedTaskId: 'task_a',
  });
  await store.release(request);
  assert.deepEqual(await store.reserve({ ...request, taskId: 'task_b' }), { ok: true });
});

test('an expired reservation is taken over instead of replaying its task', async () => {
  const { collection, store } = await idempotency();
  collection.documents.push({
    ownerId: 'owner-test',
    key: 'key-0002',
    taskId: 'task_old',
    expiresAt: new Date('2026-11-25T00:00:00.000Z'),
  });
  assert.deepEqual(
    await store.reserve({ ownerId: 'owner-test', key: 'key-0002', taskId: 'task_new' }),
    { ok: true },
  );
  assert.equal(collection.documents[0]?.taskId, 'task_new');
  assert.equal(collection.documents[0]?.expiresAt, null);
});

test('a malformed stored reservation is reported, never treated as absent', async () => {
  const { collection, store } = await idempotency();
  collection.documents.push({ ownerId: 'owner-test', key: 'key-0003', taskId: 7, expiresAt: null });
  await assert.rejects(
    () => store.reserve({ ownerId: 'owner-test', key: 'key-0003', taskId: 'task_b' }),
    /malformed/,
  );
});

async function eventLog() {
  const collection = createFakeCollection();
  await ensureEventIndexes(collection);
  return { collection, log: createMongoEventLog(collection) };
}

test('the event log is unique on identity and sequence', async () => {
  const { collection } = await eventLog();
  assert.deepEqual(collection.indexes[0]?.keys, { taskId: 1, eventId: 1 });
  assert.equal(collection.indexes[0]?.options?.unique, true);
  assert.deepEqual(collection.indexes[1]?.keys, { taskId: 1, seq: 1 });
  assert.equal(collection.indexes[1]?.options?.unique, true);
});

test('an event is stored once and a second event on its sequence conflicts', async () => {
  const { log } = await eventLog();
  assert.deepEqual(await log.append(event(1)), { stored: true });
  assert.deepEqual(await log.append(event(1)), { stored: false, reason: 'duplicate' });
  assert.deepEqual(await log.append(event(1, 'evt_other')), {
    stored: false,
    reason: 'conflict',
  });
});

test('history reads after a cursor and reports the last stored sequence', async () => {
  const { log } = await eventLog();
  for (const seq of [1, 2, 3]) await log.append(event(seq));
  assert.equal(await log.lastSeq('task_1'), 3);
  assert.equal(await log.lastSeq('task_unknown'), 0);
  assert.deepEqual(
    (await log.read('task_1', 1)).map((stored) => stored.seq),
    [2, 3],
  );
  assert.deepEqual(await log.read('task_1', 3), []);
  // Sequence ordering is per task, so another task starts at 1.
  await log.append(event(1, 'evt_other_task', 'task_2'));
  assert.deepEqual(
    (await log.read('task_2', 0)).map((stored) => stored.taskId),
    ['task_2'],
  );
});
