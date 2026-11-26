import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMongoWorkRunTable,
  ensureWorkRunIndexes,
  type MongoCollectionLike,
  type MongoFilter,
} from '../../src/persistence/mongo.js';

type Document = Record<string, unknown>;

function matches(document: Document, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = document[field];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      if ('$lte' in operators) {
        const bound = operators.$lte as Date;
        if (!(value instanceof Date) || value.getTime() > bound.getTime()) return false;
      }
      if ('$gt' in operators) {
        const bound = operators.$gt as Date;
        if (!(value instanceof Date) || value.getTime() <= bound.getTime()) return false;
      }
      if ('$in' in operators) {
        const list = operators.$in as unknown[];
        if (!list.includes(value)) return false;
      }
      return true;
    }
    return value === condition;
  });
}

/**
 * A collection fake that enforces the two properties the lease table relies on:
 * a unique `key` (duplicate insert raises 11000) and atomic single-document
 * updates. It is a test double for the driver, not for the table.
 */
function createFakeCollection(): MongoCollectionLike & { documents: Document[] } {
  const documents: Document[] = [];

  function firstIndex(filter: MongoFilter): number {
    return documents.findIndex((document) => matches(document, filter));
  }

  return {
    documents,
    createIndex: async () => 'created',
    findOne: async (filter) => {
      const index = firstIndex(filter);
      return index === -1 ? null : { ...documents[index] };
    },
    findOneAndUpdate: async (filter, update, _options) => {
      const index = firstIndex(filter);
      if (index === -1) return null;
      documents[index] = { ...documents[index], ...update.$set };
      return { ...documents[index] };
    },
    updateOne: async (filter, update, options) => {
      const index = firstIndex(filter);
      if (index !== -1) {
        documents[index] = { ...documents[index], ...update.$set };
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      const candidate = { ...(update.$setOnInsert ?? {}), ...update.$set };
      if (documents.some((document) => document.key === candidate.key)) {
        const error = new Error('E11000 duplicate key error');
        (error as { code?: number }).code = 11000;
        throw error;
      }
      documents.push(candidate);
      return { matchedCount: 0, upsertedCount: 1 };
    },
    deleteOne: async (filter) => {
      const index = firstIndex(filter);
      if (index === -1) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async (filter) => {
      const kept = documents.filter((document) => !matches(document, filter));
      const deletedCount = documents.length - kept.length;
      documents.length = 0;
      documents.push(...kept);
      return { deletedCount };
    },
    find: (filter) => {
      let result = documents.filter((document) => matches(document, filter));
      const chain = {
        sort: (spec: Record<string, 1 | -1>) => {
          const [field, direction] = Object.entries(spec)[0] ?? ['key', 1];
          result = [...result].sort((left, right) => {
            const a = left[field];
            const b = right[field];
            const leftValue = a instanceof Date ? a.getTime() : String(a);
            const rightValue = b instanceof Date ? b.getTime() : String(b);
            return leftValue < rightValue ? -direction : leftValue > rightValue ? direction : 0;
          });
          return {
            limit: (value: number) => ({
              toArray: async () => result.slice(0, value).map((document) => ({ ...document })),
            }),
          };
        },
        limit: (value: number) => ({
          toArray: async () => result.slice(0, value).map((document) => ({ ...document })),
        }),
      };
      return chain as unknown as ReturnType<MongoCollectionLike['find']>;
    },
  };
}

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
  const created: Array<{ keys: Record<string, 1 | -1>; options?: { unique?: boolean } }> = [];
  const collection = createFakeCollection();
  await ensureWorkRunIndexes({
    ...collection,
    createIndex: async (keys, options) => {
      created.push({ keys, options });
      return 'created';
    },
  });
  assert.deepEqual(created[0]?.keys, { key: 1 });
  assert.equal(created[0]?.options?.unique, true);
  assert.deepEqual(created[1]?.keys, { expiresAt: 1 });
});

test('a malformed stored row is reported, never treated as absent', async () => {
  const collection = createFakeCollection();
  collection.documents.push({ key: 'k1', owner: 'r', token: 't', expiresAt: 'not-a-date' });
  const table = createMongoWorkRunTable(collection);
  await assert.rejects(() => table.find('k1'), /malformed/);
});
