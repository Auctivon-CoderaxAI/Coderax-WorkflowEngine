import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentAdapter, AgentRunRequest } from '../../src/agents/types.js';
import { createTaskRunner } from '../../src/execution/runner.js';
import type { LeaseStore } from '../../src/execution/lease.js';
import { createClock } from '../../src/support/clock.js';

const scope = { ownerId: 'owner', tenantId: null, conversationId: 'conversation' };

const lease = {
  renew: async () => ({ renewed: true, cancelRequested: false }),
  release: async () => true,
  read: async () => null,
} as unknown as LeaseStore;

function request(signal: AbortSignal): AgentRunRequest {
  return {
    ownerId: 'owner',
    tenantId: null,
    conversationId: 'conversation',
    objective: 'stop',
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
      modelSelection: false,
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

function runner(cleanupGraceMs = 5_000) {
  return createTaskRunner({
    lease,
    clock: createClock(),
    leaseTtlMs: 3_000,
    heartbeatIntervalMs: 1_000,
    cleanupGraceMs,
  });
}

test('an adapter that throws on abort is cancelled, not reported as a provider failure', async () => {
  const external = new AbortController();
  const running = runner().run({
    scope,
    token: 'token',
    adapter: adapter(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    ),
    request: request(external.signal),
    report: () => undefined,
    generation: 1,
    workspaceRoot: '/tmp',
  });
  setTimeout(() => external.abort(), 5);
  assert.deepEqual(await running, {
    outcome: { kind: 'cancelled' },
    ownershipLost: false,
  });
});

test('a report delivered after the abort never reaches the caller', async () => {
  const external = new AbortController();
  const received: string[] = [];
  let late: (() => void) | null = null;
  const running = runner(50).run({
    scope,
    token: 'token',
    adapter: adapter(
      (input, report) =>
        new Promise(() => {
          late = () => report({ type: 'text.delta', text: 'stale' });
          input.signal.addEventListener('abort', () => late?.(), { once: true });
        }),
    ),
    request: request(external.signal),
    report: (event) => {
      if (event.type === 'text.delta') received.push(event.text);
    },
    generation: 1,
    workspaceRoot: '/tmp',
  });
  setTimeout(() => external.abort(), 5);
  const result = await running;
  assert.deepEqual(result.outcome.kind, 'cancelled');
  assert.deepEqual(received, []);
});
