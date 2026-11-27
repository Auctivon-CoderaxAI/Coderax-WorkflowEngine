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

/** Mongo semantics for the filters this engine uses: dotted paths and `$or`. */
function atPath(document: Document, field: string): unknown {
  let current: unknown = document;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Document)[part];
  }
  return current;
}

function compare(value: unknown, bound: unknown): number | undefined {
  if (value instanceof Date && bound instanceof Date) return value.getTime() - bound.getTime();
  if (typeof value === 'number' && typeof bound === 'number') return value - bound;
  if (typeof value === 'string' && typeof bound === 'string') return value < bound ? -1 : value > bound ? 1 : 0;
  return undefined;
}

function matches(document: Document, filter: MongoFilter): boolean {
  const anyOf = (filter as Record<string, unknown>).$or;
  if (Array.isArray(anyOf)) {
    if (!anyOf.some((option) => matches(document, option as MongoFilter))) return false;
  }
  return Object.entries(filter)
    .filter(([field]) => field !== '$or')
    .every(([field, condition]) => {
    const value = atPath(document, field);
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      if ('$exists' in operators && (value !== undefined) !== operators.$exists) return false;
      if ('$ne' in operators && value === operators.$ne) return false;
      if ('$lte' in operators) {
        const bound = operators.$lte as Date | string | number;
        const left = value instanceof Date ? value.getTime() : value;
        const right = bound instanceof Date ? bound.getTime() : bound;
        if (left === undefined || left === null || left > right) return false;
      }
      if ('$gte' in operators) {
        const bound = operators.$gte as Date | string | number;
        const left = value instanceof Date ? value.getTime() : value;
        const right = bound instanceof Date ? bound.getTime() : bound;
        if (left === undefined || left === null || left < right) return false;
      }
      if ('$lt' in operators) {
        const bound = operators.$lt as Date | string | number;
        const left = value instanceof Date ? value.getTime() : value;
        const right = bound instanceof Date ? bound.getTime() : bound;
        if (left === undefined || left === null || left >= right) return false;
      }
      if ('$gt' in operators) {
        const bound = operators.$gt as Date | string | number;
        const left = value instanceof Date ? value.getTime() : value;
        const right = bound instanceof Date ? bound.getTime() : bound;
        if (left === undefined || left === null || left <= right) return false;
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
    if (Array.isArray(value)) return value.some((entry) => entry === condition);
    return value === condition;
  });
}

function setPath(document: Document, field: string, value: unknown): void {
  const parts = field.split('.');
  let current = document;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === null || typeof next !== 'object') current[part] = {};
    current = current[part] as Document;
  }
  current[parts[parts.length - 1] as string] = value;
}

function indexValue(document: Document, keys: Record<string, 1 | -1>): string {
  return JSON.stringify(Object.keys(keys).map((field) => document[field] ?? null));
}

function applyUpdate(document: Document, update: MongoUpdate): Document {
  const next = structuredClone(document);
  for (const [field, value] of Object.entries(update.$set ?? {})) setPath(next, field, value);
  for (const [field, delta] of Object.entries((update.$inc as Record<string, number>) ?? {})) {
    const current = typeof next[field] === 'number' ? (next[field] as number) : 0;
    next[field] = current + delta;
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
      documents[index] = applyUpdate(documents[index] ?? {}, update);
      return { ...documents[index] };
    },
    updateOne: async (filter, update, options) => {
      const index = firstIndex(filter);
      if (index !== -1) {
        const next = applyUpdate(documents[index] ?? {}, update);
        assertUnique(next, index);
        documents[index] = next;
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      const candidate = { ...(update.$setOnInsert ?? {}), ...update.$set };
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
    countDocuments: async filter => documents.filter(row => matches(row, filter)).length,
    aggregate: pipeline => ({
      toArray: async () => {
        const [match, group] = pipeline;
        if (!match?.$match || JSON.stringify(group) !== JSON.stringify({ $group: { _id: null, bytes: { $sum: '$bytes' } } })) {
          throw new Error('Unsupported aggregate pipeline');
        }
        const rows = documents.filter(row => matches(row, match.$match as MongoFilter));
        return [{ bytes: rows.reduce((sum, row) => sum + Number(row.bytes), 0) }];
      },
    }),
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
