import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionEvent } from '@coderax/contracts';
import { createEventBus } from '../../src/events/bus.js';
import { createMemoryEventStore } from '../../src/events/store.js';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import { taskRecord, waitFor } from '../helpers.js';

let counter = 0;

/**
 * The bus no longer owns a buffer: the task row allocates the sequence and a
 * store persists it. These tests use the memory driver because the contract is
 * the same one the Mongo store implements; the store itself is tested separately.
 */
async function bus(maxPerTask = 100) {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ taskId: 't1', runToken: 'run-1' }));
  const store = createMemoryEventStore({ maxPerTask });
  const events = createEventBus({
    store,
    seq: tasks,
    pollMs: 10,
    eventId: () => `evt-${++counter}`,
    iso: () => new Date().toISOString(),
  });
  return { events, tasks, store };
}

const TOKEN = 'run-1';
const draft = { taskId: 't1', runToken: TOKEN, agent: 'coderax' as const, generation: 1 };

test('sequence numbers come from the fenced task row and increase by one', async () => {
  const { events, tasks } = await bus();
  const first = await events.publish({ ...draft, type: 'task.queued' });
  const second = await events.publish({ ...draft, type: 'task.started' });
  assert.equal(first?.seq, 1);
  assert.equal(second?.seq, 2);
  assert.equal(await events.lastSeq('t1'), 2);
  // The durable head and the log agree, which is what the next append relies on.
  assert.equal((await tasks.get('t1'))?.eventSeq, 2);
});

test('a superseded generation publishes nothing at all', async () => {
  const { events, tasks } = await bus();
  await events.publish({ ...draft, type: 'task.queued' });
  // A newer generation takes the fence; the old token is now a stranger.
  await tasks.updateFenced({ taskId: 't1', token: TOKEN, patch: { state: 'failed' } });
  const issued = await tasks.reissue({
    taskId: 't1',
    token: 'run-2',
    now: new Date().toISOString(),
    leaseExpiresAt: new Date().toISOString(),
  });
  assert.equal(issued.applied, true);

  assert.equal(await events.publish({ ...draft, type: 'task.completed', payload: {} }), null);
  const replay = await events.replay('t1', 0);
  assert.deepEqual(replay.events.map((event) => event.type), ['task.queued']);
  // The new owner keeps numbering from where the log is, not from where the
  // stale writer thought it was.
  const next = await events.publish({ ...draft, runToken: 'run-2', generation: 2, type: 'task.queued', payload: {} });
  assert.equal(next?.seq, 2);
});

test('a settled task still lets its owning generation append the terminal event', async () => {
  const { events, tasks } = await bus();
  await events.publish({ ...draft, type: 'task.queued' });
  await tasks.updateFenced({ taskId: 't1', token: TOKEN, patch: { state: 'completed' } });
  // `updateFenced` keeps the run token on a terminal row precisely so this works.
  const terminal = await events.publish({ ...draft, type: 'task.completed', payload: {} });
  assert.equal(terminal?.seq, 2);
});

test('a replayed event is accepted once, then reported as a duplicate', async () => {
  const { events, tasks } = await bus();
  const published = await events.publish({ ...draft, type: 'task.queued' });
  assert.ok(published);

  assert.deepEqual(await events.accept({ ...published }), { accepted: false, reason: 'duplicate' });
  // A new id at a sequence already consumed is stale and must not be applied.
  assert.deepEqual(
    await events.accept({ ...published, seq: 1, eventId: 'external-1' }),
    { accepted: false, reason: 'out_of_order' },
  );

  const forward: ExecutionEvent = { ...published, seq: 2, eventId: 'external-2' };
  assert.equal((await events.accept(forward)).accepted, true);
  assert.deepEqual(await events.accept(forward), { accepted: false, reason: 'duplicate' });
  // Adoption raised the head, so the allocator continues above the replayed event.
  assert.equal((await tasks.get('t1'))?.eventSeq, 2);
  assert.equal((await events.publish({ ...draft, type: 'task.started' }))?.seq, 3);
});

test('replay honours a cursor and reports truncation past the retained window', async () => {
  const { events } = await bus(2);
  for (let index = 0; index < 5; index += 1) {
    await events.publish({ ...draft, type: 'text.delta', payload: { text: 'x' } });
  }
  const tail = await events.replay('t1', 3);
  assert.deepEqual(tail.events.map((event) => event.seq), [4, 5]);
  assert.equal(tail.truncated, false);
  assert.equal(tail.lastSeq, 5);

  const tooOld = await events.replay('t1', 0);
  assert.equal(tooOld.truncated, true);
  // A cursor ahead of the log is a reset, not a truncation of the middle.
  const ahead = await events.replay('t1', 99);
  assert.deepEqual(ahead.events, []);
  assert.equal(ahead.truncated, true);
});

test('a subscriber sees only events after its cursor and stops on unsubscribe', async () => {
  const { events } = await bus();
  const seen: number[] = [];
  const unsubscribe = events.subscribe('t1', 0, (event) => seen.push(event.seq));
  await events.publish({ ...draft, type: 'task.queued' });
  await events.publish({ ...draft, type: 'task.started' });
  await waitFor(async () => (seen.length >= 2 ? true : null), 2_000);
  unsubscribe();
  await events.publish({ ...draft, type: 'task.completed', payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(seen, [1, 2]);
});

test('a tail on a second replica sees events the first one appended', async () => {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ taskId: 't1', runToken: 'run-1' }));
  const store = createMemoryEventStore({ maxPerTask: 100 });
  const options = { store, seq: tasks, pollMs: 10, eventId: () => `evt-${++counter}`, iso: () => new Date().toISOString() };
  const writer = createEventBus(options);
  const reader = createEventBus(options);

  const seen: string[] = [];
  const unsubscribe = reader.subscribe('t1', 0, (event) => seen.push(event.type));
  await writer.publish({ ...draft, type: 'task.queued' });
  await waitFor(async () => (seen.includes('task.queued') ? true : null), 2_000);
  unsubscribe();

  // The reader's replay is the same log, not a local cache of it.
  const replay = await reader.replay('t1', 0);
  assert.deepEqual(replay.events.map((event) => event.type), ['task.queued']);
  assert.equal(replay.lastSeq, 1);
});
