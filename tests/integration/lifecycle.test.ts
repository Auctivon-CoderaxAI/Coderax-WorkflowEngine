import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientFor, failingGateway, slowGateway, startTestApp, waitFor } from '../helpers.js';

test('cancellation is durable and observable after the caller disconnects', async () => {
  const started = await startTestApp({ gateway: slowGateway(30_000) });
  const client = clientFor(started.url);
  try {
    const accepted = await client.submitWork({ objective: 'a run that must be cancelled' });
    await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'running' ? true : null;
    });

    const cancelled = await client.cancel(accepted.taskId, 'harness cancellation');
    assert.equal(cancelled.outcome, 'accepted');

    const settled = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'cancelled' ? status : null;
    });
    assert.equal(settled.cancelRequested, true);

    const events = [];
    for await (const event of client.events(accepted.taskId, { after: 0 })) events.push(event);
    assert.equal(events.at(-1)?.type, 'task.cancelled');

    // Cancelling again reports the truth instead of pretending to act.
    const twice = await client.cancel(accepted.taskId);
    assert.equal(twice.outcome, 'already_terminal');
  } finally {
    await started.close();
  }
});

test('a failed task retries on the same engine with a new generation', async () => {
  const started = await startTestApp({ gateway: failingGateway(1) });
  const client = clientFor(started.url);
  try {
    const accepted = await client.submitWork({ objective: 'fail once, then succeed' });
    const failed = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'failed' ? status : null;
    });
    assert.equal(failed.agent, 'coderax');
    assert.equal(failed.generation, 1);

    const retried = await client.retry(accepted.taskId, failed.generation);
    assert.equal(retried.outcome, 'accepted');
    assert.equal(retried.generation, 2);

    const completed = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    // The engine did not change: a retry never substitutes another agent.
    assert.equal(completed.agent, 'coderax');
    assert.equal(completed.generation, 2);

    const stale = await client.retry(accepted.taskId, 1);
    assert.equal(stale.outcome, 'superseded');
  } finally {
    await started.close();
  }
});

test('an interrupted run resumes over HTTP from its checkpoint', async () => {
  const started = await startTestApp({ gateway: slowGateway(30_000) });
  const client = clientFor(started.url);
  const deps = started.app.dependencies;
  try {
    const agent = deps.agents.get('coderax');
    assert.ok(agent);

    const accepted = await client.submitWork({ objective: 'interrupt and resume me' });
    await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'running' ? true : null;
    });

    // Let the lease expire as if the replica holding it had died, then cancel.
    // The engine retires an expired run as interrupted instead of leaving it
    // running forever, which is the only state `resume` accepts.
    deps.clock.now = () => new Date(Date.now() + 60_000);
    const retired = await client.cancel(accepted.taskId, 'the replica died');
    assert.equal(retired.outcome, 'accepted');
    const interrupted = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'interrupted' ? status : null;
    });

    agent.run = async () => ({ ok: true, summary: 'resumed result' });
    const resumed = await client.resume(accepted.taskId, interrupted.generation);
    assert.equal(resumed.outcome, 'accepted');
    assert.equal(resumed.generation, interrupted.generation + 1);

    const completed = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.equal(completed.generation, 2);
    assert.equal(completed.result?.summary, 'resumed result');

    const stale = await client.resume(accepted.taskId, 1);
    assert.equal(stale.outcome, 'superseded');
  } finally {
    await started.close();
  }
});

test('schedules expose read, update, pause, resume, executions and cancel over HTTP', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  const deps = started.app.dependencies;
  try {
    const schedule = await client.createSchedule({
      objective: 'recurring harness task',
      intervalMs: 60_000,
    });
    assert.equal(schedule.enabled, true);
    assert.ok(schedule.nextRunAt);
    assert.equal(schedule.runs, 0);

    const listed = await client.schedules();
    assert.ok(listed.schedules.some((entry) => entry.scheduleId === schedule.scheduleId));

    const fetched = await client.schedule(schedule.scheduleId);
    assert.equal(fetched.scheduleId, schedule.scheduleId);
    assert.equal(fetched.objective, 'recurring harness task');

    // An update edits the definition and restarts the cadence from now.
    const updated = await client.updateSchedule(schedule.scheduleId, {
      objective: 'updated harness task',
      intervalMs: 120_000,
    });
    assert.equal(updated.objective, 'updated harness task');
    assert.equal(updated.intervalMs, 120_000);
    assert.ok(updated.nextRunAt);
    assert.ok(schedule.nextRunAt && updated.nextRunAt > schedule.nextRunAt);

    // An empty edit is refused, not reported as an accepted no-op.
    await assert.rejects(
      () => client.updateSchedule(schedule.scheduleId, {}),
      (error: unknown) => (error as { code?: string }).code === 'validation_failed',
    );

    const paused = await client.pauseSchedule(schedule.scheduleId);
    assert.equal(paused.enabled, false);
    assert.equal(paused.outcome, 'accepted');
    assert.equal(paused.nextRunAt, undefined);

    const pausedAgain = await client.pauseSchedule(schedule.scheduleId);
    assert.equal(pausedAgain.outcome, 'unchanged');

    const resumed = await client.resumeSchedule(schedule.scheduleId);
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.outcome, 'accepted');
    assert.ok(resumed.nextRunAt);

    // Move time past the interval: the engine's own ticker submits ordinary Work.
    deps.clock.now = () => new Date(Date.now() + 121_000);
    const [tick, overlap] = await Promise.all([started.app.service.tickSchedules(), started.app.service.tickSchedules()]);
    assert.deepEqual(overlap, { started: 0, skipped: 0 });
    assert.equal(tick.started, 1);

    const executions = await client.scheduleExecutions(schedule.scheduleId);
    assert.equal(executions.executions.length, 1);
    const firing = executions.executions[0];
    assert.equal(firing?.outcome, 'submitted');
    assert.ok(firing?.taskId, 'a firing must record the task it submitted');
    const taskId = firing.taskId;

    const completed = await waitFor(async () => {
      const status = await client.task(taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.ok(completed.result?.summary);

    const afterTick = await client.schedule(schedule.scheduleId);
    assert.equal(afterTick.runs, 1);
    assert.equal(afterTick.lastTaskId, taskId);

    // The slot advanced, so a second tick cannot submit the same firing twice.
    assert.equal((await started.app.service.tickSchedules()).started, 0);

    assert.deepEqual(await client.cancelSchedule(schedule.scheduleId), {
      scheduleId: schedule.scheduleId,
      outcome: 'canceled',
    });
    assert.equal((await client.cancelSchedule(schedule.scheduleId)).outcome, 'not_found');
    assert.deepEqual((await client.schedules()).schedules, []);
  } finally {
    await started.close();
  }
});

test('a repeated submission with the same idempotency key returns the original task', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  try {
    const first = await client.submitWork({
      objective: 'idempotent harness task',
      idempotencyKey: 'harness-key-0001',
    });
    const second = await client.submitWork({
      objective: 'idempotent harness task',
      idempotencyKey: 'harness-key-0001',
    });
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.replayed, true);
    assert.equal(first.replayed, undefined);

    const tasks = await client.tasks({ limit: 50 });
    assert.equal(
      tasks.tasks.filter((entry) => entry.taskId === first.taskId).length,
      1,
      'the same key created a second task',
    );

    const other = await client.submitWork({
      objective: 'idempotent harness task',
      idempotencyKey: 'harness-key-0002',
    });
    assert.notEqual(other.taskId, first.taskId);
    await waitFor(async () => {
      const status = await client.task(other.taskId);
      return status.state === 'completed' ? status : null;
    });
  } finally {
    await started.close();
  }
});
