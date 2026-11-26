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
  previewOccurrences,
  utcDayStart,
  zonedWallTimeToInstant,
} from '../../src/scheduling/calendar.js';
import { scheduleSideEffectRefusal } from '../../src/scheduling/policy.js';
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
      recoverHandoff: async () => {},
      claimScheduledRetry: async (id, gen) => snapshots.get(id)?.generation === gen,
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

test('durable capacity admits one run across replicas and quarantines before reuse', async () => {
  const store = createScheduleRepository();
  const first = scheduleRecord({ scheduleId: 'sch_first', nextRunAt: NOW });
  const second = scheduleRecord({ scheduleId: 'sch_second', nextRunAt: NOW });
  await store.create(first);
  await store.create(second);
  const port = testPort();
  const clock = testClock();
  const a = engineFor({ store, port: port.port, clock: clock.clock, settings: { maxConcurrentRuns: 1 } });
  const b = engineFor({ store, port: port.port, clock: clock.clock, settings: { maxConcurrentRuns: 1 } });

  await Promise.all([a.tick(), b.tick()]);
  assert.equal(port.calls.length, 1, 'one durable slot admits one occurrence');
  assert.equal(await store.countCapacity(), 1);

  // A second admission cannot use the slot while the first run is live.
  const blocked = await store.reserveCapacity({
    executionId: 'exe_blocked',
    generation: 1,
    limit: 1,
    leaseUntil: '2026-11-26T12:01:00.000Z',
    now: NOW,
  });
  assert.deepEqual(blocked, { ok: false, reason: 'full' });
});

test('the capacity ledger holds an expired slot until it is released', async () => {
  const store = createScheduleRepository();
  const reserved = await store.reserveCapacity({
    executionId: 'exe_live',
    generation: 3,
    limit: 1,
    leaseUntil: '2026-11-26T12:01:00.000Z',
    now: NOW,
  });
  assert.equal(reserved.ok, true);
  assert.deepEqual(
    await store.reserveCapacity({
      executionId: 'exe_live',
      generation: 4,
      limit: 1,
      leaseUntil: '2026-11-26T12:02:00.000Z',
      now: NOW,
    }),
    { ok: false, reason: 'exists' },
  );
  assert.equal(
    await store.renewCapacity({
      executionId: 'exe_live',
      leaseUntil: '2026-11-26T12:05:00.000Z',
    }),
    true,
  );
  assert.equal(await store.quarantineExpiredCapacity('2026-11-26T12:04:00.000Z'), 0);
  assert.equal(await store.quarantineExpiredCapacity('2026-11-26T12:06:00.000Z'), 1);

  // Quarantine is not capacity: an expired lease cannot authorize another run.
  assert.equal(await store.countCapacity(), 1);
  assert.deepEqual(
    (await store.listQuarantinedCapacity()).map((slot) => slot.executionId),
    ['exe_live'],
  );
  assert.equal(
    (
      await store.reserveCapacity({
        executionId: 'exe_other',
        generation: 1,
        limit: 1,
        leaseUntil: '2026-11-26T12:07:00.000Z',
        now: NOW,
      })
    ).ok,
    false,
  );

  assert.equal(await store.releaseCapacity('exe_live'), 'released');
  assert.equal(await store.releaseCapacity('exe_live'), 'absent');
  assert.equal(await store.countCapacity(), 0);
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
  port.snapshots.set(execution?.taskId as string, { generation: 1,
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

  port.snapshots.set(retried?.taskId as string, { generation: 1,
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
  port.snapshots.set(taskId, { generation: 1,
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
  port.snapshots.set(taskId, { generation: 1,
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
  port.snapshots.set(taskId, { generation: 1,
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

test('hourly rules fire at the wall-clock minute and never duplicate the repeated hour', () => {
  const timing: ScheduleTiming = { kind: 'hourly', timeZone: 'America/New_York', minute: 30 };
  const createdAt = new Date('2026-01-01T00:00:00.000Z');

  // 01:45 EST on the spring-forward day: 02:30 does not exist, so the rule
  // resolves to the first real instant at or after it (03:30 EDT, 07:30Z).
  assert.equal(
    nextOccurrence(timing, new Date('2026-03-08T06:45:00.000Z'), createdAt)?.toISOString(),
    '2026-03-08T07:30:00.000Z',
  );
  assert.equal(
    nextOccurrence(timing, new Date('2026-03-08T07:30:00.000Z'), createdAt)?.toISOString(),
    '2026-03-08T08:30:00.000Z',
  );

  // On the fall-back day 01:30 occurs twice; the rule resolves one instant and
  // the next call strictly advances, so one wall time is never run twice.
  const first = nextOccurrence(timing, new Date('2026-11-01T04:00:00.000Z'), createdAt);
  const second = nextOccurrence(timing, first ?? new Date(), createdAt);
  assert.ok(first && second);
  assert.ok((second?.getTime() ?? 0) > (first?.getTime() ?? 0));
});

test('monthly rules keep their wall-clock time across a DST change', () => {
  const winter: ScheduleTiming = {
    kind: 'monthly',
    timeZone: 'America/New_York',
    dayOfMonth: 15,
    hour: 9,
    minute: 0,
  };
  assert.equal(
    nextOccurrence(winter, new Date('2026-11-26T12:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))
      ?.toISOString(),
    '2026-12-15T14:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(winter, new Date('2026-12-15T14:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))
      ?.toISOString(),
    '2027-01-15T14:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(winter, new Date('2026-06-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))
      ?.toISOString(),
    '2026-06-15T13:00:00.000Z',
  );
});

test('a preview is pure, bounded and stops when the rule has no next instant', () => {
  const hourly = scheduleRecord({
    timing: { kind: 'interval', everySeconds: 3_600, anchor: NOW },
  });
  assert.deepEqual(previewOccurrences(hourly, new Date(NOW), 3), [
    '2026-11-26T13:00:00.000Z',
    '2026-11-26T14:00:00.000Z',
    '2026-11-26T15:00:00.000Z',
  ]);

  const once = scheduleRecord({ timing: { kind: 'once', at: '2026-11-27T09:00:00.000Z' } });
  assert.deepEqual(previewOccurrences(once, new Date(NOW), 5), ['2026-11-27T09:00:00.000Z']);

  const event = scheduleRecord({ timing: { kind: 'event', event: 'deploy.finished' } });
  assert.deepEqual(previewOccurrences(event, new Date(NOW), 5), []);
});

test('replicas with skewed clocks still dispatch one occurrence', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ nextRunAt: '2026-11-26T12:00:00.000Z' });
  await store.create(schedule);
  const notices = createScheduleNoticeStore();
  const fastPort = testPort();
  const slowPort = testPort();
  const fast = engineFor({
    store,
    notices,
    port: fastPort.port,
    clock: testClock('2026-11-26T12:00:00.500Z').clock,
  });
  const slow = engineFor({
    store,
    notices,
    port: slowPort.port,
    clock: testClock('2026-11-26T11:59:59.500Z').clock,
  });

  await Promise.all([fast.tick(), slow.tick()]);
  assert.equal(fastPort.calls.length + slowPort.calls.length, 1);
  assert.equal((await store.listExecutions(schedule.scheduleId, 10)).length, 1);
});

test('a crash during dispatch leaves one receipt and recovers to one task', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ nextRunAt: NOW });
  await store.create(schedule);
  const port = testPort();
  let attempts = 0;
  port.port.dispatch = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('database connection reset');
    return { ok: true };
  };
  const clock = testClock(NOW);
  const engine = engineFor({
    store,
    port: port.port,
    clock: clock.clock,
    // Recovery waits for the dispatch window to expire, so the test advances
    // past it instead of re-submitting on the very next tick.
    settings: { dispatchTimeoutMs: 100 },
  });

  await assert.rejects(engine.tick(), /database connection reset/);
  const claimed = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.state, 'claimed', 'the receipt survives the crash');

  // The next tick reconciles the abandoned receipt and re-submits the same
  // deterministic task id; the duplicate does not create a second task.
  clock.advance(200);
  await engine.tick();
  assert.equal(attempts, 2);
  const recovered = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, 'dispatched');
  assert.equal(
    (await store.get(schedule.scheduleId))?.runsTotal,
    1,
    'recovery accounts the run once, so a total limit still bounds it',
  );
});

test('a transient store failure is reported and the next tick still runs', async () => {
  const store = createScheduleRepository();
  let fail = true;
  const flaky = {
    ...store,
    listDue: async (input: { now: string; limit: number }) => {
      if (fail) {
        fail = false;
        throw new Error('database unavailable');
      }
      return store.listDue(input);
    },
  };
  const clock = testClock(NOW);
  const engine = engineFor({ store: flaky, port: testPort().port, clock: clock.clock });

  await assert.rejects(engine.tick(), /database unavailable/);
  assert.match(engine.lastTick().error ?? '', /database unavailable/);
  const report = await engine.tick();
  assert.equal(report.due, 0);
  assert.equal(engine.lastTick().error, null);
});

test('an interrupted attempt is resumable, not replayed as a new task', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({
    nextRunAt: NOW,
    retry: { maxAttempts: 3, delaySeconds: 0 },
  });
  await store.create(schedule);
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock });

  await engine.tick();
  const taskId = port.calls[0]?.taskId as string;
  port.snapshots.set(taskId, { generation: 1,
    state: 'interrupted',
    summary: null,
    // Orchestration marks an interrupted run retryable so Work resume is
    // allowed; that is not an adapter confirmation that replay is safe.
    failure: { code: 'cancelled', retryable: true },
  });
  await engine.tick();

  const [execution] = await store.listExecutions(schedule.scheduleId, 10);
  assert.equal(execution?.state, 'failed');
  assert.equal(execution?.taskId, taskId, 'the resumable task keeps its receipt link');
  assert.match(execution?.detail ?? '', /resumable/);
  assert.equal(execution?.attempt, 1, 'no new attempt was started');

  // A further tick must not dispatch a replacement task.
  clock.advance(1_000);
  await engine.tick();
  assert.equal(port.calls.length, 1);
  assert.equal((await store.listExecutions(schedule.scheduleId, 10)).length, 1);
});

test('an adapter with ungated side effects is refused for a schedule', () => {
  assert.match(scheduleSideEffectRefusal('ungated') ?? '', /not gated by owner approval/);
  assert.equal(scheduleSideEffectRefusal('none'), null);
  assert.equal(scheduleSideEffectRefusal('gated'), null);
});

test('a fresh claim and a retry compete atomically for the last slot', async () => {
  const collections = { schedules: createFakeCollection(), executions: createFakeCollection(), notices: createFakeCollection() };
  await ensureScheduleIndexes(collections);
  for (const store of [createScheduleRepository(), createMongoScheduleRepository(collections)]) {
    const fresh = executionRecord(scheduleRecord(), { state: 'claimed' });
    const retry = { ...fresh, executionKey: 'retry', executionId: 'retry', scheduleId: 'other', attempt: 2 };
    await store.createExecution({ ...retry, state: 'retry_wait' });
    const results = await Promise.all([store.claim(fresh, 1, false), store.claim(retry, 1, true)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await store.countActive(), 1);
    const winner = results[0] ? fresh : retry;
    await store.updateExecution({ executionId: winner.executionId, from: ['claimed'], patch: { state: 'completed' } });
    assert.ok(await store.claim(results[0] ? retry : fresh, 1, !!results[0]));
  }
});

test('a recent retry claim retains its recovery window after a long backoff', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ nextRunAt: null });
  await store.create(schedule);
  const createdAt = '2026-11-26T11:58:00.000Z';
  await store.createExecution(executionRecord(schedule, {
    createdAt, updatedAt: NOW, state: 'claimed', taskId: 'task_retry', attempt: 2,
  }));
  const port = testPort();
  const clock = testClock(NOW);
  const engine = engineFor({ store, port: port.port, clock: clock.clock, settings: { dispatchTimeoutMs: 100 } });
  await engine.tick();
  assert.equal(port.calls.length, 0);
  clock.advance(150);
  await engine.tick();
  assert.equal(port.calls.length, 1);
  assert.equal((await store.listExecutions(schedule.scheduleId, 1))[0]?.createdAt, createdAt);
});

test('a delayed advance preserves a newer cursor or timing revision', async () => {
  for (const timingEdit of [false, true]) {
    const store = createScheduleRepository();
    const schedule = scheduleRecord();
    await store.create(schedule);
    const cursor = timingEdit ? NOW : '2026-11-26T13:00:00.000Z';
    const port = testPort();
    port.port.dispatch = async () => {
      await store.update({ scheduleId: schedule.scheduleId, expectedVersion: 0, patch: {
        nextRunAt: cursor, ...(timingEdit ? { timingRevision: 1 } : {}),
      } });
      return { ok: true };
    };
    await engineFor({ store, port: port.port, clock: testClock().clock }).tick();
    assert.equal((await store.get(schedule.scheduleId))?.nextRunAt, cursor);
  }
});

test('a stale limit decision cannot exhaust a schedule whose cap was raised', async () => {
  const store = createScheduleRepository();
  const stale = scheduleRecord({ limits: { maxRunsTotal: 1, maxRunsPerDay: 24 }, runsTotal: 1 });
  await store.create({ ...stale, limits: { ...stale.limits, maxRunsTotal: 2 } });
  const engine = engineFor({ store, port: testPort().port, clock: testClock().clock });
  const dispatch = await engine.trigger({ schedule: stale, trigger: 'manual', occurrenceKey: 'manual:1' });
  assert.equal(dispatch.state, 'dispatched');
  assert.equal((await store.get(stale.scheduleId))?.state, 'active');
});

test('a refusal on retry survives a notice outage and never schedules another attempt', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ nextRunAt: null });
  await store.create(schedule);
  const receipt = executionRecord(schedule, {
    state: 'retry_wait', attempt: 2, taskId: 'task_retry', nextAttemptAt: NOW,
  });
  await store.createExecution(receipt);
  const notices = createScheduleNoticeStore();
  const record = notices.record;
  notices.record = async notice => {
    await record(notice);
    throw new Error('notice acknowledgement lost');
  };
  const port = testPort();
  let submissions = 0;
  port.port.dispatch = async () => {
    submissions++;
    return { ok: false, reason: 'refused', detail: 'Agent unavailable' };
  };
  const engine = engineFor({ store, notices, port: port.port, clock: testClock().clock });
  await assert.rejects(engine.tick(), /acknowledgement lost/);
  assert.equal((await store.getExecution(receipt.executionId))?.state, 'refused');
  notices.record = record;
  await engine.tick();
  await engine.tick();
  assert.equal(submissions, 1);
  assert.equal((await notices.list(OWNER, 5)).notifications.length, 1);
  assert.equal((await store.pendingNotices(10)).length, 0);
});

test('stop waits for a direct tick and prevents another pass', async () => {
  const store = createScheduleRepository();
  let release!: () => void;
  let passes = 0;
  store.pendingNotices = async () => {
    passes++;
    await new Promise<void>(resolve => { release = resolve; });
    return [];
  };
  const engine = engineFor({ store, clock: testClock().clock, port: testPort().port });
  const tick = engine.tick();
  let stopped = false;
  const stopping = engine.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stopping]);
  await engine.tick();
  assert.equal(passes, 1);
});

test('a second replica preserves the cursor while the first owns the due claim', async () => {
  const store = createScheduleRepository();
  const schedule = scheduleRecord({ timing: { kind: 'once', at: NOW } });
  await store.create(schedule);
  const port = testPort();
  const clock = testClock().clock;
  const replica = engineFor({ store, clock, port: testPort().port });
  port.port.dispatch = async () => {
    await replica.tick();
    assert.equal((await store.get(schedule.scheduleId))?.nextRunAt, NOW);
    return { ok: true };
  };
  await engineFor({ store, port: port.port, clock }).tick();
  assert.equal((await store.get(schedule.scheduleId))?.state, 'exhausted');
  assert.equal((await store.get(schedule.scheduleId))?.runsTotal, 1);
});

test('reconciliation accounts landed Work once and refuses stale attempt writes', async () => {
  const collections = { schedules: createFakeCollection(), executions: createFakeCollection(), notices: createFakeCollection() };
  await ensureScheduleIndexes(collections);
  for (const store of [createScheduleRepository(), createMongoScheduleRepository(collections)]) {
    const schedule = scheduleRecord({ nextRunAt: null });
    await store.create(schedule);
    const receipt = executionRecord(schedule, { state: 'claimed', taskId: 'first' });
    await store.claim(receipt, 1, false);
    const port = testPort();
    port.snapshots.set('first', { generation: 1, state: 'running', summary: null, failure: null });
    const engine = engineFor({ store, port: port.port, clock: testClock().clock });
    await engine.tick();
    await engine.tick();
    assert.equal((await store.get(schedule.scheduleId))?.runsTotal, 1);
    await store.updateExecution({ executionId: receipt.executionId, from: ['dispatched'],
      patch: { taskId: 'second', attempt: 2 } });
    const stale = await store.updateExecution({ executionId: receipt.executionId, from: ['dispatched'],
      observed: receipt, patch: { state: 'retry_wait' } });
    assert.equal(stale, null);
    assert.equal((await store.getExecution(receipt.executionId))?.state, 'dispatched');
  }
});

test('future backoffs cannot crowd a due retry out of the batch', async () => {
  const collections = { schedules: createFakeCollection(), executions: createFakeCollection(), notices: createFakeCollection() };
  await ensureScheduleIndexes(collections);
  for (const store of [createScheduleRepository(), createMongoScheduleRepository(collections)]) {
    for (const [key, nextAttemptAt] of [['future', '2099-01-01T00:00:00.000Z'], ['due', NOW]] as const) {
      await store.createExecution(executionRecord(scheduleRecord(), {
        executionKey: key, executionId: key, state: 'retry_wait', nextAttemptAt,
      }));
    }
    assert.deepEqual((await store.dueRetries(NOW, 1)).map(record => record.executionId), ['due']);
  }
});

test('admission and expiry exclude one another, even when a retry reuses its task id', async () => {
  const collections = { schedules: createFakeCollection(), executions: createFakeCollection(), notices: createFakeCollection() };
  await ensureScheduleIndexes(collections);
  for (const store of [createScheduleRepository(), createMongoScheduleRepository(collections)]) {
    const old = executionRecord(scheduleRecord(), { state: 'claimed', attempt: 2, taskId: 'same', claimGeneration: 1 });
    await store.claim(old, 1, false);
    const wait = await store.updateExecution({ executionId: old.executionId, from: ['claimed'], observed: old,
      patch: { state: 'retry_wait' } });
    assert.ok(wait);
    const claim = await store.claim({ ...wait, state: 'claimed' }, 1, true);
    assert.ok(claim);
    const expire = (observed: ScheduleExecutionRecord) => store.updateExecution({ executionId: old.executionId,
      beforeAdmission: true, observed, from: ['claimed'], patch: { state: 'missed' } });
    assert.equal(await expire(old), null);
    assert.ok(await store.updateExecution({ executionId: old.executionId, from: ['claimed'],
      observed: claim.execution, patch: { admissionStarted: true } }));
    assert.equal(await expire(claim.execution), null);
  }
});

test('a recovered failure pauses once even when accounting committed before acknowledgement', async () => {
  for (const committed of [false, true]) {
    const store = createScheduleRepository();
    const schedule = scheduleRecord({ nextRunAt: null });
    const receipt = executionRecord(schedule, { state: 'failed', noticePending: true, failureAccountingPending: true });
    await store.create(committed ? { ...schedule, state: 'paused', consecutiveFailures: 1, accountedFailures: [receipt.executionId] } : schedule);
    await store.createExecution(receipt);
    const engine = engineFor({ store, port: testPort().port, clock: testClock().clock, settings: { pauseAfterFailures: 1 } });
    await engine.tick();
    await engine.tick();
    assert.equal((await store.get(schedule.scheduleId))?.consecutiveFailures, 1);
    assert.equal((await store.get(schedule.scheduleId))?.state, 'paused');
    assert.equal((await store.getExecution(receipt.executionId))?.noticePending, false);
  }
});
