import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentAdapter } from '../../src/agents/types.js';
import { createTaskRunner } from '../../src/execution/runner.js';
import { workRunKey } from '../../src/execution/lease.js';
import type { LeaseStore } from '../../src/execution/lease.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../../src/persistence/work-runs.js';
import { createMongoTaskRepository } from '../../src/persistence/mongo-tables.js';
import { createClock } from '../../src/support/clock.js';
import { createFakeDatabase } from '../fakes/mongo.js';
import { startTestApp, taskRecord } from '../helpers.js';

test('two replicas cannot both reissue the same generation', async () => {
  const database = createFakeDatabase();
  const collection = database.collection('tasks');
  const first = createMongoTaskRepository(collection);
  const second = createMongoTaskRepository(collection);
  const task = taskRecord({
    taskId: 'task_race',
    conversationId: 'conv_race',
    state: 'interrupted',
    generation: 1,
    runToken: 'token-old',
  });
  await first.create(task);

  const [a, b] = await Promise.all([
    first.reissue({
      taskId: task.taskId,
      token: 'token-a',
      now: '2026-11-26T00:00:01.000Z',
      leaseExpiresAt: '2026-11-26T00:00:31.000Z',
      from: ['interrupted'],
    }),
    second.reissue({
      taskId: task.taskId,
      token: 'token-b',
      now: '2026-11-26T00:00:01.000Z',
      leaseExpiresAt: '2026-11-26T00:00:31.000Z',
      from: ['interrupted'],
    }),
  ]);
  assert.equal([a.applied, b.applied].filter(Boolean).length, 1);
  const stored = await first.get(task.taskId);
  assert.ok(stored);
  assert.equal(stored.generation, 2);
  assert.ok(stored.runToken === 'token-a' || stored.runToken === 'token-b');

  const stale = await second.updateFenced({
    taskId: task.taskId,
    token: 'token-old',
    patch: { state: 'completed' },
  });
  assert.deepEqual(stale, { applied: false, reason: 'superseded' });
});

test('a lease takeover fences the previous owner out', async () => {
  const lease = createLeaseStore(createInMemoryWorkRunTable());
  const key = workRunKey({ ownerId: 'owner', tenantId: null, conversationId: 'conv' });
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  assert.equal(
    await lease.claim({
      key,
      owner: 'owner',
      token: 'first',
      now: t0,
      expiresAt: new Date(t0.getTime() + 1_000),
    }),
    true,
  );
  assert.equal(
    await lease.claim({
      key,
      owner: 'owner',
      token: 'second',
      now: new Date(t0.getTime() + 2_000),
      expiresAt: new Date(t0.getTime() + 30_000),
    }),
    true,
  );
  assert.deepEqual(
    await lease.renew({
      key,
      token: 'first',
      now: new Date(t0.getTime() + 2_000),
      expiresAt: new Date(t0.getTime() + 30_000),
    }),
    { renewed: false, cancelRequested: false },
  );
});

test('a crash retires a running task as interrupted and a resume gets a new generation', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const key = workRunKey({
      ownerId: 'owner-test',
      tenantId: null,
      conversationId: 'conv_crash',
    });
    const now = deps.clock.now();
    await deps.lease.claim({
      key,
      owner: 'owner-test',
      token: 'dead-token',
      now,
      expiresAt: new Date(now.getTime() - 1),
    });
    await deps.tasks.create(
      taskRecord({
        taskId: 'task_crash',
        conversationId: 'conv_crash',
        state: 'running',
        runToken: 'dead-token',
        leaseExpiresAt: new Date(now.getTime() - 1).toISOString(),
      }),
    );

    const retired = await started.app.service.recoverInterrupted();
    assert.equal(retired.interrupted, 1);
    const interrupted = await deps.tasks.get('task_crash');
    assert.equal(interrupted?.state, 'interrupted');

    const resumed = await started.app.service.resumeTask(
      { ownerId: 'owner-test', isOwner: true },
      'task_crash',
      1,
    );
    assert.equal(resumed.ok, true);
    assert.equal(resumed.ok && resumed.value.outcome, 'accepted');
    await deps.scheduler.idle();

    const completed = await deps.tasks.get('task_crash');
    assert.equal(completed?.state, 'completed');
    assert.equal(completed?.generation, 2);

    const staleWrite = await deps.tasks.updateFenced({
      taskId: 'task_crash',
      token: 'dead-token',
      patch: { state: 'failed' },
    });
    assert.deepEqual(staleWrite, { applied: false, reason: 'superseded' });
  } finally {
    await started.close();
  }
});

test('a cancellation that races the start is honored, not ignored', async () => {
  let observedAbort = false;
  const lease: LeaseStore = {
    claim: async () => true,
    renew: async () => ({ renewed: true, cancelRequested: false }),
    release: async () => true,
    cancel: async () => 'requested',
    read: async () => null,
    prune: async () => 0,
  };
  const adapter: AgentAdapter = {
    agent: 'coderax',
    engine: 'native',
    sideEffects: 'none',
    capabilities: {
      streaming: true,
      tools: false,
      cancellation: true,
      resume: true,
      modelSelection: true,
      durable: true,
    },
    isolation: {
      workspace: 'isolated',
      memory: 'granted',
      credentials: 'none',
      conversations: 'granted',
    },
    availability: () => ({ available: true, reason: 'ready', detail: 'ready' }),
    run: async (request) => {
      observedAbort = request.signal.aborted;
      return { ok: false, code: 'cancelled', detail: 'already aborted', retryable: false };
    },
  };
  const external = new AbortController();
  external.abort();
  const runner = createTaskRunner({
    lease,
    clock: createClock(),
    leaseTtlMs: 3_000,
    heartbeatIntervalMs: 1_000,
    cleanupGraceMs: 20,
  });
  const result = await runner.run({
    scope: { ownerId: 'owner', tenantId: null, conversationId: 'conv' },
    token: 'token',
    adapter,
    request: {
      ownerId: 'owner',
      tenantId: null,
      conversationId: 'conv',
      workload: 'work',
      game: null,
      objective: 'race',
      model: { providerId: 'free', modelId: 'coderax-small' },
      mode: 'cloud',
      routing: 'auto',
      allowFallback: true,
      operation: 'work',
      workspaceRoot: '/tmp',
      maxSteps: 1,
      budget: null,
      signal: external.signal,
    },
    report: () => undefined,
  });
  assert.equal(observedAbort, false, 'an already-cancelled run must not reach the adapter');
  assert.deepEqual(result, { outcome: { kind: 'cancelled' }, ownershipLost: false, terminated: true });
});
