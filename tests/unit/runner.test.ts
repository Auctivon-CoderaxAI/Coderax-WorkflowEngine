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
    workload: 'work',
    game: null,
    objective: 'Do the work',
    model: { providerId: 'free', modelId: 'coderax-small' },
    reasoning: 'auto',
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

test('a pending admission check cannot start an adapter after cancellation', async () => {
  const external = new AbortController();
  let starts = 0;
  const pending = runnerWith(lease()).run({
    scope, token: 'pending', request: request(external.signal), report: () => {},
    adapter: adapter(async () => { starts++; return { ok: true, summary: '' }; }),
    cancellationRequested: () => new Promise(() => {}),
  });
  external.abort();
  assert.deepEqual(await pending, { ownershipLost: false, outcome: { kind: 'cancelled' }, terminated: true });
  assert.equal(starts, 0);
});

test('an unavailable pre-start check interrupts without starting the provider', async () => {
  const result = await runnerWith(lease()).run({
    scope, token: 'pending', request: request(new AbortController().signal), report: () => {},
    adapter: adapter(() => assert.fail('adapter started')),
    cancellationRequested: async () => { throw new Error('unavailable'); },
  });
  assert.equal(result.outcome.kind, 'interrupted');
  assert.equal(result.ownershipLost, false);
});

test('a late false admission response cannot start Work after lease loss', async () => {
  let finish!: (allowed: boolean) => void;
  const blocked = new Promise<boolean>(resolve => { finish = resolve; });
  let starts = 0;
  const result = await runnerWith(lease({ renew: async () => {
    setImmediate(() => finish(false));
    return { renewed: false, cancelRequested: false };
  } }), { heartbeatIntervalMs: 5 }).run({
    scope, token: 'retired', request: request(new AbortController().signal), report: () => {},
    adapter: adapter(async () => { starts++; return { ok: true, summary: '' }; }),
    cancellationRequested: () => blocked,
  });
  assert.equal(starts, 0);
  assert.equal(result.ownershipLost, true);
});

test('the runner renews ownership until its settlement callback finishes', async () => {
  let settling = false;
  let renewed = false;
  const runner = runnerWith(lease({ renew: async () => {
    if (settling) renewed = true;
    return { renewed: true, cancelRequested: false };
  } }), { heartbeatIntervalMs: 5 });
  await runner.run({
    scope, token: 'settling', request: request(new AbortController().signal), report: () => {},
    adapter: adapter(async () => ({ ok: true, summary: 'finished' })),
    onSettled: async () => {
      settling = true;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(renewed, 'a slow settlement keeps the conversation lease');
    },
  });
});
