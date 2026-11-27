import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMemoryResourceLockStore,
  createMongoResourceLockStore,
  ensureResourceLockIndexes,
} from '../../src/execution/locks.js';
import { createFakeCollection } from '../fakes/mongo.js';

const T0 = new Date('2026-11-26T12:00:00.000Z');

test('a memory lock excludes a second owner until it expires or is released', async () => {
  const store = createMemoryResourceLockStore();
  const first = await store.acquire({
    key: 'reports/result.json',
    ownerId: 'owner',
    owner: 'team:a',
    ttlMs: 1_000,
    now: T0,
  });
  assert.equal(first.acquired, true);

  const blocked = await store.acquire({
    key: 'reports/result.json',
    ownerId: 'owner',
    owner: 'team:b',
    ttlMs: 1_000,
    now: T0,
  });
  assert.deepEqual(blocked, { acquired: false, holder: 'team:a' });

  assert.equal(
    await store.renew({ key: 'reports/result.json', owner: 'team:b', ttlMs: 1_000, now: T0 }),
    false,
  );
  assert.equal(
    await store.release({ key: 'reports/result.json', owner: 'team:b' }),
    false,
  );

  // A different resource is a different lock.
  assert.equal(
    (await store.acquire({
      key: 'reports/other.json',
      ownerId: 'owner',
      owner: 'team:b',
      ttlMs: 1_000,
      now: T0,
    })).acquired,
    true,
  );

  assert.equal(await store.release({ key: 'reports/result.json', owner: 'team:a' }), true);
  assert.equal(
    (await store.acquire({
      key: 'reports/result.json',
      ownerId: 'owner',
      owner: 'team:b',
      ttlMs: 1_000,
      now: T0,
    })).acquired,
    true,
  );
});

test('an expired memory lock is taken over', async () => {
  const store = createMemoryResourceLockStore();
  await store.acquire({ key: 'a.txt', ownerId: 'owner', owner: 'team:a', ttlMs: 1_000, now: T0 });
  const later = new Date(T0.getTime() + 1_001);
  assert.equal(
    (await store.acquire({ key: 'a.txt', ownerId: 'owner', owner: 'team:b', ttlMs: 1_000, now: later }))
      .acquired,
    true,
  );
});

test('a MongoDB lock is enforced across two replicas sharing the collection', async () => {
  const collection = createFakeCollection();
  await ensureResourceLockIndexes({ collection });
  const replicaA = createMongoResourceLockStore({ collection });
  const replicaB = createMongoResourceLockStore({ collection });

  assert.equal(
    (await replicaA.acquire({
      key: 'reports/result.json',
      ownerId: 'owner',
      owner: 'exec:a',
      ttlMs: 1_000,
      now: T0,
    })).acquired,
    true,
  );
  assert.deepEqual(
    await replicaB.acquire({
      key: 'reports/result.json',
      ownerId: 'owner',
      owner: 'exec:b',
      ttlMs: 1_000,
      now: T0,
    }),
    { acquired: false, holder: 'exec:a' },
  );

  // The holder renews on one replica; the other still observes it.
  assert.equal(
    await replicaA.renew({ key: 'reports/result.json', owner: 'exec:a', ttlMs: 5_000, now: T0 }),
    true,
  );
  assert.equal(
    (await replicaB.acquire({
      key: 'reports/result.json',
      ownerId: 'owner',
      owner: 'exec:b',
      ttlMs: 1_000,
      now: new Date(T0.getTime() + 2_000),
    })).acquired,
    false,
  );

  assert.equal(await replicaA.release({ key: 'reports/result.json', owner: 'exec:a' }), true);
  assert.equal(
    (await replicaB.acquire({
      key: 'reports/result.json',
      ownerId: 'owner',
      owner: 'exec:b',
      ttlMs: 1_000,
      now: T0,
    })).acquired,
    true,
  );
});

test('an expired MongoDB lock is taken over by exactly one replica', async () => {
  const collection = createFakeCollection();
  await ensureResourceLockIndexes({ collection });
  const replicaA = createMongoResourceLockStore({ collection });
  const replicaB = createMongoResourceLockStore({ collection });
  await replicaA.acquire({ key: 'a.txt', ownerId: 'owner', owner: 'exec:a', ttlMs: 1_000, now: T0 });

  const after = new Date(T0.getTime() + 1_500);
  const [left, right] = await Promise.all([
    replicaA.acquire({ key: 'a.txt', ownerId: 'owner', owner: 'exec:a2', ttlMs: 1_000, now: after }),
    replicaB.acquire({ key: 'a.txt', ownerId: 'owner', owner: 'exec:b2', ttlMs: 1_000, now: after }),
  ]);
  assert.equal(Number(left.acquired) + Number(right.acquired), 1, 'exactly one takeover wins');
});
