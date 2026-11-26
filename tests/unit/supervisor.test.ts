import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityBroker } from '../../src/execution/capabilities.js';
import type { ExecutionIdentity } from '../../src/execution/identity.js';
import { createExecutionSupervisor } from '../../src/execution/supervisor.js';
import { createUnavailableIsolationProvider } from '../../src/execution/termination.js';
import { createExecutionRepository } from '../../src/persistence/executions.js';
import {
  createInMemoryQuarantineTable,
  createQuarantineStore,
} from '../../src/persistence/quarantine.js';
import { createIdGenerator } from '../../src/support/clock.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');

function identity(executionId: string, generation = 1): ExecutionIdentity {
  return {
    executionId,
    kind: 'work',
    taskId: 'task_supervisor',
    conversationId: 'conv_supervisor',
    ownerId: 'owner-test',
    tenantId: null,
    agent: 'coderax',
    mode: 'cloud',
    generation,
    token: 'run_token',
  };
}

function createSupervisor(
  shared: {
    executions?: ReturnType<typeof createExecutionRepository>;
    quarantine?: ReturnType<typeof createQuarantineStore>;
  } = {},
) {
  const clock = { now: () => NOW, iso: () => NOW.toISOString() };
  const executions = shared.executions ?? createExecutionRepository();
  const quarantine =
    shared.quarantine ??
    createQuarantineStore({
      table: createInMemoryQuarantineTable(),
      ttlMs: 1_000,
    });
  const supervisor = createExecutionSupervisor({
    clock,
    ids: createIdGenerator(),
    executions,
    quarantine,
    capabilities: createCapabilityBroker(),
    isolation: createUnavailableIsolationProvider('No workload isolation in this test.'),
    containmentHoldMs: 1_000,
    shutdownGraceMs: 50,
    heartbeatIntervalMs: 60_000,
  });
  return { supervisor, executions, quarantine };
}

test('an execution identity is admitted once, even if the same attempt is retried', async () => {
  const { supervisor } = createSupervisor();
  let launches = 0;
  const run = () =>
    supervisor.run({
      identity: identity('exec_once'),
      adapter: { agent: 'coderax' },
      workspaceRoot: '/srv/cloud',
      scopes: ['workspace.write'],
      launch: async () => {
        launches += 1;
        return { outcome: { kind: 'completed' as const, summary: 'done' } };
      },
    });
  const first = await run();
  const second = await run();
  assert.equal(first.admitted, true);
  assert.equal(second.admitted, false);
  assert.equal(second.admitted === false && second.code, 'execution_duplicate');
  assert.equal(launches, 1, 'a duplicate identity must not reach the adapter');
});

test('an abandoned execution holds its root on every supervisor that shares the store', async () => {
  const first = createSupervisor();
  // A second process: its own supervisor maps, the same durable stores.
  const second = createSupervisor({
    executions: first.executions,
    quarantine: first.quarantine,
  });
  const abandoned = await first.supervisor.run({
    identity: identity('exec_abandoned'),
    adapter: { agent: 'coderax' },
    workspaceRoot: '/srv/cloud',
    scopes: ['workspace.write'],
    launch: async () => ({
      outcome: { kind: 'cancelled' as const, abandoned: true },
      abandoned: true,
    }),
  });
  assert.equal(abandoned.admitted, true);
  assert.equal(abandoned.admitted && abandoned.termination.kind, 'unverified');
  assert.equal(abandoned.admitted && abandoned.workspaceHeld, true);

  // The second supervisor is a different process with its own maps; only the
  // shared quarantine row can refuse the root.
  const refused = await second.supervisor.run({
    identity: identity('exec_replacement'),
    adapter: { agent: 'coderax' },
    workspaceRoot: '/srv/cloud',
    scopes: ['workspace.write'],
    launch: async () => {
      throw new Error('the adapter must not run in a held workspace');
    },
  });
  assert.equal(refused.admitted, false);
  assert.equal(refused.admitted === false && refused.code, 'workspace_denied');

  await second.quarantine.release('/srv/cloud');
  const admitted = await second.supervisor.run({
    identity: identity('exec_after_release'),
    adapter: { agent: 'coderax' },
    workspaceRoot: '/srv/cloud',
    scopes: ['workspace.write'],
    launch: async () => ({ outcome: { kind: 'completed' as const, summary: 'ok' } }),
  });
  assert.equal(admitted.admitted, true);
});

test('a stale attempt is retired and its workspace is quarantined durably', async () => {
  const { supervisor, executions, quarantine } = createSupervisor();
  await executions.create({
    ...identity('exec_stale'),
    workspaceRoot: '/srv/private',
    phase: 'starting',
    cause: null,
    startedAt: '2026-11-26T11:00:00.000Z',
    lastHeartbeatAt: '2026-11-26T11:00:00.000Z',
    finishedAt: null,
    termination: null,
    capabilityRevokedAt: null,
    processUseCount: 0,
  });
  assert.equal(await supervisor.retireStale(1_000), 1);
  const record = await executions.get('exec_stale');
  assert.equal(record?.cause, 'interrupted');
  assert.equal(record?.termination?.status, 'unverified');
  const held = await quarantine.find('/srv/private', NOW.getTime());
  assert.equal(held?.reason, 'process_stopped_heartbeating');
});
