import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionScope } from '@coderax/contracts';
import { createCapabilityBroker } from '../../src/execution/capabilities.js';
import { createExecutionSupervisor } from '../../src/execution/supervisor.js';
import type { SupervisionLaunch } from '../../src/execution/supervisor.js';
import type { ExecutionIdentity, ExecutionRecord } from '../../src/execution/identity.js';
import { createUnavailableIsolationProvider } from '../../src/execution/termination.js';
import { createExecutionRepository } from '../../src/persistence/executions.js';
import { createIdGenerator } from '../../src/support/clock.js';

function harness(options: { holdMs?: number; graceMs?: number } = {}) {
  let nowMs = Date.parse('2026-11-26T12:00:00.000Z');
  const clock = {
    now: () => new Date(nowMs),
    iso: () => new Date(nowMs).toISOString(),
  };
  const executions = createExecutionRepository();
  const capabilities = createCapabilityBroker();
  const supervisor = createExecutionSupervisor({
    clock,
    ids: createIdGenerator(),
    executions,
    capabilities,
    isolation: createUnavailableIsolationProvider('No deployment workload isolation is configured.'),
    containmentHoldMs: options.holdMs ?? 60_000,
    shutdownGraceMs: options.graceMs ?? 20,
    heartbeatIntervalMs: 1_000,
  });
  return {
    supervisor,
    executions,
    capabilities,
    clock,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function identity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    executionId: `exec_${Math.random().toString(16).slice(2)}`,
    kind: 'work',
    taskId: 'task_1',
    conversationId: 'conv_1',
    ownerId: 'owner_1',
    tenantId: null,
    agent: 'coderax',
    mode: 'cloud',
    generation: 1,
    token: 'run_1',
    ...overrides,
  };
}

const SCOPES: readonly PermissionScope[] = ['workspace.read', 'workspace.write'];

test('an execution is recorded durably and its capability is revoked when it ends', async () => {
  const h = harness();
  const id = identity();
  const result = await h.supervisor.run({
    identity: id,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
  });

  assert.equal(result.admitted, true);
  if (!result.admitted) return;
  assert.equal(result.cause, 'completed');
  assert.equal(result.termination.kind, 'verified');

  const stored = await h.executions.get(id.executionId);
  assert.ok(stored);
  assert.equal(stored.phase, 'finished');
  assert.equal(stored.cause, 'completed');
  assert.equal(stored.termination?.status, 'verified');
  assert.ok(stored.capabilityRevokedAt);

  assert.equal(h.capabilities.isLive(id.executionId), false);
  assert.equal(
    h.capabilities.authorize({
      executionId: id.executionId,
      scope: 'workspace.write',
      resource: '/work/cloud/report.txt',
      now: h.clock.now(),
    }),
    'revoked',
  );
});

test('a granted resource is resolved, so a relative tool path inside the root is permitted', () => {
  const capabilities = createCapabilityBroker();
  const now = new Date('2026-11-26T12:00:00.000Z');
  capabilities.issue({
    grantId: 'grant_1',
    executionId: 'exec_1',
    scopes: [{ scope: 'workspace.write', resource: '/work/cloud' }],
    now,
    ttlMs: 60_000,
  });

  const decide = (resource: string) =>
    capabilities.authorize({ executionId: 'exec_1', scope: 'workspace.write', resource, now });

  assert.equal(decide('report.txt'), 'permitted');
  assert.equal(decide('/work/cloud/nested/report.txt'), 'permitted');
  assert.equal(decide('../../etc/passwd'), 'not-granted');
  assert.equal(decide('/work/cloud-evil/report.txt'), 'not-granted');
});

test('a superseded generation cannot make another tool call', async () => {
  const h = harness();
  const first = identity({ executionId: 'exec_first', generation: 1, token: 'run_1' });
  const second = identity({ executionId: 'exec_second', generation: 2, token: 'run_2' });

  let releaseFirst: (() => void) | undefined;
  const firstRun = h.supervisor.run({
    identity: first,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async (execution) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      assert.equal(execution.guard.live(), false);
      assert.equal(execution.guard.permits('workspace.write', 'report.txt'), false);
      return { outcome: { kind: 'cancelled' } };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondRun = await h.supervisor.run({
    identity: second,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'replacement' } }),
  });

  assert.equal(secondRun.admitted, true);
  if (!secondRun.admitted) return;
  assert.equal(secondRun.cause, 'completed');

  releaseFirst?.();
  const abandoned = await firstRun;
  assert.equal(abandoned.admitted, true);
  if (!abandoned.admitted) return;
  assert.equal(abandoned.cause, 'interrupted');
  assert.equal(
    (await h.executions.get('exec_first'))?.cause,
    'interrupted',
  );
});

test('cancellation and interruption are recorded as different causes', async () => {
  const h = harness();
  const cancelled = identity({ executionId: 'exec_a', conversationId: 'conv_a' });
  const interrupted = identity({ executionId: 'exec_b', conversationId: 'conv_b' });

  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;

  const runA = h.supervisor.run({
    identity: cancelled,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/a',
    scopes: SCOPES,
    launch: async () =>
      new Promise<SupervisionLaunch>((resolve) => {
        releaseA = () => resolve({ outcome: { kind: 'cancelled' } });
      }),
  });
  const runB = h.supervisor.run({
    identity: interrupted,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/b',
    scopes: SCOPES,
    launch: async () =>
      new Promise<SupervisionLaunch>((resolve) => {
        releaseB = () => resolve({ outcome: { kind: 'cancelled' } });
      }),
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.supervisor.cancel('exec_a', 'owner changed their mind'), true);
  assert.equal(h.supervisor.interrupt('exec_b'), true);
  releaseA?.();
  releaseB?.();

  const [a, b] = await Promise.all([runA, runB]);
  assert.ok(a.admitted && b.admitted);
  if (!a.admitted || !b.admitted) return;
  assert.equal(a.cause, 'cancelled');
  assert.equal(b.cause, 'interrupted');
});

test('shutdown aborts running executions and refuses new ones afterwards', async () => {
  const h = harness({ graceMs: 50 });
  const id = identity({ executionId: 'exec_shutdown' });

  const running = h.supervisor.run({
    identity: id,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async (execution) =>
      new Promise<SupervisionLaunch>((resolve) => {
        execution.signal.addEventListener(
          'abort',
          () => resolve({ outcome: { kind: 'cancelled' } }),
          { once: true },
        );
      }),
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const report = await h.supervisor.shutdown();
  assert.equal(report.aborted, 1);

  const result = await running;
  assert.ok(result.admitted);
  if (!result.admitted) return;
  assert.equal(result.cause, 'shutdown');
  assert.equal((await h.executions.get('exec_shutdown'))?.cause, 'shutdown');

  const refused = await h.supervisor.run({
    identity: identity({ executionId: 'exec_late' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'nope' } }),
  });
  assert.equal(refused.admitted, false);
  if (refused.admitted) return;
  assert.equal(refused.code, 'shutting_down');
});

test('an unverified termination holds the workspace root until it expires', async () => {
  const h = harness({ holdMs: 1_000 });
  const id = identity({ executionId: 'exec_spawn' });

  const result = await h.supervisor.run({
    identity: id,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: ['command.execute'],
    launch: async (execution) => {
      execution.guard.recordUse({
        scope: 'command.execute',
        resource: '*',
        spawnsProcesses: true,
      });
      return { outcome: { kind: 'completed', summary: 'ran a command' } };
    },
  });

  assert.ok(result.admitted);
  if (!result.admitted) return;
  assert.equal(result.termination.kind, 'unverified');
  assert.equal(result.workspaceHeld, true);

  const refused = await h.supervisor.run({
    identity: identity({ executionId: 'exec_next', taskId: 'task_2' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'should not run' } }),
  });
  assert.equal(refused.admitted, false);
  if (refused.admitted) return;
  assert.equal(refused.code, 'workspace_denied');

  h.advance(1_001);
  const admitted = await h.supervisor.run({
    identity: identity({ executionId: 'exec_after', taskId: 'task_3' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'safe now' } }),
  });
  assert.equal(admitted.admitted, true);
});

test('a read-only execution may share a root with an active writer', async () => {
  const h = harness();
  let releaseWriter: (() => void) | undefined;
  const writer = h.supervisor.run({
    identity: identity({ executionId: 'exec_writer' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: ['workspace.read', 'workspace.write'],
    launch: async () =>
      new Promise<SupervisionLaunch>((resolve) => {
        releaseWriter = () => resolve({ outcome: { kind: 'completed', summary: 'written' } });
      }),
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const reader = await h.supervisor.run({
    identity: identity({ executionId: 'exec_reader', kind: 'chat', taskId: null, generation: 0, token: null }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/cloud',
    scopes: ['workspace.read'],
    launch: async () => ({ outcome: { kind: 'completed', summary: 'read' } }),
  });
  assert.equal(reader.admitted, true);

  releaseWriter?.();
  const wrote = await writer;
  assert.ok(wrote.admitted);
});

test('a verified run releases its workspace root immediately', async () => {
  const h = harness();
  for (const [index, executionId] of ['exec_one', 'exec_two'].entries()) {
    const result = await h.supervisor.run({
      identity: identity({ executionId, taskId: `task_${index}` }),
      adapter: { agent: 'coderax', workload: 'in-process' },
      workspaceRoot: '/work/cloud',
      scopes: SCOPES,
      launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
    });
    assert.equal(result.admitted, true);
  }
});

test('an execution identity is unique even before the adapter starts', async () => {
  const h = harness();
  const id = identity({ executionId: 'exec_fixed' });
  const first = await h.supervisor.run({
    identity: id,
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/a',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
  });
  assert.ok(first.admitted);

  const duplicate = await h.supervisor.run({
    identity: identity({ executionId: 'exec_fixed', taskId: 'task_2' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/b',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'nope' } }),
  });
  assert.equal(duplicate.admitted, false);
  if (duplicate.admitted) return;
  assert.equal(duplicate.code, 'execution_duplicate');
});

test('a stale execution record is retired as interrupted, a fresh one is left alone', async () => {
  const h = harness();
  const stale = h.supervisor.run({
    identity: identity({ executionId: 'exec_stale' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/stale',
    scopes: SCOPES,
    launch: async (execution) => {
      // Only an abort reaches this run; it is meant to look like a dead process.
      await new Promise<void>((resolve) => {
        execution.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: { kind: 'cancelled' } };
    },
  });

  h.advance(1);
  const retired = await h.supervisor.retireStale(0);
  assert.ok(retired >= 1);
  const record = await h.executions.get('exec_stale');
  assert.equal(record?.cause, 'interrupted');
  assert.equal(record?.termination?.status, 'unverified');

  // A durable retirement cannot revoke another process's in-memory capability;
  // it records the fact instead. Only this process can revoke its own run.
  h.supervisor.interrupt('exec_stale');
  await stale;
  assert.equal(h.capabilities.isLive('exec_stale'), false);
  // The owning process unwinds after the retirement and must not overwrite it.
  assert.equal((await h.executions.get('exec_stale'))?.cause, 'interrupted');
});

test('a second writer is refused while the first admission is still being persisted', async () => {
  const clock = {
    now: () => new Date('2026-11-26T12:00:00.000Z'),
    iso: () => '2026-11-26T12:00:00.000Z',
  };
  const base = createExecutionRepository();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  // The durable write is the only await between the admission decision and the
  // point at which the execution becomes active.
  const executions = {
    ...base,
    create: async (record: ExecutionRecord) => {
      if (first) {
        first = false;
        await gate;
      }
      return base.create(record);
    },
  };
  const supervisor = createExecutionSupervisor({
    clock,
    ids: createIdGenerator(),
    executions,
    capabilities: createCapabilityBroker(),
    isolation: createUnavailableIsolationProvider('No deployment workload isolation is configured.'),
    containmentHoldMs: 60_000,
    shutdownGraceMs: 20,
    heartbeatIntervalMs: 1_000,
  });

  const firstRun = supervisor.run({
    identity: identity({ executionId: 'exec_first', token: 'run_first' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/shared',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
  });
  const second = await supervisor.run({
    identity: identity({ executionId: 'exec_second', token: 'run_second' }),
    adapter: { agent: 'coderax', workload: 'in-process' },
    workspaceRoot: '/work/shared',
    scopes: SCOPES,
    launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
  });
  assert.equal(second.admitted, false);
  if (!second.admitted) assert.equal(second.code, 'workspace_busy');

  release();
  assert.equal((await firstRun).admitted, true);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const finishFirst of [false, true]) {
  for (const createThrows of [false, true]) {
    test(`failed supersession (${createThrows ? 'throw' : 'duplicate'}) with old execution ${finishFirst ? 'settled' : 'unwinding'}`, async () => {
      const h = harness();
      const first = identity({ executionId: 'exec_old' });
      const replacement = identity({ executionId: 'exec_replacement', generation: 2 });
      const third = identity({ executionId: 'exec_other', taskId: 'task_other' });
      const createEntered = barrier();
      const failCreate = barrier();
      const finishEntered = barrier();
      const finishOld = barrier();
      const create = h.executions.create;
      const finish = h.executions.finish;
      h.executions.create = async (record) => {
        if (record.executionId !== replacement.executionId) return create(record);
        createEntered.resolve();
        await failCreate.promise;
        if (createThrows) throw new Error('storage unavailable');
        return false;
      };
      h.executions.finish = async (input) => {
        if (input.executionId === first.executionId) {
          finishEntered.resolve();
          await finishOld.promise;
        }
        return finish(input);
      };
      const run = (id: ExecutionIdentity) => h.supervisor.run({
        identity: id,
        adapter: { agent: 'coderax', workload: 'in-process' },
        workspaceRoot: '/work/cloud',
        scopes: SCOPES,
        launch: async () => ({ outcome: { kind: 'completed', summary: 'done' } }),
      });

      const oldRun = run(first);
      await finishEntered.promise;
      const newRun = run(replacement);
      await createEntered.promise;
      try {
        if (finishFirst) {
          finishOld.resolve();
          await oldRun;
        }
        failCreate.resolve();
        if (createThrows) {
          await assert.rejects(newRun, /storage unavailable/);
        } else {
          const result = await newRun;
          assert.equal(!result.admitted && result.code, 'execution_duplicate');
        }
        if (!finishFirst) {
          const result = await run(third);
          assert.equal(!result.admitted && result.code, 'workspace_busy');
        }
      } finally {
        finishOld.resolve();
        await oldRun;
      }
      assert.equal((await run(third)).admitted, true);
    });
  }
}

test('shutdown waits for a pending admission and closes it without launching', { timeout: 3_000 }, async () => {
  const h = harness({ graceMs: 1_000 });
  const id = identity();
  const creating = barrier();
  const allowCreate = barrier();
  const finishing = barrier();
  const allowFinish = barrier();
  const create = h.executions.create;
  const finish = h.executions.finish;
  h.executions.create = async (record) => {
    creating.resolve();
    await allowCreate.promise;
    return create(record);
  };
  h.executions.finish = async (patch) => {
    finishing.resolve();
    await allowFinish.promise;
    return finish(patch);
  };

  let launched = false;
  const run = h.supervisor.run({
    identity: id,
    adapter: { agent: 'opencode', workload: 'external' },
    workspaceRoot: '/work/cloud',
    scopes: SCOPES,
    launch: async () => {
      launched = true;
      return { outcome: { kind: 'completed', summary: 'done' } };
    },
  });
  await creating.promise;
  let stopped = false;
  const shutdown = h.supervisor.shutdown().then(() => { stopped = true; });
  allowCreate.resolve();
  await finishing.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(stopped, false);
    assert.equal(h.capabilities.isLive(id.executionId), false);
  } finally {
    allowFinish.resolve();
    await shutdown;
  }

  const result = await run;
  assert.equal(!result.admitted && result.code, 'shutting_down');
  assert.equal(launched, false);
  const record = await h.executions.get(id.executionId);
  assert.equal(record?.cause, 'shutdown');
  assert.equal(record?.termination?.status, 'verified');
});
