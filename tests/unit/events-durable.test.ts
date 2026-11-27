import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus, type EventDraft } from '../../src/events/bus.js';
import { createMemoryEventStore } from '../../src/events/store.js';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import { taskRecord } from '../helpers.js';

const at = '2026-11-26T12:00:00.000Z';
const draft: EventDraft = {
  taskId: 'task_test', runToken: 'first', agent: 'coderax', generation: 1, type: 'task.queued',
};

async function fixture(maxPerTask = 100) {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ runToken: draft.runToken }));
  const store = createMemoryEventStore({ maxPerTask });
  let ids = 0;
  const bus = (eventStore = store) => createEventBus({
    store: eventStore, seq: tasks, pollMs: 10, iso: () => at,
    eventId: () => `event_${++ids}`,
    generation: async (taskId) => (await tasks.get(taskId))?.generation ?? null,
  });
  return { tasks, store, bus };
}

test('a fresh bus resumes from the fenced sequence across generations', async () => {
  const { tasks, bus } = await fixture();
  const first = bus();
  await Promise.all([first.publish(draft), first.publish({ ...draft, type: 'task.started' })]);
  const next = bus();
  assert.deepEqual((await next.replay(draft.taskId, 0)).events.map(event => event.seq), [1, 2]);
  assert.ok((await tasks.updateFenced({ taskId: draft.taskId, token: 'first', patch: { state: 'interrupted' } })).applied);
  const reissued = await tasks.reissue({
    taskId: draft.taskId, token: 'second', now: at, leaseExpiresAt: at, from: ['interrupted'],
  });
  assert.equal(reissued.applied, true);
  assert.equal(await first.publish(draft), null);
  assert.equal((await next.publish({ ...draft, runToken: 'second', generation: 2 }))?.seq, 3);
});

test('an adopted event is redacted, deduplicated and raises the sequence head', async () => {
  const { bus } = await fixture();
  const events = bus();
  const first = await events.publish(draft);
  assert.ok(first);
  assert.deepEqual(await events.accept(first), { accepted: false, reason: 'duplicate' });
  assert.deepEqual(await events.accept({ ...first, eventId: 'other' }), { accepted: false, reason: 'out_of_order' });
  assert.deepEqual(await events.accept({ ...first, eventId: 'stale', seq: 5, generation: 0 }),
    { accepted: false, reason: 'out_of_order' });
  assert.equal((await events.accept({ ...first, eventId: 'new', seq: 5 })).accepted, true);
  assert.equal((await events.publish(draft))?.seq, 6);
});

test('retention truncates replay and keeps the latest terminal event', async () => {
  const { bus } = await fixture(2);
  const events = bus();
  await Promise.all(Array.from({ length: 10 }, () => events.publish(draft)));
  await events.publish({ ...draft, type: 'task.completed', payload: { summary: 'done' } });
  const replay = await events.replay(draft.taskId, 0);
  assert.equal(replay.truncated, true);
  assert.deepEqual(replay.events.map(event => event.seq), [10, 11]);
  assert.equal(replay.events.at(-1)?.type, 'task.completed');
});

test('a lost write acknowledgement retries the same event before writing the next sequence', async () => {
  const { bus, store } = await fixture();
  let lostAck = false;
  const events = bus({ ...store, append: async (event) => {
    const result = await store.append(event);
    if (!lostAck) { lostAck = true; throw new Error('lost acknowledgement'); }
    return result;
  } });
  const [one, two] = await Promise.all([events.publish(draft), events.publish(draft)]);
  assert.deepEqual([one?.seq, two?.seq], [1, 2]);
  assert.deepEqual((await events.replay(draft.taskId, 0)).events.map(event => event.seq), [1, 2]);
});
