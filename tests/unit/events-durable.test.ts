import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus } from '../../src/events/bus.js';
import { createMemoryEventLog } from '../../src/events/log.js';

// One id space for the file: a simulated restart must keep the same identity
// domain, or a fresh prefix would make an old event look new again.
let counter = 0;
function nextId(): string {
  counter += 1;
  return `id-${counter}`;
}

function busOver(log: ReturnType<typeof createMemoryEventLog>, bufferSize = 100) {
  return createEventBus({
    bufferSize,
    eventId: nextId,
    iso: () => new Date(1_700_000_000_000).toISOString(),
    log,
  });
}

test('a restarted process replays the durable stream and continues its sequence', async () => {
  const log = createMemoryEventLog();
  const first = busOver(log);
  first.publish({ taskId: 'task-1', agent: 'coderax', generation: 1, type: 'task.queued' });
  first.publish({ taskId: 'task-1', agent: 'coderax', generation: 1, type: 'task.started' });
  first.publish({
    taskId: 'task-1',
    agent: 'coderax',
    generation: 1,
    type: 'text.delta',
    payload: { text: 'hello' },
  });
  await first.flush('task-1');

  // A new bus over the same log is what a restart looks like: no in-memory
  // state, the same durable events.
  const second = busOver(log);
  const replay = await second.read('task-1', 0);
  assert.deepEqual(
    replay.events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(replay.truncated, false);

  const resumed = second.publish({
    taskId: 'task-1',
    agent: 'coderax',
    generation: 2,
    type: 'task.completed',
    payload: { summary: 'done' },
  });
  assert.equal(resumed.seq, 4, 'the new generation continues after the durable watermark');
  await second.flush('task-1');
  assert.equal(await log.lastSeq('task-1'), 4);
});

test('a failed durable append restores the batch and a retry preserves terminal events', async () => {
  const log = createMemoryEventLog();
  let fail = true;
  const flaky = {
    ...log,
    append: async (events: Parameters<typeof log.append>[0]) => {
      if (fail) {
        fail = false;
        throw new Error('database unavailable');
      }
      return log.append(events);
    },
  };
  const bus = busOver(flaky);
  bus.publish({ taskId: 'task-retry', agent: 'coderax', generation: 1, type: 'task.queued' });
  bus.publish({
    taskId: 'task-retry',
    agent: 'coderax',
    generation: 1,
    type: 'task.completed',
    payload: { summary: 'done' },
  });

  await assert.rejects(bus.flush('task-retry'));
  await bus.flush('task-retry');
  const durable = await log.read('task-retry', 0, 100);
  assert.deepEqual(
    durable.map((event) => event.type),
    ['task.queued', 'task.completed'],
    'the retry writes the retained batch in order',
  );
});

test('an empty flush does not pin the stream and drop later events', async () => {
  const log = createMemoryEventLog();
  const bus = busOver(log);
  await bus.flush('task-empty');
  bus.publish({
    taskId: 'task-empty',
    agent: 'coderax',
    generation: 1,
    type: 'task.completed',
    payload: { summary: 'done' },
  });
  await bus.flush('task-empty');
  const durable = await log.read('task-empty', 0, 100);
  assert.deepEqual(
    durable.map((event) => event.type),
    ['task.completed'],
    'the event published after an empty flush is written',
  );
});

test('a stale-generation fence does not silence a newer generation in the same process', async () => {
  const log = createMemoryEventLog();
  let reject = true;
  const staleOnce = {
    ...log,
    append: async (events: Parameters<typeof log.append>[0]) => {
      if (reject) {
        reject = false;
        return events.map(() => 'stale_generation' as const);
      }
      return log.append(events);
    },
  };
  const bus = busOver(staleOnce);
  bus.publish({ taskId: 'task-fence', agent: 'coderax', generation: 1, type: 'task.queued' });
  await bus.flush('task-fence');

  bus.publish({
    taskId: 'task-fence',
    agent: 'coderax',
    generation: 2,
    type: 'task.completed',
    payload: { summary: 'resumed' },
  });
  await bus.flush('task-fence');

  const durable = await log.read('task-fence', 0, 100);
  assert.deepEqual(
    durable.map((event) => [event.generation, event.type]),
    [[2, 'task.completed']],
    'the rejected generation is dropped and the newer one is written',
  );
});

test('a duplicate event is stored once and an out-of-order one is refused', async () => {
  const log = createMemoryEventLog();
  const bus = busOver(log);
  const first = bus.publish({
    taskId: 'task-2',
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  });
  await bus.flush('task-2');

  assert.equal((await log.append([first]))[0], 'duplicate');
  assert.deepEqual(bus.accept(first), { accepted: false, reason: 'duplicate' });
  assert.deepEqual(bus.accept({ ...first, eventId: 'fresh', seq: 1 }), {
    accepted: false,
    reason: 'out_of_order',
  });
  assert.equal((await log.read('task-2', 0, 10)).length, 1);
});

test('a stale generation cannot append to a stream a newer generation owns', async () => {
  const log = createMemoryEventLog();
  const bus = busOver(log);
  const current = bus.publish({
    taskId: 'task-3',
    agent: 'coderax',
    generation: 2,
    type: 'task.queued',
  });
  await bus.flush('task-3');

  const stale = { ...current, eventId: 'stale', seq: 9, generation: 1 };
  assert.equal((await log.append([stale]))[0], 'stale_generation');
  assert.equal((await log.read('task-3', 0, 10)).length, 1);

  // The bus seals itself when the log rejects its generation, so a superseded
  // run cannot keep publishing even if it has not noticed yet.
  const staleBus = busOver(log);
  staleBus.publish({ taskId: 'task-3', agent: 'coderax', generation: 1, type: 'task.queued' });
  await staleBus.flush('task-3');
  staleBus.publish({ taskId: 'task-3', agent: 'coderax', generation: 1, type: 'text.delta', payload: { text: 'late' } });
  await staleBus.flush('task-3');
  const events = await log.read('task-3', 0, 50);
  assert.equal(events.length, 1);
});

test('retention keeps the newest window and reports truncation', async () => {
  const log = createMemoryEventLog();
  const bus = busOver(log, 3);
  for (let index = 0; index < 6; index += 1) {
    bus.publish({
      taskId: 'task-4',
      agent: 'coderax',
      generation: 1,
      type: 'text.delta',
      payload: { text: `t${index}` },
    });
  }
  await bus.flush('task-4');
  await log.prune('task-4', 2);
  const kept = await log.read('task-4', 0, 100);
  assert.deepEqual(
    kept.map((event) => event.seq),
    [5, 6],
  );
  const replay = await bus.read('task-4', 0);
  assert.equal(replay.truncated, true);
});

test('backpressure drops intermediate deltas but never the terminal event', async () => {
  const log = createMemoryEventLog();
  const bus = createEventBus({
    bufferSize: 1_000,
    eventId: nextId,
    iso: () => new Date(1_700_000_000_000).toISOString(),
    log,
    maxPending: 16,
  });
  for (let index = 0; index < 200; index += 1) {
    bus.publish({
      taskId: 'task-5',
      agent: 'coderax',
      generation: 1,
      type: 'text.delta',
      payload: { text: 'x' },
    });
  }
  bus.publish({
    taskId: 'task-5',
    agent: 'coderax',
    generation: 1,
    type: 'task.completed',
    payload: { summary: 'done' },
  });
  assert.ok(bus.dropped() > 0, 'the queue is bounded rather than unbounded');
  await bus.flush('task-5');
  const stored = await log.read('task-5', 0, 1_000);
  assert.equal(stored.at(-1)?.type, 'task.completed');
});

