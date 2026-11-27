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
  taskRecord,
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

    const headers = { authorization: `Bearer ${OWNER_TOKEN}` };
    for (const method of ['GET', 'POST']) {
      const path = method === 'POST' ? '/v1/notifications/read' : '/v1/notifications';
      const response = await fetch(started.url + path, { method, headers });
      assert.equal(response.status, 200);
      const legacy = await response.json();
      assert.ok(legacy && typeof legacy === "object" && "unread" in legacy);
      assert.deepEqual(Object.keys(legacy).sort(), ['notifications', 'unread']);
      assert.equal(legacy.unread, method === 'POST' ? 0 : 1);
    }
    assert.equal((await api.notifications()).unread, 1);
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
    // The run retries a retryable provider failure inside its own bounds, so a
    // final failure needs a gateway that exhausts them; the schedule must still
    // record one failed occurrence and never replay it.
    gateway: failingGateway(100),
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

    const store = started.app.dependencies.schedules;
    const list = store.listPending;
    store.listPending = async () => { throw new Error('temporary store outage'); };
    await assert.rejects(api.cancelSchedule(created.scheduleId), CoderaxApiError);
    assert.equal((await api.schedule(created.scheduleId)).state, 'cancelled');
    store.listPending = list;
    const task = await waitFor(async () => {
      const current = await api.task(taskId);
      return current.state === 'cancelled' ? current : null;
    });
    assert.equal(task.state, 'cancelled');

    const cancelled = await api.cancelSchedule(created.scheduleId);
    assert.equal(cancelled.state, 'cancelled');



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

test('a partial limits edit preserves the stored daily cap and run budget', async () => {
  const started = await startTestApp({ config: { schedules: FAST_SCHEDULES } });
  const api = client(started.url);
  try {
    const created = await api.createSchedule({
      name: 'Bounded inspection',
      objective: 'Inspect the deployment',
      timing: { kind: 'interval', everySeconds: 3_600 },
      limits: {
        maxRunsPerDay: 3,
        budget: { maxRequests: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
      },
    });

    const edited = await api.updateSchedule(created.scheduleId, {
      limits: { maxRunsTotal: 10 },
    });
    assert.equal(edited.limits.maxRunsPerDay, 3, 'the omitted daily cap is not reset to its default');
    assert.deepEqual(edited.limits.budget, {
      maxRequests: 4,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
    });
    assert.equal(edited.limits.maxRunsTotal, 10);
  } finally {
    await started.close();
  }
});

test('dispatch rechecks an edited event and preserves explicit paused triggers', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const { schedules } = started.app.dependencies;
    const rule = await api.createSchedule({ name: 'Release', objective: 'Report release', timing: { kind: 'event', event: 'old' } });
    const list = schedules.listActive;
    schedules.listActive = async () => {
      const selected = await list();
      await api.updateSchedule(rule.scheduleId, { timing: { kind: 'event', event: 'new' } });
      return selected;
    };
    const event = await api.scheduleEvent({ event: 'old', idempotencyKey: 'release' });
    assert.equal(event.dispatched[0]?.state, 'refused');
    await api.pauseSchedule(rule.scheduleId);
    assert.equal((await api.triggerSchedule(rule.scheduleId)).state, 'dispatched');
  } finally {
    await started.close();
  }
});

test('cancellation during task insertion prevents enqueue', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const { tasks, scheduler } = started.app.dependencies;
    const rule = await api.createSchedule({ name: 'Release', objective: 'Report release', timing: { kind: 'event', event: 'release' } });
    const create = tasks.create;
    tasks.create = async record => {
      await api.cancelSchedule(rule.scheduleId);
      return create(record);
    };
    scheduler.enqueue = () => assert.fail('cancelled Work must never be enqueued');
    await api.triggerSchedule(rule.scheduleId);
    const receipt = (await api.scheduleExecutions(rule.scheduleId)).executions[0];
    assert.equal(receipt?.state, 'cancelled');
    assert.ok(receipt.taskId);
    assert.equal((await api.task(receipt.taskId)).state, 'cancelled');
  } finally {
    await started.close();
  }
});

test('recovery winning a stalled submission charges and appends just once', async () => {
  const started = await startTestApp({ config: { schedules: { ...FAST_SCHEDULES, dispatchTimeoutMs: 1000, tickMs: 100 } } });
  const api = client(started.url);
  try {
    const rule = await api.createSchedule({ name: 'Release', objective: 'Report release', timing: { kind: 'event', event: 'release' } });
    const { conversations } = started.app.dependencies;
    const ensure = conversations.ensure;
    conversations.ensure = async record => {
      conversations.ensure = ensure;
      await sleep(1100);
      await started.app.service.tickSchedules();
      return ensure(record);
    };
    await api.triggerSchedule(rule.scheduleId);
    const receipt = (await api.scheduleExecutions(rule.scheduleId)).executions[0];
    assert.ok(receipt);
    assert.equal((await conversations.messages(receipt.conversationId)).filter(m => m.role === 'user').length, 1);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 1);
  } finally {
    await started.close();
  }
});

test('cap edit winning the accounting CAS prevents Work submission', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const { schedules, scheduler } = started.app.dependencies;
    const rule = await api.createSchedule({ name: 'Release', objective: 'Report', timing: { kind: 'event', event: 'release' } });
    await schedules.update({ scheduleId: rule.scheduleId, expectedVersion: 0, patch: { runsTotal: 1 } });
    const update = schedules.update;
    schedules.update = async input => {
      if (input.patch.runsTotal) {
        schedules.update = update;
        await api.updateSchedule(rule.scheduleId, { limits: { maxRunsTotal: 1 } });
      }
      return update(input);
    };
    scheduler.enqueue = () => assert.fail('cap edit should prevent enqueue');
    assert.equal((await api.triggerSchedule(rule.scheduleId)).state, 'refused');
    assert.equal((await api.schedule(rule.scheduleId)).runsTotal, 1);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 0);
  } finally { await started.close(); }
});

test('append acknowledgement loss leaves a recoverable claim without a task or charge', async () => {
  const started = await startTestApp({ config: { schedules: { ...FAST_SCHEDULES, dispatchTimeoutMs: 1000, tickMs: 100 } } });
  const api = client(started.url);
  try {
    const rule = await api.createSchedule({ name: 'Release', objective: 'Report', timing: { kind: 'event', event: 'release' } });
    const { conversations, tasks } = started.app.dependencies;
    const append = conversations.appendMessage;
    conversations.appendMessage = async message => {
      conversations.appendMessage = append;
      await append(message);
      throw new Error('lost append acknowledgement');
    };
    await assert.rejects(api.triggerSchedule(rule.scheduleId), CoderaxApiError);
    const receipt = (await api.scheduleExecutions(rule.scheduleId)).executions[0];
    assert.ok(receipt?.taskId);
    assert.equal(await tasks.get(receipt.taskId), null);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 0);
    await sleep(1100);
    await started.app.service.tickSchedules();
    await started.app.dependencies.scheduler.idle();
    assert.equal((await api.task(receipt.taskId)).state, 'completed');
    assert.equal((await api.schedule(rule.scheduleId)).runsTotal, 1);
    assert.equal((await conversations.messages(receipt.conversationId)).filter(m => m.role === 'user').length, 1);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 1);
  } finally { await started.close(); }
});

test('interrupted scheduled Work without completed admission cannot resume or retry', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const rule = await api.createSchedule({ name: 'Monitor', objective: 'Check status', timing: { kind: 'event', event: 'monitor' } });
    const task = taskRecord({ state: 'interrupted', scheduleAdmission: {
      scheduleId: rule.scheduleId, executionId: 'exe_pending', complete: false,
    } });
    const { tasks } = started.app.dependencies;
    await tasks.create(task);
    const owner = { ownerId: OWNER_ID, isOwner: true as const };
    for (const control of [started.app.service.resumeTask, started.app.service.retryTask]) {
      const result = await control(owner, task.taskId, task.generation);
      assert.equal(!result.ok && result.code, 'conflict');
    }
    assert.equal((await tasks.get(task.taskId))?.generation, task.generation);
    assert.equal(started.app.service.budget(owner).used.requests, 0);
  } finally { await started.close(); }
});

for (const applied of [false, true]) {
  test(`scheduled marker acknowledgement: write applied = ${applied}`, async () => {
    const started = await startTestApp();
    try {
      const api = client(started.url);
      const rule = await api.createSchedule({ name: 'Marker', objective: 'Check status', timing: { kind: 'event', event: 'marker' } });
      const { tasks, scheduler } = started.app.dependencies;
      const write = tasks.updateFenced;
      tasks.updateFenced = async input => {
        if (!input.patch.scheduleAdmission?.complete) return write(input);
        tasks.updateFenced = write;
        if (applied) await write(input);
        throw new Error('marker acknowledgement unavailable');
      };
      const trigger = api.triggerSchedule(rule.scheduleId);
      if (applied) await trigger;
      else await assert.rejects(trigger);
      await scheduler.idle();
      const receipt = (await api.scheduleExecutions(rule.scheduleId)).executions[0];
      assert.ok(receipt?.taskId);
      assert.equal((await api.task(receipt.taskId)).state, applied ? 'completed' : 'cancelled');
      assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, Number(applied));
    } finally { await started.close(); }
  });
}

test('a replica delivers a marked task when its original queue handoff was lost', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const rule = await api.createSchedule({ name: 'Recovery', objective: 'Check status', timing: { kind: 'event', event: 'recover' } });
    const { scheduler, lease, tasks } = started.app.dependencies;
    const enqueue = scheduler.enqueue;
    scheduler.enqueue = () => true;
    const receipt = await api.triggerSchedule(rule.scheduleId);
    scheduler.enqueue = enqueue;
    assert.ok(receipt.taskId);
    const task = await tasks.get(receipt.taskId);
    assert.ok(task?.runToken);
    await lease.release({ key: JSON.stringify(['', task.ownerId, task.conversationId]), token: task.runToken });
    await started.app.service.tickSchedules();
    await scheduler.idle();
    await started.app.service.tickSchedules();
    assert.equal((await api.task(task.taskId)).state, 'completed');
    assert.equal((await api.schedule(rule.scheduleId)).runsTotal, 1);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 1);
  } finally { await started.close(); }
});

test('lowering the daily cap while Work is being accepted refuses the candidate', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const rule = await api.createSchedule({ name: 'Quota', objective: 'Check status',
      timing: { kind: 'event', event: 'quota' }, limits: { maxRunsPerDay: 2 } });
    const { schedules, scheduler } = started.app.dependencies;
    await api.triggerSchedule(rule.scheduleId);
    await scheduler.idle();
    await started.app.service.tickSchedules();
    const update = schedules.update;
    schedules.update = async input => {
      if (input.patch.runsTotal) {
        schedules.update = update;
        await api.updateSchedule(rule.scheduleId, { limits: { maxRunsPerDay: 1 } });
      }
      return update(input);
    };
    assert.equal((await api.triggerSchedule(rule.scheduleId)).state, 'refused');
    assert.equal((await api.schedule(rule.scheduleId)).runsTotal, 1);
  } finally { await started.close(); }
});

test('a replica finishes an accounted handoff before the old marker writer returns', async () => {
  const started = await startTestApp();
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  try {
    const api = client(started.url);
    const rule = await api.createSchedule({ name: 'Takeover', objective: 'Report', timing: { kind: 'event', event: 'recover' } });
    const { tasks, scheduler, lease } = started.app.dependencies;
    let reached!: (id: string) => void;
    const marker = new Promise<string>(resolve => { reached = resolve; });
    const write = tasks.updateFenced;
    tasks.updateFenced = async input => {
      if (input.patch.scheduleAdmission?.complete) {
        tasks.updateFenced = write;
        reached(input.taskId);
        await resumed;
      }
      return write(input);
    };
    const dispatch = api.triggerSchedule(rule.scheduleId);
    const task = await tasks.get(await marker);
    assert.ok(task?.runToken);
    await lease.release({ key: JSON.stringify(['', task.ownerId, task.conversationId]), token: task.runToken });
    await started.app.service.tickSchedules();
    resume();
    await dispatch;
    await scheduler.idle();
    await started.app.service.tickSchedules();
    assert.equal((await api.task(task.taskId)).state, 'completed');
    assert.equal((await api.scheduleExecutions(rule.scheduleId)).executions[0]?.state, 'completed');
    assert.equal((await api.schedule(rule.scheduleId)).runsTotal, 1);
    assert.equal(started.app.service.budget({ ownerId: OWNER_ID, isOwner: true }).used.requests, 1);
  } finally { resume(); await started.close(); }
});
