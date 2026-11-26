import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeDatabase } from '../fakes/mongo.js';
import {
  createMongoArtifactRepository,
  createMongoPermissionTable,
  createMongoScheduleRepository,
  ensureArtifactIndexes,
  ensurePermissionIndexes,
  ensureScheduleIndexes,
} from '../../src/persistence/mongo-records.js';
import {
  createMongoTaskRepository,
  ensureIdempotencyIndexes,
  ensureTaskIndexes,
} from '../../src/persistence/mongo-tables.js';
import type { ArtifactRow, ScheduleRecord } from '../../src/domain.js';
import { MAX_ACTIVE_SCHEDULES } from '../../src/persistence/schedules.js';
import { taskRecord } from '../helpers.js';

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = '2026-11-26T12:00:00.000Z';
  return {
    scheduleId: 'sch_1',
    ownerId: 'owner-test',
    objective: 'Do the scheduled thing',
    agent: 'coderax',
    mode: 'cloud',
    model: { providerId: 'free', modelId: 'coderax-small' },
    requireApproval: true,
    budget: null,
    state: 'scheduled',
    runAt: '2026-11-26T12:01:00.000Z',
    intervalMs: null,
    createdAt: now,
    updatedAt: now,
    nextRunAt: '2026-11-26T12:01:00.000Z',
    lastTaskId: null,
    lastError: null,
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    artifactId: 'art_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    path: 'notes/release.txt',
    mediaType: 'text/plain',
    bytes: 4,
    digest: `sha256:${'0'.repeat(64)}`,
    mode: 'cloud',
    createdAt: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
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
    expected: 'pending',
    revoke: false,
  });
  assert.equal(refused, null);
  const decided = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    decision: 'approved',
    decidedAt: '2026-11-26T12:01:00.000Z',
    expected: 'pending',
    revoke: false,
  });
  assert.equal(decided?.decision, 'approved');
  assert.equal((await table.listPending('owner-test')).length, 0);
  const second = await table.updateDecision({
    requestId: 'req_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    decision: 'denied',
    decidedAt: '2026-11-26T12:02:00.000Z',
    expected: 'pending',
    revoke: false,
  });
  assert.equal(second, null, 'a decided request cannot be decided twice');
});

test('durable schedules are ordered by due time and updated under the owner', async () => {
  const database = createFakeDatabase();
  const collection = database.collection('schedules');
  await ensureScheduleIndexes(collection);
  const repository = createMongoScheduleRepository(collection);

  await repository.create(schedule({ scheduleId: 'sch_late', nextRunAt: '2026-11-26T12:05:00.000Z' }));
  await repository.create(schedule({ scheduleId: 'sch_early', nextRunAt: '2026-11-26T12:02:00.000Z' }));
  await repository.create(
    schedule({
      scheduleId: 'sch_settled',
      state: 'submitted',
      nextRunAt: '2026-11-26T11:00:00.000Z',
    }),
  );

  const due = await repository.due('2026-11-26T12:03:00.000Z', 10);
  assert.deepEqual(due.map((entry) => entry.scheduleId), ['sch_early']);

  const updated = await repository.update(
    schedule({
      scheduleId: 'sch_early',
      state: 'submitted',
      nextRunAt: null,
      lastTaskId: 'task_1',
    }),
  );
  assert.equal(updated, true);
  assert.equal((await repository.get('owner-test', 'sch_early'))?.lastTaskId, 'task_1');
  assert.equal((await repository.get('another-owner', 'sch_early')), null);
  assert.equal(
    await repository.update(schedule({ scheduleId: 'sch_early', ownerId: 'another-owner' })),
    false,
  );
});

test('a schedule owner cannot exceed the active bound', async () => {
  const database = createFakeDatabase();
  const collection = database.collection('schedules');
  await ensureScheduleIndexes(collection);
  const repository = createMongoScheduleRepository(collection);
  for (let index = 0; index < MAX_ACTIVE_SCHEDULES; index += 1) {
    assert.deepEqual(
      await repository.create(schedule({ scheduleId: `sch_${index}` })),
      { ok: true },
    );
  }
  assert.deepEqual(
    await repository.create(schedule({ scheduleId: 'sch_over' })),
    { ok: false, reason: 'limit' },
  );
  assert.equal(await repository.activeCount('owner-test'), MAX_ACTIVE_SCHEDULES);
});

test('artifact rows are durable and owner-scoped', async () => {
  const database = createFakeDatabase();
  const collection = database.collection('artifacts');
  await ensureArtifactIndexes(collection);
  const repository = createMongoArtifactRepository(collection);

  await repository.insert(artifact());
  assert.equal((await repository.get('owner-test', 'art_1'))?.path, 'notes/release.txt');
  assert.equal(await repository.get('another-owner', 'art_1'), null);
  assert.equal((await repository.list('owner-test', 'task_1')).length, 1);
  assert.equal((await repository.list('owner-test', 'task_2')).length, 0);
});

test('a repeated submission replays the first task instead of creating another', async () => {
  const database = createFakeDatabase();
  const tasks = database.collection('tasks');
  const idempotency = database.collection('idempotency');
  await ensureTaskIndexes(tasks);
  await ensureIdempotencyIndexes(idempotency);
  const repository = createMongoTaskRepository(tasks, idempotency);

  const first = taskRecord({ taskId: 'task_first', conversationId: 'conv_a', runToken: 'run-1' });
  const created = await repository.create(first, { idempotencyKey: 'submission-key-0001' });
  assert.equal(created.ok, true);

  const second = taskRecord({ taskId: 'task_second', conversationId: 'conv_b', runToken: 'run-2' });
  const replay = await repository.create(second, { idempotencyKey: 'submission-key-0001' });
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, 'idempotent');
  assert.equal(replay.ok === false && 'task' in replay ? replay.task.taskId : undefined, 'task_first');
  assert.equal(await repository.get('task_second'), null);
  assert.equal(
    (await repository.findByIdempotencyKey('owner-test', 'submission-key-0001'))?.taskId,
    'task_first',
  );

  // The same key is scoped by owner, so another owner is not replayed.
  const otherOwner = taskRecord({
    taskId: 'task_other_owner',
    conversationId: 'conv_c',
    runToken: 'run-3',
    ownerId: 'another-owner',
  });
  const other = await repository.create(otherOwner, { idempotencyKey: 'submission-key-0001' });
  assert.equal(other.ok, true);
});
