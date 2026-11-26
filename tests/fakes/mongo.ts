import type { MongoCollectionLike, MongoCursor, MongoFilter } from '../../src/persistence/mongo.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';

type Document = Record<string, unknown>;
type Index = {
  keys: Record<string, 1 | -1>;
  options?: { unique?: boolean; name?: string };
};

function matches(document: Document, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = document[field];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      const compare = (bound: unknown): number => {
        if (value instanceof Date && bound instanceof Date) return value.getTime() - bound.getTime();
        if (typeof value === 'number' && typeof bound === 'number') return value - bound;
        if (typeof value === 'string' && typeof bound === 'string') {
          return value < bound ? -1 : value > bound ? 1 : 0;
        }
        return Number.NaN;
      };
      if ('$lte' in operators) {
        const delta = compare(operators.$lte);
        if (Number.isNaN(delta) || delta > 0) return false;
      }
      if ('$lt' in operators) {
        const delta = compare(operators.$lt);
        if (Number.isNaN(delta) || delta >= 0) return false;
      }
      if ('$gt' in operators) {
        const delta = compare(operators.$gt);
        if (Number.isNaN(delta) || delta <= 0) return false;
      }
      if ('$gte' in operators) {
        const delta = compare(operators.$gte);
        if (Number.isNaN(delta) || delta < 0) return false;
      }
      if ('$in' in operators) {
        const list = operators.$in as unknown[];
        if (!list.includes(value)) return false;
      }
      if ('$nin' in operators) {
        const list = operators.$nin as unknown[];
        if (list.includes(value)) return false;
      }
      return true;
    }
    return value === condition;
  });
}

function indexValue(document: Document, keys: Record<string, 1 | -1>): string {
  return JSON.stringify(Object.keys(keys).map((field) => document[field] ?? null));
}

function duplicateKey(): Error {
  const error = new Error('E11000 duplicate key error');
  (error as { code?: number }).code = 11000;
  return error;
}

export type FakeCollection = MongoCollectionLike & {
  documents: Document[];
  indexes: Index[];
};

/**
 * A collection fake that enforces what the stores rely on: a cursor that sorts
 * and limits, atomic single-document updates, and the unique indexes the stores
 * declare (a duplicate insert raises 11000). It is a test double for the driver,
 * not for the repositories, so the same fake proves the wiring and the semantics.
 */
export function createFakeCollection(): FakeCollection {
  const documents: Document[] = [];
  const indexes: Index[] = [];

  function firstIndex(filter: MongoFilter): number {
    return documents.findIndex((document) => matches(document, filter));
  }

  function assertUnique(candidate: Document, skip: number): void {
    for (const index of indexes) {
      if (!index.options?.unique) continue;
      const key = indexValue(candidate, index.keys);
      const clash = documents.some(
        (document, position) => position !== skip && indexValue(document, index.keys) === key,
      );
      if (clash) throw duplicateKey();
    }
  }

  function cursor(filter: MongoFilter): MongoCursor {
    let result = documents.filter((document) => matches(document, filter));
    let limit = Number.POSITIVE_INFINITY;
    const self: MongoCursor = {
      sort: (spec) => {
        const [field, direction] = Object.entries(spec)[0] ?? ['key', 1];
        result = [...result].sort((left, right) => {
          const a = left[field];
          const b = right[field];
          const leftValue = a instanceof Date ? a.getTime() : String(a);
          const rightValue = b instanceof Date ? b.getTime() : String(b);
          return leftValue < rightValue ? -direction : leftValue > rightValue ? direction : 0;
        });
        return self;
      },
      limit: (value) => {
        limit = value;
        return self;
      },
      toArray: async () =>
        result.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit).map((document) => ({ ...document })),
    };
    return self;
  }

  return {
    documents,
    indexes,
    createIndex: async (keys, options) => {
      indexes.push(options ? { keys, options } : { keys });
      return 'created';
    },
    insertOne: async (document) => {
      assertUnique(document, -1);
      documents.push({ ...document });
      return { acknowledged: true };
    },
    findOne: async (filter) => {
      const index = firstIndex(filter);
      return index === -1 ? null : { ...documents[index] };
    },
    findOneAndUpdate: async (filter, update, options) => {
      if (options?.includeResultMetadata !== false || options.returnDocument !== 'after') {
        throw new Error('Expected the updated document without driver metadata.');
      }
      const index = firstIndex(filter);
      if (index === -1) return null;
      documents[index] = { ...documents[index], ...update.$set };
      return { ...documents[index] };
    },
    updateOne: async (filter, update, options) => {
      const apply = (document: Document): Document => {
        const next = { ...document, ...update.$set };
        // `$max` is monotonic under concurrency, which is exactly what the event
        // head and the generation guard rely on.
        for (const [field, value] of Object.entries(update.$max ?? {})) {
          const current = next[field];
          next[field] =
            typeof current === 'number' && typeof value === 'number'
              ? Math.max(current, value)
              : current === undefined
                ? value
                : current;
        }
        return next;
      };
      const index = firstIndex(filter);
      if (index !== -1) {
        const next = apply(documents[index]);
        assertUnique(next, index);
        documents[index] = next;
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      // A real upsert builds the new document from the filter's equality fields
      // as well as `$setOnInsert`; without that, `{taskId}` would be lost.
      const equality = Object.fromEntries(
        Object.entries(filter).filter(
          ([, condition]) =>
            condition === null ||
            typeof condition !== 'object' ||
            condition instanceof Date,
        ),
      );
      const candidate = apply({ ...equality, ...(update.$setOnInsert ?? {}) });
      assertUnique(candidate, -1);
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
    find: cursor,
  };
}

export type FakeDatabase = MongoDatabase & {
  collections: Map<string, FakeCollection>;
};

export function createFakeDatabase(): FakeDatabase {
  const collections = new Map<string, FakeCollection>();
  return {
    collections,
    collection: (name) => {
      const existing = collections.get(name);
      if (existing) return existing;
      const created = createFakeCollection();
      collections.set(name, created);
      return created;
    },
    close: async () => undefined,
  };
}
