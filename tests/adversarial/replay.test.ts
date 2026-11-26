import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus } from '../../src/events/bus.js';
import { startTestApp } from '../helpers.js';

function bus(bufferSize = 100) {
  let sequence = 0;
  return createEventBus({
    bufferSize,
    eventId: () => `evt-${++sequence}`,
    iso: () => '2026-11-26T00:00:00.000Z',
  });
}

test('a duplicate event is reported and never applied twice', () => {
  const events = bus();
  const first = events.publish({
    taskId: 't1',
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  });
  assert.deepEqual(events.accept({ ...first }), { accepted: false, reason: 'duplicate' });
  assert.equal(events.lastSeq('t1'), 1);
});

test('an out-of-order event never regresses the cursor or overwrites state', () => {
  const events = bus();
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  assert.deepEqual(
    events.accept({
      ...events.replay('t1', 0).events[0]!,
      seq: 1,
      eventId: 'late',
      type: 'task.failed',
      payload: { code: 'provider_error', retryable: false },
    }),
    { accepted: false, reason: 'out_of_order' },
  );
  assert.equal(events.lastSeq('t1'), 2);
});

test('replay honors a cursor, reports truncation and does not invent events', () => {
  const events = bus(2);
  for (let index = 0; index < 5; index += 1) {
    events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'x' } });
  }
  assert.deepEqual(events.replay('t1', 3).events.map((event) => event.seq), [4, 5]);
  assert.equal(events.replay('t1', 3).truncated, false);
  assert.equal(events.replay('t1', 0).truncated, true);
  assert.deepEqual(events.replay('missing', 0), { events: [], truncated: false });
  assert.deepEqual(events.replay('t1', 5), { events: [], truncated: false });
});

test('a subscriber only receives events beyond its cursor and can disconnect', () => {
  const events = bus();
  const seen: number[] = [];
  const unsubscribe = events.subscribe('t1', 0, (event) => seen.push(event.seq));
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.queued' });
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.started' });
  unsubscribe();
  events.publish({ taskId: 't1', agent: 'coderax', generation: 1, type: 'task.completed', payload: {} });
  assert.deepEqual(seen, [1, 2]);
});

test('the service replays a terminal task and resumes from the last sequence', async () => {
  const started = await startTestApp();
  try {
    const principal = { ownerId: 'owner-test', isOwner: true as const };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Replay this',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();

    const stream = await started.app.service.events(principal, submitted.value.taskId, 0);
    assert.equal(stream.ok, true);
    if (!stream.ok) return;
    assert.ok(stream.value.replay.events.length > 0);
    assert.equal(stream.value.replay.truncated, false);
    const last = stream.value.lastSeq;
    assert.equal(stream.value.replay.events.at(-1)?.seq, last);

    const tail = await started.app.service.events(principal, submitted.value.taskId, last);
    assert.equal(tail.ok, true);
    assert.deepEqual(tail.ok && tail.value.replay.events, []);
  } finally {
    await started.close();
  }
});
