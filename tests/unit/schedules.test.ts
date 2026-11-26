import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScheduleCreateRequest } from '@coderax/contracts';
import type { ScheduleTiming } from '@coderax/contracts';
import type { ScheduleExecutionRecord, ScheduleNoticeRecord, ScheduleRecord } from '../../src/domain.js';
import type { IdGenerator } from '../../src/support/clock.js';
import {
  createScheduleNoticeStore,
  createScheduleRepository,
} from '../../src/persistence/schedules.js';
import {
  createMongoScheduleNoticeStore,
  createMongoScheduleRepository,
  ensureScheduleIndexes,
} from '../../src/persistence/mongo-schedules.js';
import {
  decideDue,
  evaluateCondition,
  nextOccurrence,
  utcDayStart,
  zonedWallTimeToInstant,
} from '../../src/scheduling/calendar.js';
import { createScheduleEngine } from '../../src/scheduling/engine.js';
import type {
  ScheduleDispatchOutcome,
  ScheduleEngine,
  ScheduleEngineSettings,
  SchedulePort,
  ScheduleTaskSnapshot,
} from '../../src/scheduling/engine.js';
import { createFakeCollection } from '../fakes/mongo.js';

const OWNER = 'owner-test';
const NOW = '2026-11-26T12:00:00.000Z';

const SETTINGS: ScheduleEngineSettings = {
  enabled: true,
  tickMs: 50,
  batchSize: 50,
  maxConcurrentRuns: 4,
  missedGraceMs: 1_000,
  dispatchTimeoutMs: 5_000,
  pauseAfterFailures: 5,
};

function scheduleRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    scheduleId: 'sch_test',
    ownerId: OWNER,
    name: 'Test schedule',
    objective: 'Check the deployment',
    agent: 'coderax',
    model: { providerId: 'free', modelId: 'coderax-small' },
    mode: 'cloud',
    timing: { kind: 'interval', everySeconds: 60 },
    condition: { kind: 'always' },
    retry: { maxAttempts: 1, delaySeconds: 0 },
    priority: 5,
    limits: { maxRunsPerDay: 24 },
    requireApproval: true,
    missedRunPolicy: 'skip',
    state: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW,
    lastRunAt: null,
    lastExecutionId: null,
    runsTotal: 0,
    consecutiveFailures: 0,
    version: 0,
    pausedAt: null,
    cancelledAt: null,
    cancelReason: null,
    ...overrides,
  };
}

function executionRecord(
  schedule: ScheduleRecord,
  overrides: Partial<ScheduleExecutionRecord> = {},
): ScheduleExecutionRecord {
  return {
    executionId: 'exe_seed',
    executionKey: `${schedule.scheduleId}:seed:1`,
    scheduleId: schedule.scheduleId,
    ownerId: schedule.ownerId,
    occurrenceKey: 'seed',
    trigger: 'schedule',
    scheduledFor: schedule.createdAt,
    state: 'completed',
    attempt: 1,
    maxAttempts: 1,
    taskId: null,
    conversationId: 'conv_sched_seed',
    priority: 5,
    detail: null,
    nextAttemptAt: null,
    condition: 'not_evaluated',
    createdAt: schedule.createdAt,
    updatedAt: schedule.createdAt,
    finishedAt: schedule.createdAt,
    ...overrides,
  };
}

function noticeRecord(overrides: Partial<ScheduleNoticeRecord> = {}): ScheduleNoticeRecord {
  return {
    noticeId: 'ntc_seed',
    scheduleId: 'sch_test',
    executionId: 'exe_seed',
    ownerId: OWNER,
    kind: 'completed',
    summary: 'Completed.',
    createdAt: NOW,
    read: false,
    ...overrides,
  };
}

function testClock(initial = NOW): {
  clock: { now: () => Date; iso: () => string };
  advance: (ms: number) => void;
} {
  let current = new Date(initial);
  return {
    clock: {
      now: () => new Date(current.getTime()),
      iso: () => current.toISOString(),
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function testIds(): IdGenerator {
  let count = 0;
  const next = (prefix: string): string => `${prefix}_${(count += 1)}`;
  return {
    conversationId: () => next('conv'),
    taskId: () => next('task'),
    messageId: () => next('msg'),
    eventId: () => next('evt'),
    scheduleId: () => next('sch'),
    executionId: () => next('exe'),
    noticeId: () => next('ntc'),
    runToken: () => next('run'),
    requestId: () => next('req'),
    receipt: () => next('rcpt'),
  };
}

function testPort(): {
  calls: Array<{ scheduleId: string; taskId: string; attempt: number }>;
  snapshots: Map<string, ScheduleTaskSnapshot>;
  port: SchedulePort;
} {
  const calls: Array<{ scheduleId: string; taskId: string; attempt: number }> = [];
  const snapshots = new Map<string, ScheduleTaskSnapshot>();
  return {
    calls,
    snapshots,
    port: {
      dispatch: async ({ schedule, taskId, attempt }): Promise<ScheduleDispatchOutcome> => {
        calls.push({ scheduleId: schedule.scheduleId, taskId, attempt });
        return { ok: true };
      },
      taskSnapshot: async (taskId) => snapshots.get(taskId) ?? null,
    },
  };
}

function engineFor(input: {
  store: ReturnType<typeof createScheduleRepository>;
  notices?: ReturnType<typeof createScheduleNoticeStore>;
  port: SchedulePort;
  clock: { now: () => Date; iso: () => string };
  settings?: Partial<ScheduleEngineSettings>;
}): ScheduleEngine {
  return createScheduleEngine({
    store: input.store,
    notices: input.notices ?? createScheduleNoticeStore(),
    port: input.port,
    settings: { ...SETTINGS, ...(input.settings ?? {}) },
    clock: input.clock,
    ids: testIds(),
  });
}

test('calendar schedules keep their wall-clock time in the requested zone', () => {
  const timing: ScheduleTiming = {
    kind: 'calendar',
    timeZone: 'America/New_York',
    hour: 9,
    minute: 0,
    daysOfWeek: [1],
  };
  const next = nextOccurrence(
    timing,
    new Date('2026-11-26T12:00:00.000Z'),
    new Date('2026-11-01T00:00:00.000Z'),
  );
  // 2026-11-26 is a Thursday; the next Monday is 09:00 EST (UTC-5).
  assert.equal(next?.toISOString(), '2026-11-30T14:00:00.000Z');
});

test('a wall time inside the spring-forward gap resolves to the next real time', () => {
  const instant = zonedWallTimeToInstant(
    { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
    'America/New_York',
  );
  // 02:30 does not exist on 2026-03-08 in New York; 03:30 EDT is 07:30Z.
  assert.equal(instant?.toISOString(), '2026-03-08T07:30:00.000Z');
});

test('interval occurrences are strictly after the cursor and follow the anchor', () => {
  const timing: ScheduleTiming = {
    kind: 'interval',
    everySeconds: 60,
    anchor: '2026-11-26T00:00:00.000Z',
  };
  const createdAt = new Date('2026-11-20T00:00:00.000Z');
  assert.equal(
    nextOccurrence(timing, new Date('2026-11-26T12:00:00.000Z'), createdAt)?.toISOString(),
    '2026-11-26T12:01:00.000Z',
  );
  assert.equal(
    nextOccurrence(timing, new Date('2026-11-26T12:00:30.000Z'), createdAt)?.toISOString(),
    '2026-11-26T12:01:00.000Z',
  );
});

test('a due run inside the grace window runs; a later one is missed', () => {
  const schedule = scheduleRecord({ nextRunAt: '2026-11-26T11:59:30.000Z' });
  assert.equal(
    decideDue({ schedule, now: new Date(NOW), missedGraceMs: 60_000 }).kind,
    'run',
  );
  assert.equal(
    decideDue({ schedule, now: new Date(NOW), missedGraceMs: 1_000 }).kind,
    'missed',
  );
  assert.equal(
    decideDue({
      schedule: scheduleRecord({ state: 'paused' }),
      now: new Date(NOW),
      missedGraceMs: 60_000,
    }).kind,
    'none',
  );
});

test('conditions decide whether a monitoring run is a notification', () => {
  assert.equal(evaluateCondition({ kind: 'always' }, ''), 'met');
  assert.equal(
    evaluateCondition({ kind: 'result_contains', text: 'error' }, 'an ERROR was found'),
    'met',
  );
  assert.equal(
    evaluateCondition({ kind: 'result_contains', text: 'error' }, 'all clear'),
    'unmet',
  );
  assert.equal(
    evaluateCondition({ kind: 'result_absent', text: 'error' }, 'all clear'),
    'met',
  );
});

test('the repository arbitrates one compare-and-swap and one receipt per occurrence', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord();
  assert.deepEqual(await store.create(schedule), { ok: true, schedule });
  assert.deepEqual(await store.create(schedule), { ok: false, reason: 'exists' });

  const first = await store.update({
    scheduleId: schedule.scheduleId,
    expectedVersion: 0,
    patch: { runsTotal: 1 },
  });
  assert.equal(first.applied, true);
  assert.equal(first.schedule?.runsTotal, 1);

  const stale = await store.update({
    scheduleId: schedule.scheduleId,
    expectedVersion: 0,
    patch: { runsTotal: 99 },
  });
  assert.equal(stale.applied, false);
  assert.equal((await store.get(schedule.scheduleId))?.runsTotal, 1);

  const receipt = executionRecord(schedule);
  assert.equal((await store.createExecution(receipt)).created, true);
  const duplicate = await store.createExecution({ ...receipt, executionId: 'exe_other' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.execution.executionId, 'exe_seed');

  // A terminal receipt cannot be reopened by a late transition.
  assert.equal(
    await store.updateExecution({
      executionId: 'exe_seed',
      from: ['claimed'],
      patch: { state: 'failed' },
    }),
    null,
  );
  assert.equal(
    (await store.updateExecution({
      executionId: 'exe_seed',
      from: ['completed'],
      patch: { detail: 'settled' },
    }))?.detail,
    'settled',
  );
});

test('the Mongo schedule store enforces the unique execution key and notice identity', async () => {
  const schedules = createFakeCollection();
  const executions = createFakeCollection();
  const notices = createFakeCollection();
  await ensureScheduleIndexes({ schedules, executions, notices });
  const store = createMongoScheduleRepository({ schedules, executions });
  const schedule = scheduleRecord();

  assert.equal((await store.create(schedule)).ok, true);
  assert.equal((await store.create({ ...schedule, name: 'Other' })).ok, false);

  assert.equal(
    (await store.update({ scheduleId: schedule.scheduleId, expectedVersion: 0, patch: { runsTotal: 1 } }))
      .applied,
    true,
  );
  assert.equal(
    (await store.update({ scheduleId: schedule.scheduleId, expectedVersion: 0, patch: { runsTotal: 2 } }))
      .applied,
    false,
  );

  const receipt = executionRecord(schedule, { executionId: 'exe_1', executionKey: 'schedule:occ:1' });
  assert.equal((await store.createExecution(receipt)).created, true);
  const duplicate = await store.createExecution({
    ...receipt,
    executionId: 'exe_2',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.execution.executionId, 'exe_1');
  assert.equal((await store.listExecutions(schedule.scheduleId, 10)).length, 1);

  const noticeStore = createMongoScheduleNoticeStore(notices);
  assert.equal(await noticeStore.record(noticeRecord()), true);
  assert.equal(await noticeStore.record(noticeRecord()), false);
  const before = await noticeStore.list(OWNER, 10);
  assert.equal(before.unread, 1);
  await noticeStore.markAllRead(OWNER);
  assert.equal((await noticeStore.list(OWNER, 10)).unread, 0);
});

test('two replicas dispatch one due occurrence exactly once', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ nextRunAt: NOW });
  await store.create(schedule);
  const notices = createScheduleNoticeStore();
  const shared = testPort();
  const clock = testClock();
  const first = engineFor({ store, notices, port: shared.port, clock: clock.clock });
  const second = engineFor({ store, notices, port: shared.port, clock: clock.clock });

  await Promise.all([first.tick(), second.tick()]);

  assert.equal(shared.calls.length, 1, 'only one replica may submit the occurrence');
  const executions = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.state, 'dispatched');
  assert.equal((await store.get(schedule.scheduleId))?.runsTotal, 1);
});

test('a missed occurrence is recorded once and the next run is not a backlog', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: '2026-11-26T10:00:00.000Z',
    timing: { kind: 'interval', everySeconds: 60 },
  });
  await store.create(schedule);
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock });

  const report = await engine.tick();
  assert.equal(report.missed, 1);
  assert.equal(port.calls.length, 0);

  const executions = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(executions[0]?.state, 'missed');
  const advanced = await store.get(schedule.scheduleId);
  assert.equal(advanced?.nextRunAt, '2026-11-26T12:01:00.000Z');

  // A second pass must not record the same missed occurrence again.
  await engine.tick();
  assert.equal((await store.listExecutions(schedule.scheduleId, 10)).length, 1);
});

test('run_once recovers a missed occurrence with exactly one catch-up run', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: '2026-11-26T10:00:00.000Z',
    timing: { kind: 'interval', everySeconds: 60 },
    missedRunPolicy: 'run_once',
  });
  await store.create(schedule);
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock });

  await engine.tick();
  assert.equal(port.calls.length, 1);
  const advanced = await store.get(schedule.scheduleId);
  assert.equal(advanced?.nextRunAt, '2026-11-26T12:01:00.000Z');
  await engine.tick();
  assert.equal(port.calls.length, 1, 'the backlog is not replayed');
});

test('a retryable failure waits for its policy and re-runs with a new task id', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    timing: { kind: 'once', at: NOW },
    nextRunAt: NOW,
    retry: { maxAttempts: 2, delaySeconds: 0 },
  });
  await store.create(schedule);
  const port = testPort();
  const notices = createScheduleNoticeStore();
  const clock = testClock(NOW);
  const engine = engineFor({ store, notices, port: port.port, clock: clock.clock });

  await engine.tick();
  assert.equal(port.calls.length, 1);
  let execution = (await store.listExecutions(schedule.scheduleId, 10))[0];
  assert.equal(execution?.attempt, 1);
  port.snapshots.set(execution?.taskId as string, {
    state: 'failed',
    summary: null,
    failure: { code: 'server_unavailable', retryable: true },
  });

  await engine.tick();
  assert.equal(port.calls.length, 2, 'the retry is dispatched');
  const retried = port.calls[1];
  assert.equal(retried?.attempt, 2);
  assert.notEqual(retried?.taskId, port.calls[0]?.taskId);
  execution = (await store.listExecutions(schedule.scheduleId, 10))[0];
  assert.equal(execution?.state, 'dispatched');

  port.snapshots.set(retried?.taskId as string, {
    state: 'completed',
    summary: 'Recovered on the retry.',
    failure: null,
  });
  await engine.tick();
  execution = (await store.listExecutions(schedule.scheduleId, 10))[0];
  assert.equal(execution?.state, 'completed');
  assert.equal(execution?.condition, 'met');
  const listed = await notices.list(OWNER, 10);
  assert.equal(listed.notifications.length, 1);
  assert.equal(listed.notifications[0]?.kind, 'completed');
});

test('a failure that the adapter marked non-retryable is final and notifies once', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    timing: { kind: 'once', at: NOW },
    nextRunAt: NOW,
    retry: { maxAttempts: 3, delaySeconds: 0 },
  });
  await store.create(schedule);
  const port = testPort();
  const notices = createScheduleNoticeStore();
  const clock = testClock(NOW);
  const engine = engineFor({ store, notices, port: port.port, clock: clock.clock });

  await engine.tick();
  const taskId = port.calls[0]?.taskId as string;
  port.snapshots.set(taskId, {
    state: 'failed',
    summary: null,
    failure: { code: 'provider_error', retryable: false },
  });
  await engine.tick();

  const execution = (await store.listExecutions(schedule.scheduleId, 10))[0];
  assert.equal(execution?.state, 'failed');
  assert.equal(port.calls.length, 1);
  assert.equal((await store.get(schedule.scheduleId))?.consecutiveFailures, 1);
  const listed = await notices.list(OWNER, 10);
  assert.equal(listed.notifications.length, 1);
  assert.equal(listed.notifications[0]?.kind, 'failed');
});

test('due schedules are offered highest priority first', async () => {
  const store = createScheduleRepository();
  await store.create(
    scheduleRecord({
      scheduleId: 'sch_low',
      priority: 1,
      nextRunAt: '2026-11-26T11:00:00.000Z',
    }),
  );
  await store.create(
    scheduleRecord({
      scheduleId: 'sch_high',
      priority: 9,
      nextRunAt: '2026-11-26T11:30:00.000Z',
    }),
  );
  const due = await store.listDue({ now: NOW, limit: 10 });
  assert.deepEqual(
    due.map((entry) => entry.scheduleId),
    ['sch_high', 'sch_low'],
  );
});

test('a schedule cannot be created with owner approval disabled', () => {
  const parsed = ScheduleCreateRequest.safeParse({
    name: 'Unsafe',
    objective: 'Act without asking',
    timing: { kind: 'once', at: '2026-11-27T00:00:00.000Z' },
    requireApproval: false,
  });
  assert.equal(parsed.success, false, 'approvals are a literal, not a choice');
});

test('consecutive failures pause a schedule to prevent a runaway loop', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: NOW,
    timing: { kind: 'interval', everySeconds: 600 },
    retry: { maxAttempts: 1, delaySeconds: 0 },
  });
  await store.create(schedule);
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({
    store,
    port: port.port,
    clock: clock.clock,
    settings: { pauseAfterFailures: 1 },
  });

  await engine.tick();
  const taskId = port.calls[0]?.taskId as string;
  port.snapshots.set(taskId, {
    state: 'failed',
    summary: null,
    failure: { code: 'provider_error', retryable: false },
  });
  await engine.tick();

  const paused = await store.get(schedule.scheduleId);
  assert.equal(paused?.state, 'paused');
  assert.equal(paused?.nextRunAt, null);
  assert.equal(paused?.pausedAt, NOW);
  assert.equal(paused?.consecutiveFailures, 1);
});

test('refusals consume the daily budget so an unavailable agent cannot storm', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: NOW,
    timing: { kind: 'interval', everySeconds: 60 },
    limits: { maxRunsPerDay: 1 },
  });
  await store.create(schedule);
  const port = testPort();
  port.port.dispatch = async () => ({
    ok: false,
    reason: 'refused',
    detail: 'The agent is unavailable.',
  });
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock });

  await engine.tick();
  let executions = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(executions[0]?.state, 'refused');
  assert.equal((await store.get(schedule.scheduleId))?.nextRunAt, '2026-11-26T12:01:00.000Z');

  clock.advance(60_000);
  await engine.tick();
  const parked = await store.get(schedule.scheduleId);
  assert.equal(parked?.state, 'active');
  assert.ok(
    parked?.nextRunAt !== null && parked.nextRunAt > '2026-11-27T00:00:00.000Z',
    'the schedule is parked past the day after the refusal budget is spent',
  );

  await engine.tick();
  executions = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(executions.filter((entry) => entry.state === 'refused').length, 2);
});

test('the daily limit parks the schedule instead of creating a receipt storm', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: NOW,
    timing: { kind: 'interval', everySeconds: 60 },
    limits: { maxRunsPerDay: 1 },
  });
  await store.create(schedule);
  await store.createExecution(
    executionRecord(schedule, {
      executionId: 'exe_earlier',
      executionKey: 'earlier',
      createdAt: '2026-11-26T11:00:00.000Z',
      state: 'completed',
    }),
  );
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock });

  const report = await engine.tick();
  assert.equal(report.refused, 1);
  assert.equal(port.calls.length, 0);
  const parked = await store.get(schedule.scheduleId);
  assert.equal(parked?.state, 'active');
  // The interval grid is anchored at 12:00, so the first occurrence strictly
  // after the next UTC midnight is 00:01.
  assert.equal(parked?.nextRunAt, '2026-11-27T00:01:00.000Z');

  // A further tick on the same day must not create another refusal receipt.
  await engine.tick();
  assert.equal((await store.listExecutions(schedule.scheduleId, 10)).length, 2);
});

test('a monitor whose condition is unmet completes without notifying', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    timing: { kind: 'once', at: NOW },
    nextRunAt: NOW,
    condition: { kind: 'result_contains', text: 'ALERT' },
  });
  await store.create(schedule);
  const port = testPort();
  const notices = createScheduleNoticeStore();
  const clock = testClock(NOW);
  const engine = engineFor({ store, notices, port: port.port, clock: clock.clock });

  await engine.tick();
  const taskId = port.calls[0]?.taskId as string;
  port.snapshots.set(taskId, {
    state: 'completed',
    summary: 'Everything is within range.',
    failure: null,
  });
  await engine.tick();

  const execution = (await store.listExecutions(schedule.scheduleId, 10))[0];
  assert.equal(execution?.state, 'completed');
  assert.equal(execution?.condition, 'unmet');
  assert.equal((await notices.list(OWNER, 10)).unread, 0);
});

test('the daily window starts at UTC midnight', () => {
  assert.equal(
    utcDayStart(new Date('2026-11-26T23:59:59.000Z')).toISOString(),
    '2026-11-26T00:00:00.000Z',
  );
});
