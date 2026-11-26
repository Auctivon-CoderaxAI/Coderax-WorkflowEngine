import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalAgentAdapter } from '../../src/agents/adapters/external.js';
import type { ExternalAgentTransport } from '../../src/agents/adapters/external.js';
import { createNativeAgent } from '../../src/agents/native/agent.js';
import type { ModelGateway } from '../../src/agents/native/types.js';
import { probeAgents } from '../../src/agents/probe.js';

const capabilities = {
  streaming: true,
  tools: true,
  cancellation: true,
  resume: false,
  modelSelection: true,
  durable: true,
} as const;

function gateway(): ModelGateway {
  return { id: 'test', complete: async () => ({ text: 'ok' }) };
}

function transport(probe: () => Promise<void>): ExternalAgentTransport {
  return {
    probe,
    run: async () => ({ ok: true, summary: 'ran' }),
  };
}

function external(agentTransport: ExternalAgentTransport | null) {
  return createExternalAgentAdapter({
    agent: 'opencode',
    engine: 'opencode',
    label: 'OpenCode Agent',
    enabled: true,
    transport: agentTransport,
    missingDetail: 'needs a transport',
    capabilities,
  });
}

test('native reports readiness from its configuration, without spending a request', async () => {
  const unconfigured = createNativeAgent({ enabled: true, gateway: null });
  const probe = await unconfigured.probe?.();
  assert.equal(probe?.ok, false);
  assert.match(probe?.detail ?? '', /No zero-cost inference endpoint/);

  const configured = createNativeAgent({ enabled: true, gateway: gateway() });
  assert.deepEqual(await configured.probe?.(), {
    ok: true,
    detail: 'Coderax Native is ready.',
  });
});

test('an external agent probe reflects the transport and updates its availability', async () => {
  const healthy = external(transport(async () => undefined));
  assert.equal((await healthy.probe?.())?.ok, true);
  assert.equal(healthy.availability().reason, 'ready');

  const failing = external(
    transport(async () => {
      throw new Error('connection refused');
    }),
  );
  const probe = await failing.probe?.();
  assert.equal(probe?.ok, false);
  assert.equal(failing.availability().reason, 'server_unavailable');

  const missing = external(null);
  const missingProbe = await missing.probe?.();
  assert.equal(missingProbe?.ok, false);
  assert.equal(missingProbe?.detail, 'needs a transport');
});

test('the aggregate probe names the agent that failed', async () => {
  const report = await probeAgents({
    adapters: [
      createNativeAgent({ enabled: true, gateway: gateway() }),
      external(
        transport(async () => {
          throw new Error('connection refused');
        }),
      ),
    ],
    timeoutMs: 100,
  });
  assert.equal(report.status, 'failed');
  assert.match(report.detail, /opencode/);
});

test('the aggregate probe passes when every admitted agent answers', async () => {
  const report = await probeAgents({
    adapters: [createNativeAgent({ enabled: true, gateway: gateway() })],
    timeoutMs: 100,
  });
  assert.equal(report.status, 'ok');
  assert.match(report.detail, /1 available agent/);
});

test('a probe that never answers is bounded rather than hanging health', async () => {
  const report = await probeAgents({
    adapters: [external(transport(() => new Promise(() => undefined)))],
    timeoutMs: 20,
  });
  assert.equal(report.status, 'failed');
  assert.match(report.detail, /did not answer in time/);
});

test('no admitted agent is reported instead of passing silently', async () => {
  const report = await probeAgents({
    adapters: [createNativeAgent({ enabled: true, gateway: null })],
    timeoutMs: 20,
  });
  assert.equal(report.status, 'failed');
  assert.match(report.detail, /No agent is available/);
});
