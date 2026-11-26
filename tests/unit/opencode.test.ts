import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeHttpTransport } from '../../src/agents/adapters/opencode.js';
import type { ExternalAgentTransport } from '../../src/agents/adapters/external.js';
import type { AgentReportEvent, AgentRunRequest } from '../../src/agents/types.js';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { EngineConfigSchema } from '../../src/configuration/schema.js';
import { baseConfig, createWorkspaces, OWNER_TOKEN } from '../helpers.js';

function request(): AgentRunRequest {
  return {
    ownerId: 'owner-test',
    tenantId: null,
    conversationId: 'conv-test',
    objective: 'Explain the change',
    model: { providerId: 'free', modelId: 'coderax-small' },
    mode: 'cloud',
    workspaceRoot: '',
    maxSteps: 1,
    budget: null,
    signal: new AbortController().signal,
  };
}

test('the OpenCode transport creates a session, sends the objective and reads its answer', async () => {
  const calls: string[] = [];
  let sentModel: unknown = null;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    assert.ok(!String(init?.body).includes('earlier private message'));
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/app')) return new Response('ok', { status: 200 });
    if (url.endsWith('/session')) {
      return new Response(JSON.stringify({ id: 'session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/session/session-1/message')) {
      sentModel = (JSON.parse(String(init?.body)) as { model?: unknown }).model;
      return new Response(
        JSON.stringify({ parts: [{ type: 'text', text: 'OpenCode result.' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const transport = createOpenCodeHttpTransport({
    baseURL: 'http://127.0.0.1:4096',
    fetchImpl,
  });
  await transport.probe();

  const events: AgentReportEvent[] = [];
  const outcome = await transport.run({ ...request(), history: [{ role: 'user', text: 'earlier private message' }] }, (event) => events.push(event));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.summary, 'OpenCode result.');
  assert.deepEqual(
    events.map((event) => event.type),
    ['step.started', 'text.delta', 'step.completed'],
  );
  assert.ok(calls.some((call) => call.startsWith('POST ') && call.endsWith('/session')));
  assert.ok(calls.some((call) => call.includes('/session/session-1/message')));
  assert.deepEqual(sentModel, { providerID: 'free', modelID: 'coderax-small' });
  // The session is deleted after the run so the server does not accumulate them.
  assert.ok(calls.some((call) => call.startsWith('DELETE ')));
});

test('an OpenCode model is validated without a Native inference gateway', async () => {
  const workspace = createWorkspaces();
  const transport: ExternalAgentTransport = {
    probe: async () => undefined,
    run: async () => ({ ok: true, summary: 'unused' }),
  };
  try {
    const config = EngineConfigSchema.parse(
      baseConfig(workspace, {
        engines: { opencode: { enabled: true, model: 'free/coderax-small' } },
      }),
    );
    const app = await composeApplication({
      config,
      env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
      // No Native gateway: catalogue membership and cost are what matter for
      // this preference. Readiness is checked separately when a run resolves.
      gateway: null,
      externals: { opencode: transport },
    });
    try {
      assert.equal(
        app.dependencies.models.verify({ providerId: 'free', modelId: 'coderax-small' }).ok,
        true,
        'the configured free model is in the verified catalogue',
      );
      assert.equal(app.dependencies.agents.get('opencode')?.availability().available, true);
    } finally {
      await app.stop();
    }
  } finally {
    workspace.cleanup();
  }
});
