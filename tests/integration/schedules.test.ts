import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { createFakeDatabase } from '../fakes/mongo.js';
import {
  baseConfig,
  createWorkspaces,
  failingGateway,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  slowGateway,
  startTestApp,
  waitFor,
} from '../helpers.js';

const FAST_SCHEDULES = {
  tickMs: 50,
  batchSize: 50,
  maxConcurrentRuns: 4,
  missedGraceMs: 1_000,
  dispatchTimeoutMs: 5_000,
  pauseAfterFailures: 5,
  historyLimit: 50,
};

const ENV = { CODERAX_OWNER_TOKEN: OWNER_TOKEN };

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

test('a one-time schedule runs and notifies without any client polling', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const at = new Date(Date.now() + 400).toISOString();
    const created = await api.createSchedule({
      name: 'Deployment report',
      objective: 'Report the current deployment state',
      timing: { kind: 'once', at },
    });
    assert.equal(created.state, 'active');
    // Autonomy is never widened by scheduling.
    assert.equal(created.requireApproval, true);
    assert.ok(created.nextRunAt);

    // Nothing polls `task` or `events` here: the engine loop must discharge it.
    const completed = await waitFor(async () => {
      const history = await api.scheduleExecutions(created.scheduleId);
      return history.executions.find((entry) => entry.state === 'completed') ?? null;
    });

    assert.equal(completed.condition, 'met');
    assert.equal(completed.attempt, 1);
    assert.ok(completed.taskId, 'the execution receipt names its Work task');
    const task = await api.task(completed.taskId);
    assert.equal(task.state, 'completed');
    assert.ok(task.result?.summary?.startsWith('A verified result.'));

    const schedule = await api.schedule(created.scheduleId);
    assert.equal(schedule.state, 'exhausted');
    assert.equal(schedule.runsTotal, 1);
    assert.equal(schedule.nextRunAt, null);

    // One owner-facing notification surface carries the Work completion and the
    // schedule notice, so a client needs a single unread indicator.
    const notices = await api.notifications();
    assert.equal(notices.schedules[0]?.kind, 'completed');
    assert.equal(notices.schedules[0]?.scheduleId, created.scheduleId);
    assert.equal(notices.unread, 2);

    const read = await api.markNotificationsRead();
    assert.equal(read.unread, 0);
    assert.ok(read.schedules.every((entry) => entry.read));
    assert.ok(read.notifications.every((entry) => entry.read));

    // The scheduled run's inference is charged to the same daily ledger as Chat.
    const budget = started.app.service.budget({ ownerId: OWNER_ID, isOwner: true });
    assert.ok((budget.used.usage.inputTokens ?? 0) > 0);
    assert.ok((budget.used.usage.outputTokens ?? 0) > 0);
  } finally {
    await started.close();
  }
});

test('pause stops repetition without cancelling and resume continues it', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const created = await api.createSchedule({
      name: 'Recurring check',
      objective: 'Check the service health',
      timing: { kind: 'interval', everySeconds: 1 },
      limits: { maxRunsPerDay: 20 },
    });

    const first = await waitFor(async () => {
      const current = await api.schedule(created.scheduleId);
      return current.runsTotal >= 1 ? current : null;
    });
    assert.equal(first.state, 'active');

    const paused = await api.pauseSchedule(created.scheduleId);
    assert.equal(paused.outcome, 'accepted');
    assert.equal(paused.state, 'paused');
    // Let any dispatch that was already in flight land before taking the baseline.
    await sleep(300);
    const runsAtPause = (await api.schedule(created.scheduleId)).runsTotal;
    await sleep(1_400);
    assert.equal(
      (await api.schedule(created.scheduleId)).runsTotal,
      runsAtPause,
      'a paused schedule must not start new runs',
    );

    const resumed = await api.resumeSchedule(created.scheduleId);
    assert.equal(resumed.outcome, 'accepted');
    assert.equal(resumed.state, 'active');
    await waitFor(async () => {
      const current = await api.schedule(created.scheduleId);
      return current.runsTotal > runsAtPause ? current : null;
    });

    const cancelled = await api.cancelSchedule(created.scheduleId);
    assert.equal(cancelled.outcome, 'accepted');
    assert.equal(cancelled.state, 'cancelled');
    await assert.rejects(
      () => api.triggerSchedule(created.scheduleId),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 409,
    );
  } finally {
    await started.close();
  }
});

test('an event is deduplicated by idempotency key and triggers each matching schedule once', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const created = await api.createSchedule({
      name: 'After deploy',
      objective: 'Summarize the deployment',
      timing: { kind: 'event', event: 'deploy.finished' },
    });
    assert.equal(created.nextRunAt, null);

    const first = await api.scheduleEvent({
      event: 'deploy.finished',
      idempotencyKey: 'deploy-42',
    });
    assert.equal(first.dispatched.length, 1);
    assert.equal(first.dispatched[0]?.duplicate, false);

    const second = await api.scheduleEvent({
      event: 'deploy.finished',
      idempotencyKey: 'deploy-42',
    });
    assert.equal(second.dispatched.length, 1);
    assert.equal(second.dispatched[0]?.duplicate, true);

    await waitFor(async () => {
      const history = await api.scheduleExecutions(created.scheduleId);
      return history.executions.some((entry) => entry.state === 'completed') ? true : null;
    });
    const history = await api.scheduleExecutions(created.scheduleId);
    assert.equal(history.executions.length, 1, 'one occurrence, not one per delivery');

    // A different delivery key is a distinct occurrence.
    const third = await api.scheduleEvent({
      event: 'deploy.finished',
      idempotencyKey: 'deploy-43',
    });
    assert.equal(third.dispatched[0]?.duplicate, false);
  } finally {
    await started.close();
  }
});

test('a failed scheduled run produces one failure notice and no retry when final', async () => {
  const started = await startTestApp({
    gateway: failingGateway(1),
    config: { schedules: FAST_SCHEDULES },
  });
  const api = client(started.url);
  try {
    const at = new Date(Date.now() + 300).toISOString();
    const created = await api.createSchedule({
      name: 'Failing check',
      objective: 'Run the failing check',
      timing: { kind: 'once', at },
      retry: { maxAttempts: 3, delaySeconds: 0 },
    });

    const failed = await waitFor(async () => {
      const history = await api.scheduleExecutions(created.scheduleId);
      return history.executions.find((entry) => entry.state === 'failed') ?? null;
    });
    assert.equal(failed.attempt, 1, 'a provider failure after dispatch is not replayed');

    const schedule = await api.schedule(created.scheduleId);
    assert.equal(schedule.consecutiveFailures, 1);
    assert.equal(schedule.state, 'exhausted');

    const notices = await api.notifications();
    assert.equal(notices.schedules.filter((entry) => entry.kind === 'failed').length, 1);
  } finally {
    await started.close();
  }
});

test('cancelling a schedule cancels the Work task it started', async () => {
  const started = await startTestApp({
    gateway: slowGateway(60_000),
    config: { schedules: FAST_SCHEDULES },
  });
  const api = client(started.url);
  try {
    const at = new Date(Date.now() + 150).toISOString();
    const created = await api.createSchedule({
      name: 'Long scheduled run',
      objective: 'Run until the owner stops it',
      timing: { kind: 'once', at },
    });

    const execution = await waitFor(async () => {
      const history = await api.scheduleExecutions(created.scheduleId);
      return history.executions.find((entry) => entry.state === 'dispatched') ?? null;
    });
    assert.ok(execution.taskId);
    const taskId = execution.taskId;
    await waitFor(async () => {
      const task = await api.task(taskId);
      return task.state === 'running' ? task : null;
    });

    const cancelled = await api.cancelSchedule(created.scheduleId);
    assert.equal(cancelled.outcome, 'accepted');

    const task = await waitFor(async () => {
      const current = await api.task(taskId);
      return current.state === 'cancelled' ? current : null;
    });
    assert.equal(task.state, 'cancelled');

    const receipt = await waitFor(async () => {
      const history = await api.scheduleExecutions(created.scheduleId);
      return history.executions.find((entry) => entry.state === 'cancelled') ?? null;
    });
    assert.equal(receipt.state, 'cancelled');
  } finally {
    await started.close();
  }
});

test('two replicas sharing durable storage execute one occurrence exactly once', async () => {
  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const gateway = fakeGateway();
  const config = baseConfig(workspace, {
    persistence: { driver: 'mongo' },
    schedules: FAST_SCHEDULES,
  });

  const first = await composeApplication({
    config,
    env: ENV,
    gateway,
    persistence: { database },
  });
  const second = await composeApplication({
    config,
    env: ENV,
    gateway,
    persistence: { database },
  });

  try {
    const { url: firstUrl } = await first.start();
    const { url: secondUrl } = await second.start();
    const api = client(firstUrl);
    const other = client(secondUrl);

    const at = new Date(Date.now() + 400).toISOString();
    const created = await api.createSchedule({
      name: 'Shared schedule',
      objective: 'Run once across replicas',
      timing: { kind: 'once', at },
    });

    const completed = await waitFor(async () => {
      const history = await other.scheduleExecutions(created.scheduleId);
      return history.executions.find((entry) => entry.state === 'completed') ?? null;
    });

    assert.ok(completed.taskId);
    assert.ok(gateway.calls >= 1, 'the scheduled task actually ran');
    assert.equal(
      database.collections.get('tasks')?.documents.length,
      1,
      'the deterministic task id admits one Work task across replicas',
    );
    const history = await api.scheduleExecutions(created.scheduleId);
    assert.equal(history.executions.length, 1);

    const schedule = await api.schedule(created.scheduleId);
    assert.equal(schedule.runsTotal, 1);
  } finally {
    await first.stop();
    await second.stop();
    workspace.cleanup();
  }
});

test('an edit cannot widen the authorized execution identity, and previews match the rule', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const created = await api.createSchedule({
      name: 'Hourly inspection',
      objective: 'Inspect the deployment',
      timing: { kind: 'interval', everySeconds: 3_600 },
    });

    const upcoming = await api.scheduleUpcoming(created.scheduleId, 3);
    assert.equal(upcoming.occurrences.length, 3);
    assert.ok(upcoming.occurrences[0] && upcoming.occurrences[1]);
    assert.ok(upcoming.occurrences[1] > upcoming.occurrences[0]);

    // The update schema omits agent/mode/model/objective, and the router
    // validates strictly, so an edit cannot redirect an authorized schedule.
    await assert.rejects(
      api.updateSchedule(created.scheduleId, { agent: 'opencode' } as never),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'validation_failed',
    );

    const edited = await api.updateSchedule(created.scheduleId, {
      name: 'Monthly inspection',
      timing: { kind: 'monthly', timeZone: 'UTC', dayOfMonth: 15, hour: 9, minute: 0 },
    });
    assert.equal(edited.name, 'Monthly inspection');
    assert.equal(edited.agent, created.agent);
    assert.equal(edited.mode, created.mode);
    assert.equal(edited.objective, created.objective);
    assert.ok(edited.nextRunAt?.endsWith('T09:00:00.000Z'));

    const preview = await api.scheduleUpcoming(edited.scheduleId, 2);
    assert.equal(preview.occurrences.length, 2);
    assert.ok(preview.occurrences.every((at) => at.endsWith('T09:00:00.000Z')));

    await api.cancelSchedule(edited.scheduleId);
    await assert.rejects(
      api.updateSchedule(edited.scheduleId, { name: 'After cancel' }),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 409,
    );
  } finally {
    await started.close();
  }
});

test('editing a paused schedule preserves the pause and resume computes the next run', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const created = await api.createSchedule({
      name: 'Paused inspection',
      objective: 'Inspect the deployment',
      timing: { kind: 'interval', everySeconds: 3_600 },
    });
    const paused = await api.pauseSchedule(created.scheduleId);
    assert.equal(paused.state, 'paused');

    const edited = await api.updateSchedule(created.scheduleId, { name: 'Still paused' });
    assert.equal(edited.state, 'paused');
    assert.equal(edited.nextRunAt, null);

    const resumed = await api.resumeSchedule(created.scheduleId);
    assert.equal(resumed.state, 'active');
    assert.ok((await api.schedule(created.scheduleId)).nextRunAt);
  } finally {
    await started.close();
  }
});
