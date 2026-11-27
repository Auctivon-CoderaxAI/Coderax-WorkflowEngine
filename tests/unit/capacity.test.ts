import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInMemoryCapacityStore,
  createMongoCapacityStore,
  ensureCapacityIndexes,
} from '../../src/persistence/capacity.js';
import { createFakeCollection } from '../fakes/mongo.js';

const NOW = '2026-01-01T00:00:00.000Z';

const base = {
  ownerId: 'owner-capacity',
  mode: 'cloud' as const,
  bytes: 0,
  artifacts: 1,
  artifactId: 'art_capacity',
  version: 1,
  now: NOW,
  maxBytes: 100,
  maxArtifacts: 2,
  ttlMs: 60_000,
};

test('the memory ledger admits only what fits and returns capacity exactly once', async () => {
  const store = createInMemoryCapacityStore();

  const first = await store.reserve({ ...base, bytes: 60 });
  const second = await store.reserve({ ...base, bytes: 30 });
  const bytesDenied = await store.reserve({ ...base, bytes: 20 });
  const countDenied = await store.reserve({ ...base, bytes: 1 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(bytesDenied, { ok: false, reason: 'bytes' });
  assert.deepEqual(countDenied, { ok: false, reason: 'artifacts' });

  if (!first.ok || !second.ok) return;

  await store.release(second.reservation);
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 40,
    availableArtifacts: 1,
  });

  await store.commit(first.reservation);
  // Committed capacity is spent, and a second release of either row is a no-op.
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 40,
    availableArtifacts: 1,
  });
  await store.release(first.reservation);
  await store.release(second.reservation);
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 40,
    availableArtifacts: 1,
  });

  const expiring = await store.reserve({ ...base, bytes: 10, artifacts: 0, ttlMs: 1 });
  assert.equal(expiring.ok, true);
  if (!expiring.ok) return;
  const expired = await store.expired({
    now: new Date(Date.parse(NOW) + 10).toISOString(),
    limit: 10,
  });
  assert.deepEqual(
    expired.map((entry) => entry.reservationId),
    [expiring.reservation.reservationId],
  );
  await store.release(expiring.reservation);
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 40,
    availableArtifacts: 1,
  });
});

test('reconcile refuses to reset availability while an admission is live', async () => {
  const store = createInMemoryCapacityStore();
  const live = await store.reserve({ ...base, bytes: 25, artifacts: 0 });
  assert.equal(live.ok, true);

  await store.reconcile({
    ownerId: base.ownerId,
    mode: base.mode,
    usedBytes: 0,
    usedArtifacts: 0,
    maxBytes: 100,
    maxArtifacts: 2,
  });
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 75,
    availableArtifacts: 2,
  });

  if (live.ok) await store.release(live.reservation);
  await store.reconcile({
    ownerId: base.ownerId,
    mode: base.mode,
    usedBytes: 40,
    usedArtifacts: 1,
    maxBytes: 100,
    maxArtifacts: 2,
  });
  assert.deepEqual(await store.available({ ownerId: base.ownerId, mode: base.mode }), {
    availableBytes: 60,
    availableArtifacts: 1,
  });
});

test('the Mongo ledger admits the last slot exactly once under ten concurrent reservations', async () => {
  const capacity = createFakeCollection();
  const reservations = createFakeCollection();
  await ensureCapacityIndexes({ capacity, reservations });
  const store = createMongoCapacityStore({ capacity, reservations });

  const attempts = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      store.reserve({
        ...base,
        bytes: 10,
        artifacts: 0,
        artifactId: `art_${index}`,
        maxBytes: 50,
        maxArtifacts: 10,
      }),
    ),
  );
  const admitted = attempts.filter((entry) => entry.ok);
  assert.equal(admitted.length, 5);
  assert.equal(capacity.documents.length, 1);
  assert.equal(capacity.documents[0]?.availableBytes, 0);
  assert.ok((capacity.documents[0]?.availableBytes as number) >= 0);

  for (const entry of admitted) {
    if (entry.ok) await store.commit(entry.reservation);
  }
  assert.equal(reservations.documents.length, 0);
  assert.equal(capacity.documents[0]?.availableBytes, 0);

  // A committed admission cannot be refunded by a late release.
  const first = admitted[0];
  if (first?.ok) await store.release(first.reservation);
  assert.equal(capacity.documents[0]?.availableBytes, 0);

  await store.reconcile({
    ownerId: base.ownerId,
    mode: base.mode,
    usedBytes: 50,
    usedArtifacts: 0,
    maxBytes: 50,
    maxArtifacts: 10,
  });
  assert.equal(capacity.documents[0]?.availableBytes, 0);
});
