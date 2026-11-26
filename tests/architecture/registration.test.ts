import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES } from '@coderax/contracts';
import { checkRegistration } from '../../scripts/gate/registration.js';
import { createRouteRegistry } from '../../src/api/router.js';

test('every catalogue operation is registered once and reachable through the router', async () => {
  const result = await checkRegistration();
  assert.deepEqual(result.findings, []);
});

test('the completeness probe detects a catalogue operation with no handler', () => {
  const registry = createRouteRegistry();
  registry.register('getHealth', async () => ({ kind: 'json', status: 200, body: {} }));
  assert.equal(registry.missing().length, ROUTES.length - 1);
});
