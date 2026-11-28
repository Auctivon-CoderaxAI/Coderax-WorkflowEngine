import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createCapabilityBroker } from '../../src/permissions/grants.js';
import { createExecutionSupervisor } from '../../src/execution/supervisor.js';
import type { ExecutionIdentity } from '../../src/execution/identity.js';
import { createUnavailableIsolationProvider } from '../../src/execution/termination.js';
import { createExecutionRepository } from '../../src/persistence/executions.js';
import { createToolRuntime } from '../../src/tools/runtime.js';
import type { Tool } from '../../src/tools/types.js';
import { scopedChildEnvironment } from '../../src/security/environment.js';
import { createIdGenerator } from '../../src/support/clock.js';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

function supervisorHarness() {
  const now = new Date('2026-11-26T12:00:00.000Z');
  const clock = { now: () => now, iso: () => now.toISOString() };
  const capabilities = createCapabilityBroker();
  const supervisor = createExecutionSupervisor({
    clock,
    ids: createIdGenerator(),
    executions: createExecutionRepository(),
    capabilities,
    isolation: createUnavailableIsolationProvider('No deployment workload isolation is configured.'),
    containmentHoldMs: 60_000,
    shutdownGraceMs: 20,
    heartbeatIntervalMs: 1_000,
  });
  return { supervisor, capabilities, clock };
}

function chatIdentity(): ExecutionIdentity {
  return {
    executionId: 'exec_chat',
    kind: 'chat',
    taskId: null,
    conversationId: 'conv_chat',
    ownerId: 'owner_1',
    tenantId: null,
    agent: 'coderax',
    mode: 'cloud',
    generation: 0,
    token: null,
  };
}

test('a revoked execution can start no further tool call', async () => {
  const capabilities = createCapabilityBroker();
  const now = new Date('2026-11-26T12:00:00.000Z');
  capabilities.issue({
    grantId: 'grant_1',
    executionId: 'exec_1',
    scopes: [{ scope: 'workspace.write', resource: '/work/cloud' }],
    now,
    ttlMs: 60_000,
  });
  let calls = 0;
  const tool: Tool = {
    name: 'probe.write',
    description: 'Writes one file.',
    source: 'builtin',
    scopes: ['workspace.write'],
    approval: 'never',
    parameters: { path: 'string' },
    schema: z.object({ path: z.string() }).strict(),
    resource: (input) => (input as { path: string }).path,
    run: async () => {
      calls += 1;
      return { ok: true, output: 'written' };
    },
  };
  const runtime = createToolRuntime({ tools: [tool] });

  const call = () =>
    runtime.call({
      name: 'probe.write',
      arguments: { path: 'report.txt' },
      context: {
        ownerId: 'owner_1',
        taskId: null,
        agent: 'coderax',
        mode: 'cloud',
        workspaceRoot: '/work/cloud',
        signal: new AbortController().signal,
        callId: 'call_1',
        guard: {
          executionId: 'exec_1',
          live: () => capabilities.isLive('exec_1'),
          permits: (scope, resource) =>
            capabilities.authorize({ executionId: 'exec_1', scope, resource, now }) === 'permitted',
          recordUse: () => undefined,
        },
      },
      gate: { ensure: async () => ({ decision: 'granted' as const }) },
    });

  const before = await call();
  assert.equal(before.result.ok, true);
  assert.equal(calls, 1);

  capabilities.revoke('exec_1', now);
  const after = await call();
  assert.equal(after.result.ok, false);
  assert.equal(calls, 1);
});

test('a tool cannot escape the granted root even with a relative traversal', async () => {
  const capabilities = createCapabilityBroker();
  const now = new Date('2026-11-26T12:00:00.000Z');
  capabilities.issue({
    grantId: 'grant_1',
    executionId: 'exec_1',
    scopes: [{ scope: 'workspace.write', resource: '/work/cloud' }],
    now,
    ttlMs: 60_000,
  });
  let calls = 0;
  const runtime = createToolRuntime({
    tools: [
      {
        name: 'probe.write',
        description: 'Writes one file.',
        source: 'builtin',
        scopes: ['workspace.write'],
        approval: 'never',
        parameters: { path: 'string' },
        schema: z.object({ path: z.string() }).strict(),
        resource: (input) => (input as { path: string }).path,
        run: async () => {
          calls += 1;
          return { ok: true, output: 'written' };
        },
      },
    ],
  });

  const outcome = await runtime.call({
    name: 'probe.write',
    arguments: { path: '../../../etc/passwd' },
    context: {
      ownerId: 'owner_1',
      taskId: null,
      agent: 'coderax',
      mode: 'cloud',
      workspaceRoot: '/work/cloud',
      signal: new AbortController().signal,
      callId: 'call_1',
      guard: {
        executionId: 'exec_1',
        live: () => capabilities.isLive('exec_1'),
        permits: (scope, resource) =>
          capabilities.authorize({ executionId: 'exec_1', scope, resource, now }) === 'permitted',
        recordUse: () => undefined,
      },
    },
    gate: { ensure: async () => ({ decision: 'granted' as const }) },
  });

  assert.equal(outcome.result.ok, false);
  assert.equal(calls, 0);
});

test('child processes never inherit the engine environment', () => {
  const parent = {
    PATH: '/bin',
    HOME: '/home/owner',
    CODERAX_OWNER_TOKEN: 'owner-secret',
    CODERAX_INFERENCE_KEY: 'inference-secret',
    CODERAX_MONGODB_URI: 'mongodb://secret',
    NODE_OPTIONS: '--require evil',
  } satisfies NodeJS.ProcessEnv;

  const baseline = scopedChildEnvironment({ parent });
  assert.equal(baseline.PATH, '/bin');
  assert.equal(baseline.HOME, '/home/owner');
  assert.equal(baseline.CODERAX_OWNER_TOKEN, undefined);
  assert.equal(baseline.CODERAX_INFERENCE_KEY, undefined);
  assert.equal(baseline.CODERAX_MONGODB_URI, undefined);
  assert.equal(baseline.NODE_OPTIONS, undefined);

  const allowed = scopedChildEnvironment({ parent, allow: ['CODERAX_MCP_PUBLIC'] });
  assert.equal(allowed.CODERAX_MCP_PUBLIC, undefined);

  const withAllow = scopedChildEnvironment({
    parent: { ...parent, CODERAX_MCP_PUBLIC: 'public-value' },
    allow: ['CODERAX_MCP_PUBLIC'],
  });
  assert.equal(withAllow.CODERAX_MCP_PUBLIC, 'public-value');
  assert.equal(withAllow.CODERAX_OWNER_TOKEN, undefined);
});

test('an external workload is never reported as verified-terminated', async () => {
  const h = supervisorHarness();
  const result = await h.supervisor.run({
    identity: { ...chatIdentity(), agent: 'opencode', kind: 'work' },
    adapter: { agent: 'opencode', workload: 'external' },
    workspaceRoot: '/work/cloud',
    scopes: ['workspace.read'],
    launch: async () => ({ outcome: { kind: 'completed', summary: 'answered remotely' } }),
  });

  assert.ok(result.admitted);
  if (!result.admitted) return;
  assert.equal(result.termination.kind, 'unverified');
  if (result.termination.kind !== 'unverified') return;
  assert.equal(result.termination.reason, 'workload_isolation_unavailable');
  assert.equal(result.workspaceHeld, true);
});

test('the isolation report claims no syscall sandbox or cross-replica containment', () => {
  const h = supervisorHarness();
  const report = h.supervisor.isolation();

  const byName = new Map(report.capabilities.map((capability) => [capability.name, capability]));
  assert.equal(byName.get('cross-replica-containment')?.status, 'unavailable');
  assert.equal(byName.get('process')?.status, 'bounded');
  assert.equal(byName.get('filesystem')?.status, 'bounded');
  assert.equal(byName.get('credentials')?.status, 'enforced');
  assert.equal(byName.get('workload')?.status, 'unavailable');
  assert.equal(report.provider.available, false);
  assert.match(report.detail, /process-local/);
});

test('a Chat turn runs under the supervisor rather than calling the adapter directly', async () => {
  const started = await startTestApp();
  try {
    const supervisor = started.app.dependencies.supervisor;
    const original = supervisor.run;
    const observed: string[] = [];
    supervisor.run = async (input) => {
      observed.push(`${input.identity.kind}:${input.identity.taskId ?? 'none'}`);
      return original(input);
    };

    const reply = await started.app.service.chat(principal, {
      message: 'Hello',
      mode: 'cloud',
      agent: 'coderax',
    });

    assert.equal(reply.ok, true);
    assert.deepEqual(observed, ['chat:none']);
    // The chat identity is durable and closed, not merely a request-scoped one.
    assert.equal(supervisor.isolation().activeExecutions, 0);
  } finally {
    await started.close();
  }
});

test('the owner token is never exposed to a supervised child environment', () => {
  const env = scopedChildEnvironment();
  assert.equal(env.CODERAX_OWNER_TOKEN, undefined);
  assert.ok(OWNER_TOKEN.length > 0);
});
