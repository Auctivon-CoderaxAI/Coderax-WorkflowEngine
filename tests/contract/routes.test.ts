import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONTRACT_VERSION,
  ExecutionEvent,
  ROUTES,
  ROUTE_INDEX,
  buildOpenApiDocument,
} from '@coderax/contracts';
import {
  CoderaxApiError,
  CoderaxClient,
  CoderaxContractError,
  SDK_OPERATIONS,
} from '@coderax/sdk';
import { startTestApp } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const principalPath = (routePath: string): string =>
  routePath.replace('{taskId}', 'task_missing').replace('{conversationId}', 'conv_missing');

test('the SDK implements every catalogued operation and no phantom operation', () => {
  const catalogue = ROUTES.map((route) => route.operationId).sort();
  assert.deepEqual(Object.keys(SDK_OPERATIONS).sort(), catalogue);

  for (const [operationId, method] of Object.entries(SDK_OPERATIONS)) {
    assert.equal(
      typeof (CoderaxClient.prototype as unknown as Record<string, unknown>)[method],
      'function',
      `SDK operation ${operationId} names missing method ${method}`,
    );
  }

  const sdk = JSON.parse(
    readFileSync(path.join(root, 'packages', 'sdk', 'package.json'), 'utf8'),
  ) as { version: string; private: boolean };
  assert.equal(sdk.version, CONTRACT_VERSION, 'SDK and HTTP contract versions must match');
  assert.equal(sdk.private, true, 'the SDK is not a public artifact');
});

test('every owner route is registered and answers 401 without a token', async () => {
  const started = await startTestApp();
  try {
    for (const route of ROUTES) {
      const response = await fetch(`${started.url}${principalPath(route.path)}`, {
        method: route.method,
      });
      if (route.auth === 'owner') {
        assert.equal(response.status, 401, `${route.method} ${route.path} was not protected`);
        const body = (await response.json()) as { code: string };
        assert.equal(body.code, 'unauthorized');
      } else {
        assert.equal(response.status, 200, `${route.method} ${route.path} was not public`);
      }
    }
  } finally {
    await started.close();
  }
});

test('registered routes are exactly the catalogue, once each', async () => {
  const started = await startTestApp();
  try {
    const registry = started.app.router.registry;
    const registered = registry.list();
    assert.deepEqual(registry.missing(), []);
    assert.equal(registered.length, ROUTES.length);
    assert.deepEqual(
      registered.map((entry) => entry.spec.operationId).sort(),
      [...ROUTE_INDEX.keys()].sort(),
    );
    assert.equal(new Set(registered.map((entry) => entry.spec.operationId)).size, registered.length);
    assert.equal(
      JSON.stringify(registry.openapi()),
      JSON.stringify(buildOpenApiDocument()),
      'the served document must be the published document',
    );
  } finally {
    await started.close();
  }
});

test('the generated document covers every operation with the declared auth and status', () => {
  const document = buildOpenApiDocument();
  for (const route of ROUTES) {
    const operation = document.paths[route.path]?.[route.method.toLowerCase()];
    assert.ok(operation, `missing ${route.method} ${route.path}`);
    assert.equal(operation.operationId, route.operationId);
    assert.equal(
      JSON.stringify(operation.security),
      JSON.stringify(route.auth === 'owner' ? [{ bearerAuth: [] }] : []),
    );
    assert.ok(operation.responses[String(route.response.status)]);
    if (route.stream) {
      const response = operation.responses[String(route.response.status)] as {
        content: Record<string, unknown>;
      };
      assert.ok(response.content['text/event-stream']);
    }
  }
});

test('the SDK refuses a redirect, keeps the token out of the URL and validates errors', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new CoderaxClient({
    baseUrl: 'https://engine.test',
    token: 'owner-token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          type: 'https://coderax.dev/problems/unauthorized',
          title: 'unauthorized',
          status: 401,
          code: 'unauthorized',
          detail: 'A valid owner token is required.',
          requestId: 'req_test',
          retryable: false,
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    () => client.task('task with slash'),
    (error: unknown) => error instanceof CoderaxApiError && error.code === 'unauthorized',
  );
  assert.equal(calls[0]?.url, 'https://engine.test/v1/work/task%20with%20slash');
  assert.equal(calls[0]?.init.redirect, 'error');
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    'Bearer owner-token',
  );
  assert.doesNotMatch(calls[0]?.url ?? '', /owner-token/);
});

test('the SDK rejects a response that does not match the published contract', async () => {
  const client = new CoderaxClient({
    baseUrl: 'https://engine.test',
    token: 'owner-token',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(() => client.health(), CoderaxContractError);
});

test('a streamed event is parsed with the same schema the server emits', () => {
  const clientEvent = ExecutionEvent.parse({
    v: 1,
    eventId: 'evt_contract',
    taskId: 'task_contract',
    seq: 1,
    at: new Date().toISOString(),
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  });
  assert.equal(clientEvent.v, 1);
});
