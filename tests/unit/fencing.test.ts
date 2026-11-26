import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import { taskRecord } from '../helpers.js';

test('a task is written only by the generation that owns it', async () => {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ runToken: 'token-a', state: 'running' }));

  const byA = await tasks.updateFenced({
    taskId: 'task_test',
    token: 'token-a',
    patch: { state: 'completed', updatedAt: new Date().toISOString() },
  });
  assert.equal(byA.applied, true);

  const byB = await tasks.updateFenced({
    taskId: 'task_test',
    token: 'token-b',
    patch: { state: 'failed' },
  });
  assert.deepEqual(byB, { applied: false, reason: 'superseded' });
});

test('an expired generation cannot overwrite the state a newer generation owns', async () => {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ state: 'interrupted', runToken: 'token-old', generation: 1 }));

  const reissued = await tasks.reissue({
    taskId: 'task_test',
    token: 'token-new',
    now: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  assert.equal(reissued.applied, true);
  assert.equal(reissued.applied && reissued.task.generation, 2);

  const staleWrite = await tasks.updateFenced({
    taskId: 'task_test',
    token: 'token-old',
    patch: { state: 'completed', result: { summary: 'stale', artifacts: [] } },
  });
  assert.deepEqual(staleWrite, { applied: false, reason: 'superseded' });

  const current = await tasks.get('task_test');
  assert.equal(current?.state, 'queued');
  assert.equal(current?.result, null);
});

test('a terminal task is never rewritten', async () => {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ state: 'running', runToken: 'token-a' }));
  const first = await tasks.updateFenced({
    taskId: 'task_test',
    token: 'token-a',
    patch: { state: 'completed' },
  });
  assert.equal(first.applied, true);

  const second = await tasks.updateFenced({
    taskId: 'task_test',
    token: 'token-a',
    patch: { state: 'failed' },
  });
  assert.deepEqual(second, { applied: false, reason: 'terminal' });
});

test('a claimed task cannot be settled through the unclaimed path', async () => {
  const tasks = createTaskRepository();
  await tasks.create(taskRecord({ state: 'running', runToken: 'token-a' }));
  assert.equal(
    await tasks.abandon({ taskId: 'task_test', patch: { state: 'failed' } }),
    false,
  );
});

test('one active task per conversation is enforced', async () => {
  const tasks = createTaskRepository();
  const first = await tasks.create(taskRecord({ taskId: 'task-1', runToken: 'token-1', state: 'running' }));
  assert.equal(first.ok, true);
  const second = await tasks.create(taskRecord({ taskId: 'task-2', runToken: 'token-2' }));
  assert.deepEqual(second, { ok: false, reason: 'conversation_busy' });

  await tasks.updateFenced({
    taskId: 'task-1',
    token: 'token-1',
    patch: { state: 'completed' },
  });
  const third = await tasks.create(taskRecord({ taskId: 'task-3', runToken: 'token-3' }));
  assert.equal(third.ok, true);
});
