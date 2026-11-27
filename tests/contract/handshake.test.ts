import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHandshake, CONTRACT_VERSION, ROUTES } from '@coderax/contracts';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * The handshake is a projection, not a second list.
 *
 * A client uses it to decide whether a deployment implements the operations it
 * needs, so it must describe exactly the published catalogue — no extra promise
 * and no missing operation.
 */

test('the handshake describes every published operation exactly once', () => {
  const handshake = buildHandshake(ROUTES);

  assert.equal(handshake.engineName, 'coderax-workflow-engine');
  assert.equal(handshake.contractVersion, CONTRACT_VERSION);
  assert.equal(handshake.apiPrefix, '/v1');
  assert.equal(handshake.operations.length, ROUTES.length);

  const ids = handshake.operations.map((operation) => operation.operationId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ROUTES.map((route) => route.operationId).sort());

  for (const operation of handshake.operations) {
    const route = ROUTES.find((candidate) => candidate.operationId === operation.operationId);
    assert.ok(route);
    assert.equal(operation.method, route.method);
    assert.equal(operation.path, route.path);
    assert.equal(operation.auth, route.auth);
    assert.equal(operation.stream, route.stream === true);
    assert.equal(operation.maxBodyBytes, route.maxBodyBytes);
  }
});

test('a client reads the handshake from a running engine', async () => {
  const started = await startTestApp();
  try {
    const client = new CoderaxClient({ baseUrl: started.url, token: OWNER_TOKEN });
    const handshake = await client.handshake();
    assert.equal(handshake.contractVersion, CONTRACT_VERSION);
    assert.equal(handshake.operations.length, ROUTES.length);
    assert.ok(handshake.operations.some((operation) => operation.operationId === 'submitWork'));
    assert.ok(handshake.operations.some((operation) => operation.operationId === 'uploadArtifact'));
  } finally {
    await started.close();
  }
});
