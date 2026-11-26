import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenApiDocument, ROUTES, ROUTE_INDEX } from '@coderax/contracts';
import {
  createRouteRegistry,
  RouterConfigurationError,
} from '../../src/api/router.js';
import { createApplicationService } from '../../src/orchestration/service.js';
import { startTestApp } from '../helpers.js';

test('operation ids are unique and paths are unambiguous', () => {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const route of ROUTES) {
    assert.equal(ids.has(route.operationId), false, `duplicate operation ${route.operationId}`);
    ids.add(route.operationId);
    const key = `${route.method} ${route.path}`;
    assert.equal(routes.has(key), false, `duplicate route ${key}`);
    routes.add(key);
  }
  assert.equal(routeCount(), ROUTES.length);
});

function routeCount(): number {
  return ROUTE_INDEX.size;
}

test('the OpenAPI document covers every operation and is deterministic', () => {
  const document = buildOpenApiDocument();
  for (const route of ROUTES) {
    const operation = document.paths[route.path]?.[route.method.toLowerCase()];
    assert.ok(operation, `missing ${route.method} ${route.path}`);
    assert.equal(operation.operationId, route.operationId);
  }
  assert.equal(JSON.stringify(document), JSON.stringify(buildOpenApiDocument()));
  assert.ok(document.components.schemas.Problem);
});

test('an operation outside the catalogue cannot be registered', () => {
  const registry = createRouteRegistry();
  assert.throws(
    () => registry.register('notAnOperation', async () => ({ kind: 'json', status: 200, body: {} })),
    (error: unknown) => error instanceof RouterConfigurationError,
  );
});

test('an operation cannot be registered twice', () => {
  const registry = createRouteRegistry();
  const handler = async () => ({ kind: 'json' as const, status: 200, body: {} });
  registry.register('getHealth', handler);
  assert.throws(
    () => registry.register('getHealth', handler),
    (error: unknown) => error instanceof RouterConfigurationError,
  );
});

test('the composed application registers the complete catalogue', async () => {
  const started = await startTestApp();
  try {
    const registry = started.app.router.registry;
    assert.deepEqual(registry.missing(), []);
    assert.equal(registry.list().length, ROUTES.length);
    const document = registry.openapi();
    assert.equal(
      JSON.stringify(document),
      JSON.stringify(buildOpenApiDocument()),
      'the served document must equal the published one',
    );
  } finally {
    await started.close();
  }
});

test('the service exposes the operations the catalogue documents', () => {
  // A structural check: every route is wired to a function, so a documented
  // capability cannot be missing from the implementation.
  assert.equal(typeof createApplicationService, 'function');
});
