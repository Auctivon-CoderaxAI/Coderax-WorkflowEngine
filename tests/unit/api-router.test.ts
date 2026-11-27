import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthService } from '../../src/security/auth.js';
import { createRouteRegistry, createRouter } from '../../src/api/router.js';

const auth = {
  ownerId: 'owner',
  authenticate: () => ({ ownerId: 'owner', isOwner: true }),
} as unknown as AuthService;

test('the knowledge search handler receives the coerced k, not the raw string', async () => {
  let received: unknown = null;
  const registry = createRouteRegistry();
  registry.register('searchKnowledge', async (context) => {
    received = context.query.k;
    return { kind: 'json', status: 200, body: { hits: [], embedding: 'lexical' } };
  });
  const router = createRouter({ registry, auth, requestId: () => 'req-1', now: () => 0 });
  const result = await router.handle({
    method: 'GET',
    path: '/v1/knowledge/search?q=leases&k=1&mode=cloud',
    authorization: 'Bearer token',
    bodyText: '',
  });
  assert.equal(result.kind, 'json');
  assert.equal(received, 1);
  assert.equal(typeof received, 'number');
});

test('an invalid query value is refused before the handler runs', async () => {
  let called = false;
  const registry = createRouteRegistry();
  registry.register('searchKnowledge', async () => {
    called = true;
    return { kind: 'json', status: 200, body: { hits: [], embedding: 'lexical' } };
  });
  const router = createRouter({ registry, auth, requestId: () => 'req-2', now: () => 0 });
  const result = await router.handle({
    method: 'GET',
    path: '/v1/knowledge/search?q=leases&k=0&mode=cloud',
    authorization: 'Bearer token',
    bodyText: '',
  });
  assert.equal(result.kind, 'json');
  assert.equal(result.status, 400);
  assert.equal(called, false);
});
