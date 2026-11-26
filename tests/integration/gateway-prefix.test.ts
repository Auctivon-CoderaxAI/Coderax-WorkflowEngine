import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, fakeGateway, startTestApp, waitFor } from '../helpers.js';

/**
 * The Coderax gateway mounting topology, against the genuine engine.
 *
 * Coderax mounts its authenticated gateway at `/api/gateway` and forwards
 * `/api/gateway/v1/...` to the engine, replacing the browser session with the
 * engine's owner credential. This suite reproduces exactly that boundary — prefix,
 * bearer translation, SSE pass-through — and drives it with the shared SDK, so
 * the SDK is proven to work behind the gateway's base path rather than only at
 * the engine root.
 *
 * It is not a claim that Coderax's Express handlers ran: this proxy is the
 * topology, not their code. Their handlers still have to consume `@coderax/sdk`
 * and pass their own suite; the reconciliation report records that as an open
 * item.
 */

const SESSION_TOKEN = 'gateway-session-token-0123456789';

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startGatewayProxy(input: {
  engineUrl: string;
}): Promise<{
  url: string;
  forwarded: string[];
  close: () => Promise<void>;
}> {
  const forwarded: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = request.url ?? '';
      if (!url.startsWith('/api/gateway/')) {
        response.writeHead(404).end();
        return;
      }
      const authorization = request.headers.authorization ?? '';
      if (authorization !== `Bearer ${SESSION_TOKEN}`) {
        response.writeHead(401, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ code: 'unauthorized', status: 401, title: 'Unauthorized' }));
        return;
      }
      const target = new URL(
        url.slice('/api/gateway'.length),
        input.engineUrl.endsWith('/') ? input.engineUrl : `${input.engineUrl}/`,
      );
      const headers: Record<string, string> = {
        accept: String(request.headers.accept ?? 'application/json'),
        authorization: `Bearer ${OWNER_TOKEN}`,
        host: new URL(input.engineUrl).host,
      };
      if (request.headers['content-type']) {
        headers['content-type'] = String(request.headers['content-type']);
      }
      if (request.headers['last-event-id']) {
        headers['last-event-id'] = String(request.headers['last-event-id']);
      }
      forwarded.push(headers.authorization);
      const body = await readBody(request);
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key !== 'content-encoding' && key !== 'transfer-encoding') responseHeaders[key] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) {
        response.end();
        return;
      }
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    forwarded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the shared SDK drives every gateway surface through /api/gateway over real HTTP', async () => {
  const engine = await startTestApp({ gateway: fakeGateway({ text: 'Gateway answer.' }) });
  const proxy = await startGatewayProxy({ engineUrl: engine.url });
  try {
    const api = new CoderaxClient({
      baseUrl: `${proxy.url}/api/gateway`,
      token: SESSION_TOKEN,
    });

    const handshake = await api.negotiate();
    assert.equal(handshake.contractVersion, '1.1.0');
    assert.equal(handshake.capabilities.chatStreaming.state, 'available');

    const accepted = await api.submitWork({
      objective: 'A task submitted through the gateway prefix',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    const completed = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(completed.state, 'completed');

    const tasks = await api.tasks({ state: 'completed' });
    assert.equal(tasks.total, 1);

    const frames = [];
    for await (const frame of api.chatStream({
      message: 'Stream through the gateway.',
      mode: 'cloud',
      agent: 'coderax',
    })) {
      frames.push(frame);
    }
    assert.equal(frames.at(-1)?.type, 'chat.completed');

    const replay = await api.openEvents(accepted.taskId, { after: 0 });
    const seen: string[] = [];
    for await (const event of replay.events) {
      seen.push(event.type);
      if (event.type === 'task.completed') break;
    }
    assert.ok(seen.includes('task.completed'));

    const artifact = await api.uploadArtifact(accepted.taskId, {
      path: 'gateway/result.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('through the gateway').toString('base64'),
    });
    const content = await api.artifactContent(artifact.artifactId);
    assert.equal(Buffer.from(content.contentBase64, 'base64').toString('utf8'), 'through the gateway');

    await api.putMemory({ key: 'gateway', value: 'verified', mode: 'private' });
    assert.ok((await api.memory('private')).entries.some((entry) => entry.key === 'gateway'));

    const marked = await api.markNotificationsRead([accepted.taskId]);
    assert.equal(marked.unread, 0);

    assert.ok(proxy.forwarded.length > 0);
    assert.ok(
      proxy.forwarded.every((value) => value === `Bearer ${OWNER_TOKEN}`),
      'the browser session token must never be forwarded to the engine',
    );

    const anonymous = await fetch(`${proxy.url}/api/gateway/v1/tasks`);
    assert.equal(anonymous.status, 401);

    const outside = await fetch(`${proxy.url}/v1/tasks`, {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    });
    assert.equal(outside.status, 404, 'the gateway exposes only its versioned prefix');

    await assert.rejects(
      () => api.task('task_missing_from_the_engine'),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );
  } finally {
    await proxy.close();
    await engine.close();
  }
});
