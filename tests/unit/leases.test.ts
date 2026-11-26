import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workRunKey } from '../../src/execution/lease.js';
import { createInMemoryWorkRunTable, createLeaseStore } from '../../src/persistence/work-runs.js';

const scope = { ownerId: 'owner-1', tenantId: null, conversationId: 'conversation-1' };
const key = workRunKey(scope);
const t0 = new Date('2026-11-26T00:00:00.000Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

function store() {
  return createLeaseStore(createInMemoryWorkRunTable());
}

test('a live lease can only be claimed once', async () => {
  const lease = store();
  assert.equal(
    await lease.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(30_000) }),
    true,
  );
  assert.equal(
    await lease.claim({ key, owner: 'b', token: 'token-b', now: later(1_000), expiresAt: later(31_000) }),
    false,
  );
});

test('an expired lease can be taken over', async () => {
  const lease = store();
  await lease.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(1_000) });
  assert.equal(
    await lease.claim({ key, owner: 'b', token: 'token-b', now: later(2_000), expiresAt: later(30_000) }),
    true,
  );
  const snapshot = await lease.read({ key, now: later(2_000) });
  assert.equal(snapshot?.token, 'token-b');
  assert.equal(snapshot?.live, true);
});

test('renewal requires the owning token and an unexpired lease', async () => {
  const lease = store();
  await lease.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(1_000) });
  assert.deepEqual(
    await lease.renew({ key, token: 'token-other', now: t0, expiresAt: later(2_000) }),
    { renewed: false, cancelRequested: false },
  );
  assert.deepEqual(
    await lease.renew({ key, token: 'token-a', now: later(2_000), expiresAt: later(3_000) }),
    { renewed: false, cancelRequested: false },
  );
  assert.deepEqual(
    await lease.renew({ key, token: 'token-a', now: t0, expiresAt: later(5_000) }),
    { renewed: true, cancelRequested: false },
  );
});

test('cancellation is durable, observed on renewal, and distinguishes interruption', async () => {
  const lease = store();
  await lease.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(10_000) });
  assert.equal(await lease.cancel({ key, now: t0 }), 'requested');
  assert.deepEqual(
    await lease.renew({ key, token: 'token-a', now: t0, expiresAt: later(10_000) }),
    { renewed: true, cancelRequested: true },
  );

  const expired = store();
  await expired.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(1_000) });
  assert.equal(await expired.cancel({ key, now: later(2_000) }), 'interrupted');
  assert.equal(await expired.cancel({ key, now: later(3_000) }), 'none');
});

test('release is fenced by token', async () => {
  const lease = store();
  await lease.claim({ key, owner: 'a', token: 'token-a', now: t0, expiresAt: later(10_000) });
  assert.equal(await lease.release({ key, token: 'token-other' }), false);
  assert.equal(await lease.release({ key, token: 'token-a' }), true);
  assert.equal(await lease.read({ key, now: t0 }), null);
});

test('pruning removes only expired rows and respects the limit', async () => {
  const lease = store();
  await lease.claim({
    key: workRunKey({ ownerId: 'o', tenantId: null, conversationId: 'c1' }),
    owner: 'o',
    token: 't1',
    now: t0,
    expiresAt: later(1_000),
  });
  await lease.claim({
    key: workRunKey({ ownerId: 'o', tenantId: null, conversationId: 'c2' }),
    owner: 'o',
    token: 't2',
    now: t0,
    expiresAt: later(2_000),
  });
  await lease.claim({
    key: workRunKey({ ownerId: 'o', tenantId: null, conversationId: 'c3' }),
    owner: 'o',
    token: 't3',
    now: t0,
    expiresAt: later(60_000),
  });
  assert.equal(await lease.prune({ before: later(5_000), limit: 1 }), 1);
  assert.equal(await lease.prune({ before: later(5_000), limit: 10 }), 1);
  assert.equal(await lease.prune({ before: later(5_000), limit: 10 }), 0);
});
