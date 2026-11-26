import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMongoWorkRunTable,
  ensureWorkRunIndexes,
} from '../../src/persistence/mongo.js';
import { createFakeCollection } from '../fakes/mongo.js';

const T0 = new Date('2026-11-26T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const TTL = 30_000;

function row(token: string, expiresAt: Date) {
  return { key: 'k1', owner: 'replica-a', token, cancelRequested: false, expiresAt };
}

test('mongo table refuses a claim while a live lease exists', async () => {
  const table = createMongoWorkRunTable(createFakeCollection());
  assert.equal(await table.insertIfAbsent(row('t1', at(TTL)), T0), true);
  assert.equal(await table.insertIfAbsent(row('t2', at(TTL * 2)), at(1_000)), false);
  assert.equal((await table.find('k1'))?.token, 't1');
});

test('mongo table takes over an expired lease and fences the old token out', async () => {
  const table = createMongoWorkRunTable(createFakeCollection());
  await table.insertIfAbsent(row('t1', at(TTL)), T0);
  const later = at(TTL + 1);
  assert.equal(await table.insertIfAbsent(row('t2', at(TTL * 3)), later), true);
  assert.equal((await table.find('k1'))?.token, 't2');

  // The superseded generation can neither renew nor release the new lease.
  assert.equal(await table.updateExpiry({ key: 'k1', token: 't1', now: later, expiresAt: at(TTL * 4) }), null);
  assert.equal(await table.deleteByToken('k1', 't1'), false);
  assert.equal((await table.find('k1'))?.token, 't2');
});

test('mongo table flags a live cancellation and retires an expired one', async () => {
  const table = createMongoWorkRunTable(createFakeCollection());
  await table.insertIfAbsent(row('t1', at(TTL)), T0);
  const flagged = await table.flagCancel('k1', at(1_000));
  assert.equal(flagged?.cancelRequested, true);
  // An expired lease has no owner left to observe the flag.
  assert.equal(await table.flagCancel('k1', at(TTL + 1)), null);
  assert.equal(await table.deleteExpired('k1', at(TTL + 1)), true);
  assert.equal(await table.find('k1'), null);
});

test('mongo table renewal requires an unexpired lease with the exact token', async () => {
  const table = createMongoWorkRunTable(createFakeCollection());
  await table.insertIfAbsent(row('t1', at(TTL)), T0);
  assert.equal(await table.updateExpiry({ key: 'k1', token: 'other', now: T0, expiresAt: at(TTL) }), null);
  assert.equal(await table.updateExpiry({ key: 'k1', token: 't1', now: at(TTL), expiresAt: at(TTL) }), null);
  const renewed = await table.updateExpiry({ key: 'k1', token: 't1', now: at(1), expiresAt: at(TTL * 2) });
  assert.equal(renewed?.token, 't1');
  assert.equal(renewed?.expiresAt.getTime(), at(TTL * 2).getTime());
});

test('mongo sweep is bounded, ordered and keeps rows renewed after selection', async () => {
  const collection = createFakeCollection();
  const table = createMongoWorkRunTable(collection);
  await table.insertIfAbsent({ key: 'a', owner: 'r', token: 'ta', cancelRequested: false, expiresAt: at(10) }, T0);
  await table.insertIfAbsent({ key: 'b', owner: 'r', token: 'tb', cancelRequested: false, expiresAt: at(20) }, T0);
  await table.insertIfAbsent({ key: 'c', owner: 'r', token: 'tc', cancelRequested: false, expiresAt: at(30) }, T0);

  assert.deepEqual(await table.deleteExpiredBefore(at(30), 2), ['a', 'b']);
  assert.equal(collection.documents.length, 1);
  assert.equal(collection.documents[0]?.key, 'c');
  assert.deepEqual(await table.deleteExpiredBefore(at(30), 0), []);
});

test('the key index is unique and the expiry index exists', async () => {
  const collection = createFakeCollection();
  await ensureWorkRunIndexes(collection);
  assert.deepEqual(collection.indexes[0]?.keys, { key: 1 });
  assert.equal(collection.indexes[0]?.options?.unique, true);
  assert.deepEqual(collection.indexes[1]?.keys, { expiresAt: 1 });
});

test('a malformed stored row is reported, never treated as absent', async () => {
  const collection = createFakeCollection();
  collection.documents.push({ key: 'k1', owner: 'r', token: 't', expiresAt: 'not-a-date' });
  const table = createMongoWorkRunTable(collection);
  await assert.rejects(() => table.find('k1'), /malformed/);
});
