import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenCodeHttpTransport } from '../../src/agents/adapters/opencode.js';
import type { AgentReportEvent, AgentRunRequest } from '../../src/agents/types.js';

function request(): AgentRunRequest {
  return {
    ownerId: 'owner-test',
    tenantId: null,
    conversationId: 'conv-test',
    workload: 'work',
    game: null,
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
  // The session is deleted after the run so the server does not accumulate them.
  assert.ok(calls.some((call) => call.startsWith('DELETE ')));
});

for (const failure of ['session response lost', 'message response lost', 'message HTTP 500'] as const) {
  test(`OpenCode does not signal safe retry when ${failure}`, async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(init?.method ?? 'GET');
      if (String(input).endsWith('/session')) {
        if (failure === 'session response lost') throw new Error('connection lost');
        return Response.json({ id: 'session-1' });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (failure === 'message response lost') throw new Error('connection lost');
      return new Response(null, { status: 500 });
    };
    const transport = createOpenCodeHttpTransport({ baseURL: 'http://127.0.0.1:4096', fetchImpl });
    const result = await transport.run(request(), () => undefined);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.retryable, false);
    assert.match(!result.ok ? result.detail : '', /before retrying/);
    assert.deepEqual(calls, failure === 'session response lost' ? ['POST'] : ['POST', 'POST', 'DELETE']);
  });
}
