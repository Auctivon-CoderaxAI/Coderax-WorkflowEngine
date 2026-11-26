import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slowGateway, startTestApp, waitFor } from '../helpers.js';

/**
 * Generation fencing.
 *
 * A task's terminal state belongs to the generation that holds its unique token.
 * A stale generation can ask to write, but the repository refuses; a stale
 * client generation cannot resume or retry; and two cancellations settle once.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };
const TERMINAL = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.interrupted']);

test('a stale generation number cannot resume or retry', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'stale generation',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    for (const result of [
      await started.app.service.resumeTask(principal, submitted.value.taskId, 0),
      await started.app.service.retryTask(principal, submitted.value.taskId, 0),
    ]) {
      assert.ok(result.ok);
      assert.equal(result.value.outcome, 'superseded');
      assert.equal(result.value.generation, 1);
    }
  } finally {
    await started.close();
  }
});

test('the pre-crash token cannot write after a resume claims a new generation', async () => {
  const started = await startTestApp({ gateway: slowGateway(60_000) });
  const deps = started.app.dependencies;
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'fenced resume',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'running' ? true : null;
    });
    deps.clock.now = () => new Date(Date.now() + 120_000);
    await deps.scheduler.idle();
    await started.app.service.recoverInterrupted();
    const deadToken = (await deps.tasks.get(submitted.value.taskId))?.runToken;
    assert.ok(deadToken);

    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({ ok: true, summary: 'new generation result' });
    const resumed = await started.app.service.resumeTask(
      principal,
      submitted.value.taskId,
      1,
    );
    assert.ok(resumed.ok);

    const stale = await deps.tasks.updateFenced({
      taskId: submitted.value.taskId,
      token: deadToken,
      patch: { state: 'completed', result: { summary: 'stale write', artifacts: [] } },
    });
    assert.equal(stale.applied, false);
    if (!stale.applied) {
      assert.ok(stale.reason === 'superseded' || stale.reason === 'terminal');
    }

    await deps.scheduler.idle();
    const final = await deps.tasks.get(submitted.value.taskId);
    assert.notEqual(final?.result?.summary, 'stale write');
    assert.equal(final?.generation, 2);
  } finally {
    await started.close();
  }
});

test('two concurrent cancellations produce exactly one terminal event', async () => {
  const started = await startTestApp({ gateway: slowGateway(60_000) });
  const deps = started.app.dependencies;
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'cancel race',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'running' ? true : null;
    });

    const results = await Promise.all([
      started.app.service.cancelTask(principal, submitted.value.taskId, 'first cancel'),
      started.app.service.cancelTask(principal, submitted.value.taskId, 'second cancel'),
    ]);
    assert.ok(results.some((result) => result.ok));
    await deps.scheduler.idle();

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'cancelled');
    const terminals = deps.events
      .replay(submitted.value.taskId, 0)
      .events.filter((event) => TERMINAL.has(event.type));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.type, 'task.cancelled');
  } finally {
    await started.close();
  }
});

test('a completed task is never rewritten by a later cancellation', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'completed before cancel',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();
    const cancelled = await started.app.service.cancelTask(
      principal,
      submitted.value.taskId,
      'too late',
    );
    assert.ok(cancelled.ok);
    assert.equal(cancelled.value.outcome, 'already_terminal');
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'completed');
  } finally {
    await started.close();
  }
});
