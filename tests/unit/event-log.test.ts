import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionEvent } from '@coderax/contracts';
import { createEventBus } from '../../src/events/bus.js';
import type { EventLog } from '../../src/events/log.js';
import { createInMemoryEventLog } from '../../src/events/log.js';
import { createMongoEventLog, ensureEventIndexes } from '../../src/persistence/mongo-events.js';
import { createFakeCollection } from '../fakes/mongo.js';

let events = 0;
const ids = (): string => `evt-${++events}`;
const iso = (): string => new Date().toISOString();

function inMemoryBus(log: EventLog, bufferSize = 100) {
  return createEventBus({ bufferSize, eventId: ids, iso, log });
}

function mongoLog(bufferSize = 100) {
  const collection = createFakeCollection();
  const heads = createFakeCollection();
  const log = createMongoEventLog({ events: collection, heads });
  return { collection, heads, log, bus: () => createEventBus({ bufferSize, eventId: ids, iso, log }) };
}

/**
 * A log that can hold a read open. It is how a publish is forced to land in the
 * middle of `open`, which is the window the replay-to-subscribe gap lived in.
 */
function gatedLog(inner: EventLog): {
  log: EventLog;
  release: () => void;
  entered: Promise<void>;
} {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    log: {
      ...inner,
      read: async (input) => {
        // Resolve once the read has actually started, after `open` registered
        // its subscriber, so a publish in the test lands in the real window.
        enter();
        const result = await inner.read(input);
        await gate;
        return result;
      },
    },
    release: () => release(),
    entered,
  };
}

test('a restarted bus continues the durable sequence instead of resetting to one', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const first = inMemoryBus(log);
  await first.hydrate('t1');
  first.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  first.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  await first.flush('t1');

  // The new bus is a new process: it starts with no in-memory window at all.
  const second = inMemoryBus(log);
  await second.hydrate('t1');
  const resumed = second.publish({ taskId: 't1', agent: 'coderax', generation: 2, type: 'task.queued' });
  assert.ok(resumed);
  assert.equal(resumed.seq, 3);
  assert.equal(second.lastSeq('t1'), 3);

  const replayed = await second.read('t1', 0);
  assert.deepEqual(replayed.events.map((event) => event.seq), [1, 2, 3]);
});

test('the same terminal event delivered twice is stored once', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const bus = inMemoryBus(log);
  await bus.hydrate('t1');
  const terminal = bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.completed', payload: {} });
  assert.ok(terminal);
  await bus.flush('t1');

  // A redelivery carries the same identity: it must not create a second ending.
  assert.deepEqual(await log.append({ ...terminal }), { appended: false, reason: 'duplicate' });
  const replay = await bus.read('t1', 0);
  assert.equal(replay.events.filter((event) => event.type === 'task.completed').length, 1);
});

test('a stale generation is refused by the log and by the bus', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const bus = inMemoryBus(log);
  await bus.hydrate('t1');
  assert.ok(bus.publish({ taskId: 't1', agent: 'coderax', generation: 2, type: 'task.queued' }));

  assert.equal(
    bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'stale' } }),
    null,
  );
  const stale: ExecutionEvent = {
    ...(await bus.read('t1', 0)).events[0]!,
    eventId: 'evt-stale',
    generation: 1,
    seq: 2,
    type: 'text.delta',
    payload: { text: 'stale' },
  };
  assert.deepEqual(await log.append(stale), { appended: false, reason: 'stale_generation' });
  assert.deepEqual(
    (await bus.read('t1', 0)).events.map((event) => event.type),
    ['task.queued'],
  );
});

test('opening a stream does not drop an event published during the durable read', async () => {
  const inner = createInMemoryEventLog({ bufferSize: 100 });
  const gate = gatedLog(inner);
  const bus = inMemoryBus(gate.log);
  await bus.hydrate('t1');

  const opening = bus.open('t1', 0);
  // The subscriber is registered and the durable read is in flight: this is the
  // exact window the replay-to-subscribe gap lived in.
  await gate.entered;
  const published = bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  assert.ok(published);
  gate.release();

  const opened = await opening;
  const delivered: number[] = [];
  const unsubscribe = opened.subscribe((event) => delivered.push(event.seq));
  unsubscribe();

  const all = [...opened.replay.events.map((event) => event.seq), ...delivered].sort((a, b) => a - b);
  assert.deepEqual(all, [1]);
});

test('a flush barrier surfaces a storage failure instead of losing it', async () => {
  const inner = createInMemoryEventLog({ bufferSize: 100 });
  const log: EventLog = {
    ...inner,
    append: async () => {
      throw new Error('storage unavailable');
    },
  };
  const bus = inMemoryBus(log);
  await bus.hydrate('t1');
  assert.ok(bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' }));
  await assert.rejects(() => bus.flush('t1'), /storage unavailable/);
});

test('retention never removes the newest event of a task', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const old = new Date(Date.now() - 120_000).toISOString();
  const bus = inMemoryBus(log);
  await bus.hydrate('t1');
  bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued', at: old });
  bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.completed', at: old, payload: {} });
  await bus.flush('t1');

  const removed = await bus.prune({ before: new Date().toISOString(), limit: 10 });
  assert.equal(removed, 1);
  const remaining = await bus.read('t1', 0);
  assert.deepEqual(remaining.events.map((event) => event.type), ['task.completed']);
});

test('a fake-Mongo log enforces the unique indices the durable stream relies on', async () => {
  const probe = mongoLog();
  await ensureEventIndexes({ events: probe.collection, heads: probe.heads });
  const bus = probe.bus();
  await bus.hydrate('t1');
  const first = bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  assert.ok(first);
  await bus.flush('t1');

  // Reusing a sequence number and reusing an event id are both refused.
  await assert.rejects(
    () => probe.collection.insertOne({ ...first, eventId: 'evt-other' }),
    /duplicate key/,
  );
  await assert.rejects(
    () => probe.collection.insertOne({ ...first, seq: 2 }),
    /duplicate key/,
  );
});

test('a restart over a fake MongoDB store resumes the sequence and serves the replay', async () => {
  const store = mongoLog();
  await ensureEventIndexes({ events: store.collection, heads: store.heads });
  const first = store.bus();
  await first.hydrate('t1');
  first.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  first.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  await first.flush('t1');

  const restarted = store.bus();
  await restarted.hydrate('t1');
  const next = restarted.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'x' } });
  assert.ok(next);
  assert.equal(next.seq, 3);
  await restarted.flush('t1');

  const replayed = await restarted.read('t1', 1);
  assert.deepEqual(replayed.events.map((event) => event.seq), [2, 3]);
  assert.equal(replayed.truncated, false);
  // A terminal check reads the end of the stream, not its first page.
  assert.deepEqual((await restarted.tail('t1', 1)).map((event) => event.seq), [3]);
});

test('a fake-Mongo append from a superseded generation is refused and leaves no row', async () => {
  const store = mongoLog();
  await ensureEventIndexes({ events: store.collection, heads: store.heads });
  const bus = store.bus();
  await bus.hydrate('t1');
  bus.publish({ taskId: 't1', agent: 'coderax', generation: 2, type: 'task.queued' });
  await bus.flush('t1');

  const stale: ExecutionEvent = {
    v: 1,
    eventId: 'evt-stale-mongo',
    taskId: 't1',
    seq: 5,
    at: new Date().toISOString(),
    agent: 'coderax',
    generation: 1,
    type: 'task.cancelled',
    payload: {},
  };
  assert.deepEqual(await store.log.append(stale), { appended: false, reason: 'stale_generation' });
  assert.equal(
    store.collection.documents.some((document) => document.eventId === 'evt-stale-mongo'),
    false,
  );
  assert.equal((await store.log.watermark('t1')).generation, 2);
});

test('an in-memory log survives only the process that owns it, and says so', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const bus = inMemoryBus(log);
  await bus.hydrate('t1');
  bus.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  await bus.flush('t1');

  // A fresh process with a fresh memory log has no watermark: this is why the
  // memory driver is never described as durable across a restart.
  const fresh = createInMemoryEventLog({ bufferSize: 100 });
  assert.deepEqual(await fresh.watermark('t1'), { seq: 0, generation: 0 });
  assert.deepEqual((await fresh.read({ taskId: 't1', after: 0, limit: 10 })).events, []);
});

test('a later generation refreshes a watermark another replica advanced', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const replicaA = inMemoryBus(log);
  const replicaB = inMemoryBus(log);

  await replicaA.hydrate('t_gen', 1);
  const first = replicaA.publish({ taskId: 't_gen', agent: 'coderax', generation: 1, type: 'task.queued' });
  assert.equal(first?.seq, 1);
  await replicaA.flush('t_gen');

  // Replica B takes generation 2 and moves the durable sequence forward.
  await replicaB.hydrate('t_gen', 2);
  const second = replicaB.publish({ taskId: 't_gen', agent: 'coderax', generation: 2, type: 'task.queued' });
  assert.equal(second?.seq, 2);
  await replicaB.flush('t_gen');

  // A is assigned generation 3. Its cached watermark is now stale; reusing it
  // would make the store refuse every event while a cached flush still resolved.
  await replicaA.hydrate('t_gen', 3);
  const third = replicaA.publish({ taskId: 't_gen', agent: 'coderax', generation: 3, type: 'task.completed' });
  assert.equal(third?.seq, 3);
  await replicaA.flush('t_gen');

  const stored = await log.read({ taskId: 't_gen', after: 0, limit: 10 });
  assert.deepEqual(stored.events.map((event) => event.seq), [1, 2, 3]);
});

test('a refused append is reported by flush and resynchronizes the sequence', async () => {
  let durableSeq = 9;
  let calls = 0;
  const log: EventLog = {
    append: async () => {
      calls += 1;
      if (calls === 1) {
        // Another replica advanced the stream between hydration and this write.
        durableSeq = 25;
        return { appended: false, reason: 'out_of_order' };
      }
      return { appended: true };
    },
    read: async () => ({ events: [], truncated: false }),
    watermark: async () => ({ seq: durableSeq, generation: 1 }),
    latest: async () => [],
    prune: async () => 0,
    close: async () => undefined,
  };
  const bus = createEventBus({ bufferSize: 10, eventId: ids, iso, log });
  await bus.hydrate('t_refused', 1);
  const refused = bus.publish({ taskId: 't_refused', agent: 'coderax', generation: 1, type: 'task.started' });
  assert.equal(refused?.seq, 10);
  await assert.rejects(() => bus.flush('t_refused'), /not persisted \(out_of_order\)/);

  const next = bus.publish({ taskId: 't_refused', agent: 'coderax', generation: 1, type: 'task.completed' });
  assert.equal(next?.seq, 26);
});

test('a replay longer than one page still reaches the terminal event', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const writer = createEventBus({ bufferSize: 10, eventId: ids, iso, log });
  await writer.hydrate('t_page');
  for (let index = 0; index < 35; index += 1) {
    writer.publish({
      taskId: 't_page',
      agent: 'coderax',
      generation: 1,
      type: index === 34 ? 'task.completed' : 'text.delta',
      payload: index === 34 ? {} : { text: '.' },
    });
  }
  await writer.flush('t_page');

  // A fresh process has no local window, so the whole backlog must come from the
  // log. Reading one page and then tailing from the watermark skipped the middle.
  const reader = createEventBus({ bufferSize: 10, eventId: ids, iso, log });
  const opened = await reader.open('t_page', 0, 10);
  assert.equal(opened.replay.events.length, 35);
  assert.equal(opened.replay.events.at(-1)?.type, 'task.completed');
  assert.deepEqual(opened.replay.events.map((event) => event.seq), Array.from({ length: 35 }, (_, index) => index + 1));
});

test('a reconnect cursor ahead of the local head is not rewound by live events', async () => {
  const log = createInMemoryEventLog({ bufferSize: 100 });
  const writer = createEventBus({ bufferSize: 100, eventId: ids, iso, log });
  await writer.hydrate('t_cursor');
  for (let index = 0; index < 5; index += 1) {
    writer.publish({ taskId: 't_cursor', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: '.' } });
  }
  await writer.flush('t_cursor');

  const reader = createEventBus({ bufferSize: 100, eventId: ids, iso, log });
  const opened = await reader.open('t_cursor', 10, 10);
  assert.deepEqual(opened.replay.events, []);

  const delivered: number[] = [];
  const unsubscribe = opened.subscribe((event) => delivered.push(event.seq));
  // The tail continues at 6, below the requested cursor, so it is not delivered.
  reader.publish({ taskId: 't_cursor', agent: 'coderax', generation: 1, type: 'task.completed' });
  unsubscribe();
  opened.close();
  assert.deepEqual(delivered, []);
});

test('a watermark recovers a row inserted before a crash reached the head', async () => {
  const store = mongoLog();
  await ensureEventIndexes({ events: store.collection, heads: store.heads });
  await store.collection.insertOne({
    v: 1,
    taskId: 't_wm',
    seq: 7,
    eventId: 'evt-wm-7',
    at: new Date().toISOString(),
    agent: 'coderax',
    generation: 1,
    type: 'text.delta',
    payload: { text: '.' },
  });

  // The head was never advanced, but the row is committed: the sequence must
  // continue after it, not reuse 7.
  assert.equal((await store.log.watermark('t_wm')).seq, 7);
  const next = await store.log.append({
    v: 1,
    taskId: 't_wm',
    seq: 8,
    eventId: 'evt-wm-8',
    at: new Date().toISOString(),
    agent: 'coderax',
    generation: 1,
    type: 'task.completed',
    payload: {},
  });
  assert.deepEqual(next, { appended: true });
  assert.deepEqual(await store.log.watermark('t_wm'), { seq: 8, generation: 1 });
});
