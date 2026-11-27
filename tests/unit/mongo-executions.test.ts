import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionRecord } from '../../src/execution/identity.js';
import {
  createMongoExecutionRepository,
  ensureExecutionIndexes,
} from '../../src/persistence/mongo-executions.js';
import { createFakeCollection } from '../fakes/mongo.js';

const START = '2026-11-26T12:00:00.000Z';

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: 'exec_1',
    kind: 'work',
    taskId: 'task_1',
    conversationId: 'conv_1',
    ownerId: 'owner-test',
    tenantId: null,
    agent: 'coderax',
    mode: 'cloud',
    generation: 1,
    token: 'run_1',
    workspaceRoot: '/work/cloud',
    phase: 'running',
    cause: null,
    startedAt: START,
    lastHeartbeatAt: START,
    finishedAt: null,
    termination: null,
    capabilityRevokedAt: null,
    processUseCount: 0,
    ...overrides,
  };
}

test('an execution identity is inserted once and read back', async () => {
  const collection = createFakeCollection();
  await ensureExecutionIndexes(collection);
  assert.equal(collection.indexes.filter((index) => index.options?.unique).length, 1);

  const repository = createMongoExecutionRepository(collection);
  assert.equal(await repository.create(record()), true);
  assert.equal(await repository.create(record({ taskId: 'other' })), false);

  const stored = await repository.get('exec_1');
  assert.equal(stored?.taskId, 'task_1');
  assert.equal(stored?.phase, 'running');
});

test('heartbeat is refused after the attempt is finished', async () => {
  const collection = createFakeCollection();
  const repository = createMongoExecutionRepository(collection);
  await repository.create(record());

  assert.equal(await repository.heartbeat('exec_1', '2026-11-26T12:00:05.000Z'), true);
  assert.equal(
    (await repository.get('exec_1'))?.lastHeartbeatAt,
    '2026-11-26T12:00:05.000Z',
  );

  await repository.finish({
    executionId: 'exec_1',
    cause: 'completed',
    finishedAt: '2026-11-26T12:00:10.000Z',
    capabilityRevokedAt: '2026-11-26T12:00:10.000Z',
    processUseCount: 0,
    termination: { status: 'verified', method: 'no-child-processes', observedAt: START },
  });

  assert.equal(await repository.heartbeat('exec_1', '2026-11-26T12:01:00.000Z'), false);
});

test('the first terminal cause wins over a late writer', async () => {
  const collection = createFakeCollection();
  const repository = createMongoExecutionRepository(collection);
  await repository.create(record());

  const first = await repository.finish({
    executionId: 'exec_1',
    cause: 'cancelled',
    finishedAt: '2026-11-26T12:00:10.000Z',
    capabilityRevokedAt: '2026-11-26T12:00:10.000Z',
    processUseCount: 0,
    termination: { status: 'unverified', reason: 'adapter_abandoned', observedAt: START },
  });
  assert.equal(first?.cause, 'cancelled');

  const second = await repository.finish({
    executionId: 'exec_1',
    cause: 'completed',
    finishedAt: '2026-11-26T12:00:20.000Z',
    capabilityRevokedAt: '2026-11-26T12:00:20.000Z',
    processUseCount: 0,
    termination: { status: 'verified', method: 'no-child-processes', observedAt: START },
  });
  assert.equal(second, null);
  assert.equal((await repository.get('exec_1'))?.cause, 'cancelled');
});

test('only stale attempts are retired by the startup sweep', async () => {
  const collection = createFakeCollection();
  const repository = createMongoExecutionRepository(collection);
  await repository.create(record({ executionId: 'exec_stale', startedAt: START, lastHeartbeatAt: START }));
  await repository.create(
    record({
      executionId: 'exec_fresh',
      taskId: 'task_2',
      startedAt: '2026-11-26T12:00:50.000Z',
      lastHeartbeatAt: '2026-11-26T12:00:50.000Z',
    }),
  );

  const retired = await repository.retireStale({
    before: '2026-11-26T12:00:30.000Z',
    at: '2026-11-26T12:01:00.000Z',
  });
  assert.equal(retired, 1);
  assert.equal((await repository.get('exec_stale'))?.cause, 'interrupted');
  assert.equal((await repository.get('exec_stale'))?.termination?.status, 'unverified');
  assert.equal((await repository.get('exec_fresh'))?.phase, 'running');
});

test('active and per-task queries exclude finished attempts', async () => {
  const collection = createFakeCollection();
  const repository = createMongoExecutionRepository(collection);
  await repository.create(record({ executionId: 'exec_done' }));
  await repository.create(record({ executionId: 'exec_live', taskId: 'task_2' }));
  await repository.finish({
    executionId: 'exec_done',
    cause: 'completed',
    finishedAt: '2026-11-26T12:00:10.000Z',
    capabilityRevokedAt: '2026-11-26T12:00:10.000Z',
    processUseCount: 0,
    termination: { status: 'verified', method: 'no-child-processes', observedAt: START },
  });

  assert.deepEqual((await repository.listActive()).map((entry) => entry.executionId), ['exec_live']);
  assert.deepEqual(
    (await repository.listByTask('task_1')).map((entry) => entry.executionId),
    ['exec_done'],
  );
});
