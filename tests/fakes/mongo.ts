import type {
  MongoCollectionLike,
  MongoCursor,
  MongoFilter,
  MongoUpdate,
} from '../../src/persistence/mongo.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';

type Document = Record<string, unknown>;
type Index = {
  keys: Record<string, 1 | -1>;
  options?: {
    unique?: boolean;
    name?: string;
    partialFilterExpression?: MongoFilter;
    expireAfterSeconds?: number;
  };
};

/** Reads a dotted path; an array segment yields the values of its elements. */
function readPath(document: Document, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      return current
        .map((entry) =>
          entry !== null && typeof entry === 'object' ? (entry as Document)[part] : undefined,
        )
        .filter((value) => value !== undefined);
    }
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Document)[part];
  }
  return current;
}

/**
 * Ordering covers the three comparable shapes the stores use: dates for leases
 * and retention, numbers for event sequences, and strings for identifiers. A
 * numeric comparison that fell back to string order would put sequence 10 before
 * 9, which is exactly the bug a durable log cannot afford.
 */
function compare(left: unknown, right: unknown): number | null {
  if (left instanceof Date && right instanceof Date) {
    return Math.sign(left.getTime() - right.getTime());
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.sign(left - right);
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return Math.sign(left.localeCompare(right));
  }
  return null;
}

function matches(document: Document, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') {
      const list = Array.isArray(condition) ? condition : [];
      return list.some((entry) => matches(document, entry as MongoFilter));
    }
    const value = readPath(document, field);
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      for (const [operator, operand] of Object.entries(operators)) {
        if (operator === '$lte' || operator === '$lt' || operator === '$gte' || operator === '$gt') {
          const order = compare(value, operand);
          if (order === null) return false;
          if (operator === '$lte' && order > 0) return false;
          if (operator === '$lt' && order >= 0) return false;
          if (operator === '$gte' && order < 0) return false;
          if (operator === '$gt' && order <= 0) return false;
        } else if (operator === '$type') {
          if (operand === 'string' && typeof value !== 'string') return false;
        } else if (operator === '$exists') {
          if ((value !== undefined) !== (operand === true)) return false;
        } else if (operator === '$type') {
          if (operand === 'string' && typeof value !== 'string') return false;
        } else if (operator === '$in') {
          if (!(operand as unknown[]).includes(value)) return false;
        } else if (operator === '$nin') {
          if ((operand as unknown[]).includes(value)) return false;
        } else if (operator === '$ne') {
          if (value === operand) return false;
        } else {
          // An operator the fake does not model must fail loudly, not match.
          return false;
        }
      }
      return true;
    }
    if (Array.isArray(value)) return value.some((entry) => entry === condition);
    return value === condition;
  });
}

function indexValue(document: Document, keys: Record<string, 1 | -1>): string {
  return JSON.stringify(Object.keys(keys).map((field) => document[field] ?? null));
}

/** `$inc`, `$push` and `$pull` are how quota counters and blob leases move. */
function applyUpdate(document: Document, update: MongoUpdate): Document {
  const next = { ...document, ...(update.$set ?? {}) };
  for (const [field, amount] of Object.entries(update.$inc ?? {})) {
    const current = typeof next[field] === 'number' ? (next[field] as number) : 0;
    next[field] = current + amount;
  }
  for (const [field, value] of Object.entries(update.$push ?? {})) {
    const existing = next[field];
    next[field] = Array.isArray(existing) ? [...existing, value] : [value];
  }
  for (const [field, condition] of Object.entries(update.$pull ?? {})) {
    const existing = next[field];
    if (!Array.isArray(existing)) continue;
    next[field] = existing.filter((entry) => {
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        return !(
          entry !== null &&
          typeof entry === 'object' &&
          matches(entry as Document, condition as MongoFilter)
        );
      }
      return entry !== condition;
    });
  }
  for (const [field, value] of Object.entries(update.$max ?? {})) {
    const current = next[field];
    if (current === undefined || (compare(current, value) ?? 1) < 0) {
      next[field] = value;
    }
  }
  return next;
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
 * and limits, atomic single-document updates including `$inc` and `$max`, numeric
 * comparisons, and the unique indexes the stores declare (a duplicate insert
 * raises 11000). It is a test double for the driver, not for the repositories, so
 * the same fake proves the wiring and the semantics.
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
      const partial = index.options.partialFilterExpression;
      if (partial && !matches(candidate, partial)) continue;
      const key = indexValue(candidate, index.keys);
      const clash = documents.some(
        (document, position) =>
          position !== skip &&
          (!partial || matches(document, partial)) &&
          indexValue(document, index.keys) === key,
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
          const order = compare(left[field], right[field]) ?? 0;
          return order * direction;
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
      const next = applyUpdate(documents[index] as Document, update);
      assertUnique(next, index);
      documents[index] = next;
      return { ...next };
    },
    updateOne: async (filter, update, options) => {
      const index = firstIndex(filter);
      if (index !== -1) {
        const next = applyUpdate(documents[index], update);
        assertUnique(next, index);
        documents[index] = next;
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      const candidate = applyUpdate({ ...(update.$setOnInsert ?? {}) }, update);
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
