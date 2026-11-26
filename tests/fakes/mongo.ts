import type { MongoCollectionLike, MongoFilter } from '../../src/persistence/mongo.js';

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

export type FakeCollection = MongoCollectionLike & {
  documents: Document[];
  indexes: Array<{
    keys: Record<string, 1 | -1>;
    options?: { unique?: boolean; name?: string };
  }>;
};

/**
 * A collection fake that enforces the two properties the lease table relies on:
 * a unique `key` (duplicate insert raises 11000) and atomic single-document
 * updates. It is a test double for the driver, not for the table, so the same
 * fake proves both the table and the composition-root wiring.
 */
export function createFakeCollection(): FakeCollection {
  const documents: Document[] = [];
  const indexes: FakeCollection['indexes'] = [];

  function firstIndex(filter: MongoFilter): number {
    return documents.findIndex((document) => matches(document, filter));
  }

  return {
    documents,
    indexes,
    createIndex: async (keys, options) => {
      indexes.push(options ? { keys, options } : { keys });
      return 'created';
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
