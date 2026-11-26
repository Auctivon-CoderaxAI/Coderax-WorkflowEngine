import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus } from '../../src/events/bus.js';

let counter = 0;
function bus(bufferSize = 100) {
  return createEventBus({
    bufferSize,
    eventId: () => `evt-${++counter}`,
    iso: () => new Date().toISOString(),
  });
}

test('sequence numbers are assigned by the bus and increase by one', () => {
  const events = bus();
  const first = events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  const second = events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  assert.ok(first && second);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(events.lastSeq('t1'), 2);
});

test('a replayed event is accepted once and then reported as a duplicate', () => {
  const events = bus();
  const published = events.publish({
    taskId: 't1',
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  });
  assert.ok(published);
  // The exact same event delivered twice is a duplicate, not forward progress.
  assert.deepEqual(events.accept({ ...published }), { accepted: false, reason: 'duplicate' });
  // A new id at a sequence already consumed is stale and must not be applied.
  assert.deepEqual(
    events.accept({ ...published, seq: 1, eventId: 'external-1' }),
    { accepted: false, reason: 'out_of_order' },
  );
  const forward = { ...published, seq: 2, eventId: 'external-2' };
  assert.equal(events.accept(forward).accepted, true);
  assert.deepEqual(events.accept(forward), { accepted: false, reason: 'duplicate' });
});

test('an out-of-order event never regresses the cursor', () => {
  const events = bus();
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  const current = events.publish({
    taskId: 't1',
    agent: 'coderax',
    generation: 1,
    type: 'task.started',
  });
  assert.ok(current);
  const stale = { ...current, seq: 1, eventId: 'stale-1' };
  assert.deepEqual(events.accept(stale), { accepted: false, reason: 'out_of_order' });
  assert.equal(events.lastSeq('t1'), 2);
});

test('replay honours a cursor and reports truncation past the retained window', () => {
  const events = bus(2);
  for (let index = 0; index < 5; index += 1) {
    events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'x' } });
  }
  const tail = events.replay('t1', 3);
  assert.deepEqual(tail.events.map((event) => event.seq), [4, 5]);
  assert.equal(tail.truncated, false);

  const tooOld = events.replay('t1', 0);
  assert.equal(tooOld.truncated, true);
});

test('a superseded generation cannot append to the stream', () => {
  const events = bus();
  assert.ok(events.publish({ taskId: 't1', agent: 'coderax', generation: 2, type: 'task.queued' }));
  assert.equal(
    events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'stale' } }),
    null,
  );
  assert.equal(events.lastSeq('t1'), 1);
  assert.deepEqual(events.replay('t1', 0).events.map((event) => event.type), ['task.queued']);
});

test('a subscriber sees only events after its cursor and stops on unsubscribe', () => {
  const events = bus();
  const seen: number[] = [];
  const unsubscribe = events.subscribe('t1', 0, (event) => seen.push(event.seq));
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  unsubscribe();
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.completed', payload: {} });
  assert.deepEqual(seen, [1, 2]);
});
