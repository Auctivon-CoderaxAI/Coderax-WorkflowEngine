import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentAdapter, AgentRunRequest } from '../../src/agents/types.js';
import type { LeaseStore } from '../../src/execution/lease.js';
import { createTaskRunner } from '../../src/execution/runner.js';
import { createClock } from '../../src/support/clock.js';

const scope = { ownerId: 'owner', tenantId: null, conversationId: 'conv' };

function lease(overrides: Partial<LeaseStore> = {}): LeaseStore {
  return {
    claim: async () => true,
    renew: async () => ({ renewed: true, cancelRequested: false }),
    release: async () => true,
    cancel: async () => 'requested',
    read: async () => null,
    prune: async () => 0,
    ...overrides,
  };
}

function request(signal: AbortSignal): AgentRunRequest {
  return {
    ownerId: 'owner',
    tenantId: null,
    conversationId: 'conv',
    objective: 'Do the work',
    model: { providerId: 'free', modelId: 'coderax-small' },
    mode: 'cloud',
    workspaceRoot: '/tmp',
    maxSteps: 1,
    budget: null,
    signal,
  };
}

function adapter(run: AgentAdapter['run']): AgentAdapter {
  return {
    agent: 'coderax',
    engine: 'native',
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
    run,
  };
}

function runnerWith(
  leaseStore: LeaseStore,
  overrides: { heartbeatIntervalMs?: number; cleanupGraceMs?: number } = {},
) {
  return createTaskRunner({
    lease: leaseStore,
    clock: createClock(),
    leaseTtlMs: 3_000,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 1_000,
    cleanupGraceMs: overrides.cleanupGraceMs ?? 40,
  });
}

test('a cancelled run stops waiting when the adapter ignores its abort', async () => {
  const runner = runnerWith(lease());
  const external = new AbortController();
  const started = Date.now();
  const running = runner.run({
    scope,
    token: 'token-1',
    adapter: adapter(() => new Promise(() => undefined)),
    request: request(external.signal),
    report: () => undefined,
  });
  setTimeout(() => external.abort(), 5);

  const result = await running;
  assert.deepEqual(result, {
    outcome: { kind: 'cancelled', abandoned: true },
    ownershipLost: false,
    terminated: false,
  });
  assert.ok(Date.now() - started < 1_000, 'the grace bound must end the wait');
});

test('an adapter that stops on abort is settled without using the grace bound', async () => {
  const runner = runnerWith(lease(), { cleanupGraceMs: 5_000 });
  const external = new AbortController();
  const running = runner.run({
    scope,
    token: 'token-1',
    adapter: adapter(
      (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => resolve({ ok: false, code: 'cancelled', detail: 'stopped', retryable: false }),
            { once: true },
          );
        }),
    ),
    request: request(external.signal),
    report: () => undefined,
  });
  setTimeout(() => external.abort(), 5);

  assert.deepEqual(await running, {
    outcome: { kind: 'cancelled' },
    ownershipLost: false,
    terminated: true,
  });
});

test('a lost lease aborts a hung adapter and settles as interrupted', async () => {
  const runner = runnerWith(
    lease({ renew: async () => ({ renewed: false, cancelRequested: false }) }),
    { heartbeatIntervalMs: 10, cleanupGraceMs: 30 },
  );
  const external = new AbortController();
  const result = await runner.run({
    scope,
    token: 'token-1',
    adapter: adapter(() => new Promise(() => undefined)),
    request: request(external.signal),
    report: () => undefined,
  });

  assert.equal(result.ownershipLost, true);
  assert.equal(result.outcome.kind, 'interrupted');
});

test('a completed run is not cut short by the grace bound', async () => {
  const runner = runnerWith(lease(), { cleanupGraceMs: 5_000 });
  const external = new AbortController();
  const result = await runner.run({
    scope,
    token: 'token-1',
    adapter: adapter(async () => ({ ok: true, summary: 'finished' })),
    request: request(external.signal),
    report: () => undefined,
  });

  assert.deepEqual(result, {
    outcome: { kind: 'completed', summary: 'finished' },
    ownershipLost: false,
    terminated: true,
  });
});
