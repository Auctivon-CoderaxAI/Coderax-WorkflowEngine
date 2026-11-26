import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskScheduler } from '../../src/scheduling/scheduler.js';

test('the scheduler bounds concurrency, drains accepted work and refuses new work after stop', async () => {
  const scheduler = createTaskScheduler({ maxConcurrent: 2 });
  const started: string[] = [];
  const finished: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const job = (name: string) => async (): Promise<void> => {
    started.push(name);
    await gate;
    finished.push(name);
  };

  scheduler.enqueue(job('a'));
  scheduler.enqueue(job('b'));
  scheduler.enqueue(job('c'));
  assert.equal(scheduler.active(), 2);
  assert.equal(scheduler.pending(), 1);
  assert.deepEqual(started, ['a', 'b']);

  release();
  await scheduler.idle();
  assert.deepEqual(finished.sort(), ['a', 'b', 'c']);
  assert.equal(scheduler.active(), 0);
  assert.equal(scheduler.pending(), 0);

  scheduler.stop();
  scheduler.enqueue(job('late'));
  await scheduler.idle();
  assert.deepEqual(started.sort(), ['a', 'b', 'c']);
});
