import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_ID, startTestApp } from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };

/**
 * Deterministic lifecycle evidence. It needs no database because it exercises
 * the process-local contract: a shutdown drains exactly once and admits no new
 * work while it drains. Live persistence draining is proved by the Mongo suite.
 */

test('shutdown refuses new execution before it drains', async () => {
  const started = await startTestApp();
  try {
    started.app.service.beginShutdown();
    const refused = await started.app.service.submitWork(principal, {
      objective: 'must not start during shutdown',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.code, 'not_ready');
  } finally {
    await started.app.stop();
    started.workspace.cleanup();
  }
});

test('concurrent stop calls share one lifecycle', async () => {
  const started = await startTestApp();
  const first = started.app.stop();
  const second = started.app.stop();
  assert.equal(first, second, 'concurrent stop calls must share one lifecycle');
  await Promise.all([first, second]);
  started.workspace.cleanup();
});
