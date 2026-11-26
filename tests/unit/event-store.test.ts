import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionEvent } from '@coderax/contracts';
import {
  createMemoryEventStore,
  createMongoEventStore,
  ensureEventIndexes,
  isTruncated,
} from '../../src/events/store.js';
import type { EventStore } from '../../src/events/store.js';
import { createFakeCollection } from '../fakes/mongo.js';

const NOW = '2026-11-26T00:00:00.000Z';

function event(seq: number, overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: 't1',
    seq,
    at: NOW,
    agent: 'coderax',
    generation: 1,
    type: 'text.delta',
    payload: { text: `t${seq}` },
    ...overrides,
  } as ExecutionEvent;
}

type StoreCase = { name: string; make: () => Promise<EventStore> };

const cases: StoreCase[] = [
  {
    name: 'memory',
    make: async () => createMemoryEventStore({ maxPerTask: 100 }),
  },
  {
    name: 'mongo',
    make: async () => {
      const collection = createFakeCollection();
      await ensureEventIndexes(collection, { retentionSeconds: 60 });
      return createMongoEventStore({ collection, pageSize: 100, now: () => new Date(NOW) });
    },
  },
];

for (const storeCase of cases) {
  test(`${storeCase.name}: events are stored once and replayed in sequence order`, async () => {
    const store = await storeCase.make();
    assert.equal(await store.append(event(1)), 'stored');
    assert.equal(await store.append(event(2)), 'stored');
    assert.equal(await store.append(event(1)), 'duplicate');
    assert.equal(await store.append(event(3, { eventId: 'evt_1' })), 'duplicate');

    const replay = await store.replay('t1', 0);
    assert.deepEqual(replay.events.map((entry) => entry.seq), [1, 2]);
    assert.equal(replay.truncated, false);
    assert.equal(replay.lastSeq, 2);
    // The stored document carries bookkeeping the contract does not describe.
    for (const entry of replay.events) ExecutionEvent.parse(entry);

    assert.equal(await store.has('evt_1'), true);
    assert.equal(await store.has('missing'), false);
  });

  test(`${storeCase.name}: numeric order beats lexical order`, async () => {
    const store = await storeCase.make();
    for (const seq of [10, 1, 9, 2]) {
      assert.equal(await store.append(event(seq)), 'stored');
    }
    const replay = await store.replay('t1', 0);
    assert.deepEqual(replay.events.map((entry) => entry.seq), [1, 2, 9, 10]);
    assert.equal(replay.lastSeq, 10);
    assert.deepEqual((await store.replay('t1', 2)).events.map((entry) => entry.seq), [9, 10]);
  });

  test(`${storeCase.name}: a cursor in a gap reports truncation and the head`, async () => {
    const store = await storeCase.make();
    // Retention removed the first three events; nothing about 1..3 survives.
    for (const seq of [4, 5]) await store.append(event(seq));

    const replay = await store.replay('t1', 0);
    assert.deepEqual(replay.events.map((entry) => entry.seq), [4, 5]);
    assert.equal(replay.truncated, true);
    assert.equal(replay.lastSeq, 5);

    const caughtUp = await store.replay('t1', 5);
    assert.deepEqual(caughtUp.events, []);
    assert.equal(caughtUp.truncated, false);

    const ahead = await store.replay('t1', 6);
    assert.equal(ahead.truncated, true);
    assert.equal(ahead.lastSeq, 5);
  });

  test(`${storeCase.name}: one task's log is invisible to another`, async () => {
    const store = await storeCase.make();
    await store.append(event(1));
    await store.append(event(1, { taskId: 't2', eventId: 'evt_t2' }));
    const other = await store.replay('t2', 0);
    assert.deepEqual(other.events.map((entry) => entry.eventId), ['evt_t2']);
    assert.equal(other.lastSeq, 1);
  });
}

test('the mongo store pages a read without calling the gap a truncation', async () => {
  const collection = createFakeCollection();
  await ensureEventIndexes(collection, { retentionSeconds: 60 });
  const store = createMongoEventStore({ collection, pageSize: 2, now: () => new Date(NOW) });
  for (const seq of [1, 2, 3, 4, 5]) await store.append(event(seq));

  const first = await store.replay('t1', 0);
  assert.deepEqual(first.events.map((entry) => entry.seq), [1, 2]);
  assert.equal(first.truncated, false);
  assert.equal(first.lastSeq, 5);

  const second = await store.replay('t1', 2);
  assert.deepEqual(second.events.map((entry) => entry.seq), [3, 4]);
  assert.equal(second.truncated, false);
});

test('the event indexes refuse a duplicate sequence and a duplicate id, and expire by age', async () => {
  const collection = createFakeCollection();
  await ensureEventIndexes(collection, { retentionSeconds: 3_600 });

  const names = collection.indexes.map((index) => index.options?.name);
  assert.deepEqual(names, ['event_task_seq', 'event_id', 'event_retention']);
  assert.deepEqual(collection.indexes[0]?.keys, { taskId: 1, seq: 1 });
  assert.equal(collection.indexes[0]?.options?.unique, true);
  assert.deepEqual(collection.indexes[1]?.keys, { eventId: 1 });
  assert.equal(collection.indexes[1]?.options?.unique, true);
  assert.equal(collection.indexes[2]?.options?.expireAfterSeconds, 3_600);

  const store = createMongoEventStore({ collection, pageSize: 10, now: () => new Date(NOW) });
  assert.equal(await store.append(event(1)), 'stored');
  assert.equal(collection.documents[0]?.storedAt instanceof Date, true);
  // The TTL field is bookkeeping, not part of the event the client parses.
  assert.equal('storedAt' in (collection.documents[0] ?? {}), true);
  const replay = await store.replay('t1', 0);
  assert.equal('storedAt' in (replay.events[0] ?? {}), false);
});

test('truncation is decided from the cursor, the page and the head', () => {
  assert.equal(isTruncated({ after: 0, events: [event(1)], lastSeq: 1 }), false);
  assert.equal(isTruncated({ after: 0, events: [event(2)], lastSeq: 2 }), true);
  assert.equal(isTruncated({ after: 1, events: [], lastSeq: 1 }), false);
  assert.equal(isTruncated({ after: 0, events: [], lastSeq: 3 }), true);
  assert.equal(isTruncated({ after: 4, events: [], lastSeq: 3 }), true);
});
