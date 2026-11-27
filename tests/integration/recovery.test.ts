import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeGateway, slowGateway, startTestApp, waitFor } from '../helpers.js';

/**
 * Crash recovery.
 *
 * A process that dies cannot write a terminal state. The lease must expire, the
 * task must become `interrupted` (not `running` forever), and a new generation
 * must be able to resume from the checkpoint without the dead run overwriting it.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('a run that stops heartbeating is retired as interrupted and can resume', async () => {
  const started = await startTestApp({ gateway: slowGateway(60_000) });
  const deps = started.app.dependencies;
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'survive a crashed process',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'running' ? true : null;
    });

    // Simulate the owning process disappearing: no more heartbeats, and time has
    // moved past the lease TTL when the next replica looks at the task.
    deps.clock.now = () => new Date(Date.now() + 120_000);
    await deps.scheduler.idle();

    const recovered = await started.app.service.recoverInterrupted();
    assert.equal(recovered.interrupted, 1);
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'interrupted');
    assert.equal(status.value.failure?.code, 'server_unavailable');
    const raw = await deps.tasks.get(submitted.value.taskId);
    assert.equal(raw?.failure?.retryable, true);
    assert.ok(
      (await deps.events.replay(submitted.value.taskId, 0))
        .events.some((event) => event.type === 'task.interrupted'),
    );

    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({ ok: true, summary: 'resumed after the crash' });
    const resumed = await started.app.service.resumeTask(
      principal,
      submitted.value.taskId,
      1,
    );
    assert.ok(resumed.ok);
    assert.equal(resumed.value.outcome, 'accepted');
    assert.equal(resumed.value.generation, 2);
    await deps.scheduler.idle();

    const completed = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(completed.ok);
    assert.equal(completed.value.state, 'completed');
    assert.equal(completed.value.generation, 2);
    assert.equal(completed.value.result?.summary, 'resumed after the crash');
  } finally {
    await started.close();
  }
});

test('recovery is idempotent and never resurrects a terminal task', async () => {
  const started = await startTestApp();
  const deps = started.app.dependencies;
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'terminal task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await deps.scheduler.idle();
    const before = await deps.tasks.get(submitted.value.taskId);
    assert.equal(before?.state, 'completed');

    const recovered = await started.app.service.recoverInterrupted();
    assert.equal(recovered.interrupted, 0);
    const after = await deps.tasks.get(submitted.value.taskId);
    assert.equal(after?.state, 'completed');
    assert.equal(after?.updatedAt, before?.updatedAt);
  } finally {
    await started.close();
  }
});

test('a settlement survives a lease-release failure', async () => {
  const started = await startTestApp({ gateway: fakeGateway() });
  const deps = started.app.dependencies;
  try {
    deps.lease.release = async () => {
      throw new Error('lease store unavailable');
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'release failure',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await deps.scheduler.idle();
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'completed');
    assert.ok(status.value.result?.summary?.startsWith('A verified result.'));
  } finally {
    await started.close();
  }
});
