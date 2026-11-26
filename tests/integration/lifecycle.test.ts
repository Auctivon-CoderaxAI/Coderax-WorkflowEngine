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

test('schedules create, list, pause, resume, fire and delete over HTTP', async () => {
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

    const paused = await client.controlSchedule(schedule.scheduleId, 'pause');
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, undefined);

    const resumed = await client.controlSchedule(schedule.scheduleId, 'resume');
    assert.equal(resumed.enabled, true);
    assert.ok(resumed.nextRunAt);

    // Move time past the interval: the engine's own ticker submits ordinary Work.
    deps.clock.now = () => new Date(Date.now() + 61_000);
    const tick = await started.app.service.tickSchedules();
    assert.equal(tick.started, 1);

    const afterTick = (await client.schedules()).schedules.find(
      (entry) => entry.scheduleId === schedule.scheduleId,
    );
    assert.equal(afterTick?.runs, 1);
    const taskId = afterTick?.lastTaskId;
    assert.ok(taskId, 'a firing must record the task it submitted');
    const completed = await waitFor(async () => {
      const status = await client.task(taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.ok(completed.result?.summary);

    // The slot advanced, so a second tick cannot submit the same firing twice.
    assert.equal((await started.app.service.tickSchedules()).started, 0);

    assert.deepEqual(await client.deleteSchedule(schedule.scheduleId), {
      scheduleId: schedule.scheduleId,
      outcome: 'deleted',
    });
    assert.equal((await client.deleteSchedule(schedule.scheduleId)).outcome, 'not_found');
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
