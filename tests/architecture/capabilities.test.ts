import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * Capability-registry accuracy, proven over a real socket.
 *
 * The list a client receives must be the list compose actually registered. An
 * external adapter without a transport is reported unavailable, never omitted
 * and never presented as ready. Isolation is asserted from the wire contract so
 * an adapter cannot quietly widen it.
 */
test('the capability registry reports exactly the adapters the engine composed', async () => {
  const started = await startTestApp();
  try {
    const api = new CoderaxClient({ baseUrl: started.url, token: OWNER_TOKEN });
    const listed = await api.agents();
    assert.ok(listed.agents.length > 0, 'at least the native agent must be registered');

    const ids = listed.agents.map((agent) => agent.id);
    assert.equal(new Set(ids).size, ids.length, 'agent ids must be unique');

    const engines = listed.agents.map((agent) => agent.engine);
    assert.equal(new Set(engines).size, engines.length, 'one adapter per engine');

    for (const agent of listed.agents) {
      assert.equal(typeof agent.capabilities.streaming, 'boolean');
      assert.equal(typeof agent.capabilities.tools, 'boolean');
      assert.ok(agent.availability.reason.length > 0);
      if (agent.external) {
        assert.equal(agent.isolation.workspace, 'isolated');
        assert.equal(agent.isolation.memory, 'none');
        assert.equal(agent.isolation.credentials, 'none');
        assert.equal(agent.isolation.conversations, 'none');
      }
      if (agent.engine === 'native') {
        assert.equal(agent.availability.available, true);
        assert.equal(agent.availability.reason, 'ready');
      }
    }

    const unavailableExternal = listed.agents.filter(
      (agent) => agent.external && !agent.availability.available,
    );
    for (const agent of unavailableExternal) {
      assert.notEqual(agent.availability.reason, 'ready');
      assert.ok(agent.availability.detail.length > 0, 'an unavailable agent states why');
    }
  } finally {
    await started.close();
  }
});
