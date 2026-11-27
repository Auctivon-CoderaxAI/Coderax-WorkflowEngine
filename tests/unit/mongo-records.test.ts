import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeDatabase } from '../fakes/mongo.js';
import {
  createMongoPermissionTable,
  ensurePermissionIndexes,
} from '../../src/persistence/mongo-records.js';
import {
  createMongoScheduleRepository,
  ensureScheduleIndexes,
} from '../../src/persistence/mongo-schedules.js';
import {
  createMongoTaskRepository,
  ensureTaskIndexes,
} from '../../src/persistence/mongo-tables.js';
import type { ScheduleRecord } from '../../src/domain.js';
import { taskRecord } from '../helpers.js';

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = '2026-11-26T12:00:00.000Z';

  return {
    scheduleId: 'sch_1',
    ownerId: 'owner-test',
    name: 'Scheduled verification',
    objective: 'Do the scheduled thing',
    agent: 'coderax',
    mode: 'cloud',
    model: {
      providerId: 'free',
      modelId: 'coderax-small',
    },
    requireApproval: true,
    state: 'active',
    timing: {
      kind: 'once',
      at: '2026-11-26T12:01:00.000Z',
    },
    condition: { kind: 'always' },
    retry: {
      maxAttempts: 1,
      delaySeconds: 60,
    },
    priority: 5,
    limits: {
      maxRunsPerDay: 24,
      maxRunsTotal: 1,
    },
    missedRunPolicy: 'skip',
    createdAt: now,
    updatedAt: now,
    nextRunAt: '2026-11-26T12:01:00.000Z',
    lastRunAt: null,
    lastExecutionId: null,
    runsTotal: 0,
    consecutiveFailures: 0,
    version: 1,
    pausedAt: null,
    cancelledAt: null,
    cancelReason: null,
    ...overrides,
  };
}

async function scheduleRepository() {
  const database = createFakeDatabase();

  const schedules = database.collection('schedules');
  const executions = database.collection('schedule_executions');
  const notices = database.collection('schedule_notices');

  await ensureScheduleIndexes({
    schedules,
    executions,
    notices,
  });

  return createMongoScheduleRepository({
    schedules,
    executions,
  });
}

test('the durable permission table scopes decisions to the owning task', async () => {
  const database = createFakeDatabase();
  const collection = database.collection('permissions');

  await ensurePermissionIndexes(collection);

  const table = createMongoPermissionTable(collection);

  const row = {
    requestId: 'req_1',
    taskId: 'task_1',
    agent: 'coderax' as const,
    scope: 'workspace.read' as const,
    description: 'Read a file',
    resource: 'release-notes.md',
    requestedAt: '2026-11-26T12:00:00.000Z',
    expiresAt: '2026-11-26T12:10:00.000Z',
    decision: 'pending' as const,
    ownerId: 'owner-test',
    binding: 'test-action-binding',
    consumed: false,
  };

  await table.insert(row);

  assert.equal((await table.listPending('owner-test')).length, 1);
  assert.equal((await table.listPending('someone-else')).length, 0);

  const refused = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'someone-else',
    taskId: 'task_1',
    decision: 'approved',
    decidedAt: '2026-11-26T12:01:00.000Z',
  });

  assert.equal(refused, null);

  const wrongTask = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'owner-test',
    taskId: 'task_other',
    decision: 'approved',
    decidedAt: '2026-11-26T12:01:00.000Z',
  });

  assert.equal(wrongTask, null);

  const decided = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    decision: 'approved',
    decidedAt: '2026-11-26T12:01:00.000Z',
  });

  assert.equal(decided?.decision, 'approved');
  assert.equal((await table.listPending('owner-test')).length, 0);

  const second = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    decision: 'denied',
    decidedAt: '2026-11-26T12:02:00.000Z',
  });

  assert.equal(second, null);
});

test('durable schedules enforce due ordering and version-fenced updates', async () => {
  const repository = await scheduleRepository();

  assert.equal((await repository.create(schedule({
    scheduleId: 'sch_late',
    nextRunAt: '2026-11-26T12:05:00.000Z',
  }))).ok, true);

  assert.equal((await repository.create(schedule({
    scheduleId: 'sch_early',
    nextRunAt: '2026-11-26T12:02:00.000Z',
  }))).ok, true);

  assert.equal((await repository.create(schedule({
    scheduleId: 'sch_settled',
    state: 'exhausted',
    nextRunAt: null,
  }))).ok, true);

  const due = await repository.listDue({
    now: '2026-11-26T12:03:00.000Z',
    limit: 10,
  });

  assert.deepEqual(
    due.map((entry) => entry.scheduleId),
    ['sch_early'],
  );

  const updated = await repository.update({
    scheduleId: 'sch_early',
    expectedVersion: 1,
    patch: {
      state: 'exhausted',
      nextRunAt: null,
      lastExecutionId: 'execution_1',
      runsTotal: 1,
    },
  });

  assert.equal(updated.applied, true);
  assert.equal(updated.schedule?.version, 2);

  const stored = await repository.get('sch_early');

  assert.equal(stored?.lastExecutionId, 'execution_1');
  assert.equal(stored?.state, 'exhausted');

  const stale = await repository.update({
    scheduleId: 'sch_early',
    expectedVersion: 1,
    patch: { state: 'active' },
  });

  assert.equal(stale.applied, false);
  assert.equal(
    (await repository.get('sch_early'))?.state,
    'exhausted',
  );

  assert.equal(
    (await repository.listByOwner('owner-test')).length,
    3,
  );

  assert.equal(
    (await repository.listByOwner('another-owner')).length,
    0,
  );
});

test('durable schedule capacity cannot exceed its configured bound', async () => {
  const repository = await scheduleRepository();

  const reservation = {
    generation: 1,
    limit: 2,
    now: '2026-11-26T12:00:00.000Z',
    leaseUntil: '2026-11-26T12:10:00.000Z',
  };

  const results = await Promise.all([
    repository.reserveCapacity({
      ...reservation,
      executionId: 'execution_a',
    }),
    repository.reserveCapacity({
      ...reservation,
      executionId: 'execution_b',
    }),
    repository.reserveCapacity({
      ...reservation,
      executionId: 'execution_c',
    }),
  ]);

  assert.equal(results.filter((entry) => entry.ok).length, 2);
  assert.equal(results.filter((entry) => !entry.ok).length, 1);
  assert.equal(await repository.countCapacity(), 2);

  const refused = await repository.reserveCapacity({
    ...reservation,
    executionId: 'execution_over',
  });

  assert.deepEqual(refused, {
    ok: false,
    reason: 'full',
  });

  const held = results.find((entry) => entry.ok);
  assert.ok(held && held.ok);

  const duplicate = await repository.reserveCapacity({
    ...reservation,
    executionId: held.reservation.executionId,
  });

  assert.deepEqual(duplicate, {
    ok: false,
    reason: 'exists',
  });

  assert.equal(
    await repository.releaseCapacity(held.reservation.executionId),
    'released',
  );

  assert.equal(await repository.countCapacity(), 1);

  const replacement = await repository.reserveCapacity({
    ...reservation,
    executionId: 'execution_replacement',
  });

  assert.equal(replacement.ok, true);
  assert.equal(await repository.countCapacity(), 2);
});

test('durable tasks refuse duplicate identities and concurrent conversation runs', async () => {
  const database = createFakeDatabase();
  const tasks = database.collection('tasks');

  await ensureTaskIndexes(tasks);

  const repository = createMongoTaskRepository(tasks);

  const first = taskRecord({
    taskId: 'task_first',
    conversationId: 'conv_a',
    ownerId: 'owner-test',
    runToken: 'run-1',
    state: 'running',
  });

  assert.equal((await repository.create(first)).ok, true);

  const duplicate = await repository.create(first);

  assert.deepEqual(duplicate, {
    ok: false,
    reason: 'exists',
  });

  const conflicting = taskRecord({
    taskId: 'task_second',
    conversationId: 'conv_a',
    ownerId: 'owner-test',
    runToken: 'run-2',
  });

  assert.deepEqual(
    await repository.create(conflicting),
    {
      ok: false,
      reason: 'conversation_busy',
    },
  );

  assert.equal(await repository.get('task_second'), null);

  const otherOwner = taskRecord({
    taskId: 'task_other_owner',
    conversationId: 'conv_b',
    ownerId: 'another-owner',
    runToken: 'run-3',
  });

  assert.equal((await repository.create(otherOwner)).ok, true);

  const owned = await repository.listByOwner('owner-test');

  assert.deepEqual(
    owned.map((entry) => entry.taskId),
    ['task_first'],
  );

  const other = await repository.listByOwner('another-owner');

  assert.deepEqual(
    other.map((entry) => entry.taskId),
    ['task_other_owner'],
  );
});
