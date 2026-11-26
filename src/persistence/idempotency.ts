import type { TaskAccepted } from '@coderax/contracts';
import type { IdempotencyRecord } from '../domain.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Idempotent Work submission.
 *
 * A client that retries an accepted submission after a dropped response must get
 * the original task, not a second run. The key is scoped to the owner and bound
 * to a digest of the request: the same request replays the stored acceptance, a
 * different request reusing the key is refused, and a reservation that never
 * completed expires instead of blocking the key forever.
 *
 * The reservation is an insert guarded by a unique index, so two replicas racing
 * the same key cannot both create a task.
 */
export type ReserveInput = {
  ownerId: string;
  key: string;
  requestHash: string;
  now: string;
  expiresAt: string;
};

export type ReserveResult =
  | { kind: 'reserved' }
  | { kind: 'replay'; response: TaskAccepted }
  | { kind: 'conflict' }
  | { kind: 'pending' };

export type IdempotencyStore = {
  reserve: (input: ReserveInput) => Promise<ReserveResult>;
  complete: (input: {
    ownerId: string;
    key: string;
    response: TaskAccepted;
    now: string;
    expiresAt: string;
  }) => Promise<void>;
  release: (input: { ownerId: string; key: string }) => Promise<void>;
  prune: (before: string, limit: number) => Promise<number>;
  get: (ownerId: string, key: string) => Promise<IdempotencyRecord | null>;
  /** Authorized erasure when a conversation is deleted. */
  deleteByConversation: (ownerId: string, conversationId: string) => Promise<number>;
};

type Row = IdempotencyRecord & { id: string; conversationId?: string };

function rowId(ownerId: string, key: string): string {
  return `${ownerId}\u0000${key}`;
}

function toRecord(row: Row): IdempotencyRecord {
  const { id: _id, conversationId: _conversation, ...record } = row;
  return record;
}

function decide(row: IdempotencyRecord, input: ReserveInput): ReserveResult {
  if (row.requestHash !== input.requestHash) return { kind: 'conflict' };
  if (row.state === 'completed' && row.response) {
    return { kind: 'replay', response: row.response };
  }
  return { kind: 'pending' };
}

export function createIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, Row>();

  return {
    reserve: async (input) => {
      const id = rowId(input.ownerId, input.key);
      const existing = rows.get(id);
      if (!existing) {
        rows.set(id, {
          id,
          ownerId: input.ownerId,
          key: input.key,
          requestHash: input.requestHash,
          state: 'pending',
          response: null,
          createdAt: input.now,
          updatedAt: input.now,
          expiresAt: input.expiresAt,
        });
        return { kind: 'reserved' };
      }
      if (existing.expiresAt <= input.now) {
        rows.set(id, {
          id,
          ownerId: input.ownerId,
          key: input.key,
          requestHash: input.requestHash,
          state: 'pending',
          response: null,
          createdAt: input.now,
          updatedAt: input.now,
          expiresAt: input.expiresAt,
        });
        return { kind: 'reserved' };
      }
      return decide(existing, input);
    },
    complete: async ({ ownerId, key, response, now, expiresAt }) => {
      const id = rowId(ownerId, key);
      const existing = rows.get(id);
      if (!existing) return;
      rows.set(id, {
        ...existing,
        state: 'completed',
        response,
        conversationId: response.conversationId,
        updatedAt: now,
        expiresAt,
      });
    },
    release: async ({ ownerId, key }) => {
      const id = rowId(ownerId, key);
      const existing = rows.get(id);
      if (existing && existing.state === 'pending') rows.delete(id);
    },
    prune: async (before, limit) => {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (deleted >= limit) break;
        if (row.expiresAt <= before) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    get: async (ownerId, key) => {
      const row = rows.get(rowId(ownerId, key));
      return row ? toRecord(row) : null;
    },
    deleteByConversation: async (ownerId, conversationId) => {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (row.ownerId === ownerId && row.conversationId === conversationId) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

export async function ensureIdempotencyIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { ownerId: 1, key: 1 },
    { unique: true, name: 'idempotency_owner_key' },
  );
  await collection.createIndex({ id: 1 }, { unique: true, name: 'idempotency_id' });
  await collection.createIndex({ expiresAt: 1 }, { name: 'idempotency_expiry' });
}

function toMongoRow(document: Record<string, unknown>): Row {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as Row;
}

export function createMongoIdempotencyStore(collection: MongoCollectionLike): IdempotencyStore {
  return {
    reserve: async (input) => {
      const id = rowId(input.ownerId, input.key);
      const filter = { ownerId: input.ownerId, key: input.key };
      const existing = await collection.findOne(filter);
      if (!existing) {
        try {
          await collection.insertOne({
            id,
            ownerId: input.ownerId,
            key: input.key,
            requestHash: input.requestHash,
            state: 'pending',
            response: null,
            createdAt: input.now,
            updatedAt: input.now,
            expiresAt: input.expiresAt,
          });
          return { kind: 'reserved' };
        } catch (error) {
          if ((error as { code?: number }).code !== 11_000) throw error;
          const raced = await collection.findOne(filter);
          if (!raced) return { kind: 'pending' };
          return decide(toMongoRow(raced), input);
        }
      }

      const row = toMongoRow(existing);
      if (row.expiresAt <= input.now) {
        const taken = await collection.findOneAndUpdate(
          { ...filter, expiresAt: { $lte: input.now } },
          {
            $set: {
              requestHash: input.requestHash,
              state: 'pending',
              response: null,
              updatedAt: input.now,
              expiresAt: input.expiresAt,
            },
          },
          { returnDocument: 'after', includeResultMetadata: false },
        );
        if (taken) return { kind: 'reserved' };
        const current = await collection.findOne(filter);
        return current ? decide(toMongoRow(current), input) : { kind: 'pending' };
      }
      return decide(row, input);
    },

    complete: async ({ ownerId, key, response, now, expiresAt }) => {
      await collection.updateOne(
        { ownerId, key },
        {
          $set: {
            state: 'completed',
            response,
            conversationId: response.conversationId,
            updatedAt: now,
            expiresAt,
          },
        },
        { upsert: false },
      );
    },

    release: async ({ ownerId, key }) => {
      await collection.deleteOne({ ownerId, key, state: 'pending' });
    },

    prune: async (before, limit) => {
      if (limit <= 0) return 0;
      const expired = await collection
        .find({ expiresAt: { $lte: before } })
        .limit(limit)
        .toArray();
      const ids = expired
        .map((document) => document.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return 0;
      const result = await collection.deleteMany({ id: { $in: ids } });
      return result.deletedCount;
    },

    get: async (ownerId, key) => {
      const document = await collection.findOne({ ownerId, key });
      return document ? toRecord(toMongoRow(document)) : null;
    },

    deleteByConversation: async (ownerId, conversationId) => {
      const result = await collection.deleteMany({ ownerId, conversationId });
      return result.deletedCount;
    },
  };
}
