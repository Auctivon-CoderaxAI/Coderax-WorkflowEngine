import type { MongoCollectionLike } from '../persistence/mongo.js';
import { isDuplicateKey } from '../persistence/mongo.js';

/**
 * Resource locks are how two replicas avoid executing against the same exact
 * resource at once. A lock is a durable row with a lease, not an in-process set:
 * when `persistence.driver` is `mongo` the row lives in MongoDB and acquisition
 * is one conditional write, so a second replica observes the holder.
 *
 * Scope is one exact resource key. A lock never widens to a directory: a member
 * must declare every path it needs and the team acquires each one.
 */
export type LockAcquisition =
  | { acquired: true }
  | { acquired: false; holder: string | null };

export type LockInspection = { owner: string; expiresAt: string } | null;

export type ResourceLockStore = {
  acquire: (input: {
    key: string;
    ownerId: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }) => Promise<LockAcquisition>;
  renew: (input: { key: string; owner: string; ttlMs: number; now: Date }) => Promise<boolean>;
  release: (input: { key: string; owner: string }) => Promise<boolean>;
  inspect: (key: string) => Promise<LockInspection>;
};

export function createMemoryResourceLockStore(): ResourceLockStore {
  const locks = new Map<string, { owner: string; ownerId: string; expiresAt: number }>();

  return {
    acquire: async ({ key, ownerId, owner, ttlMs, now }) => {
      const existing = locks.get(key);
      if (existing && existing.expiresAt > now.getTime()) {
        return { acquired: false, holder: existing.owner };
      }
      locks.set(key, { owner, ownerId, expiresAt: now.getTime() + ttlMs });
      return { acquired: true };
    },
    renew: async ({ key, owner, ttlMs, now }) => {
      const existing = locks.get(key);
      if (!existing || existing.owner !== owner || existing.expiresAt <= now.getTime()) return false;
      existing.expiresAt = now.getTime() + ttlMs;
      return true;
    },
    release: async ({ key, owner }) => {
      const existing = locks.get(key);
      if (!existing || existing.owner !== owner) return false;
      locks.delete(key);
      return true;
    },
    inspect: async (key) => {
      const existing = locks.get(key);
      return existing
        ? { owner: existing.owner, expiresAt: new Date(existing.expiresAt).toISOString() }
        : null;
    },
  };
}

/**
 * The MongoDB store. The unique index on `key` is the cross-replica arbiter: an
 * insert for a held key fails with 11000 instead of creating a second row. An
 * expired row is taken over with one conditional update, so only one of two
 * racing replicas sees `matchedCount === 1`.
 */
export function createMongoResourceLockStore(input: {
  collection: MongoCollectionLike;
  /** prefix keeps locks in one collection namespaced by an environment. */
  prefix?: string;
}): ResourceLockStore {
  const prefix = input.prefix ?? '';
  const keyOf = (key: string): string => `${prefix}${key}`;
  const collection = input.collection;

  return {
    acquire: async ({ key, ownerId, owner, ttlMs, now }) => {
      const id = keyOf(key);
      const expiresAt = new Date(now.getTime() + ttlMs);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await collection.findOne({ key: id });
        if (!existing) {
          try {
            await collection.insertOne({
              key: id,
              ownerId,
              owner,
              acquiredAt: now,
              expiresAt,
            });
            return { acquired: true };
          } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            continue;
          }
        }
        const current = existing.expiresAt;
        if (!(current instanceof Date) || current.getTime() > now.getTime()) {
          return { acquired: false, holder: typeof existing.owner === 'string' ? existing.owner : null };
        }
        const result = await collection.updateOne(
          { key: id, expiresAt: { $lte: now } },
          { $set: { ownerId, owner, acquiredAt: now, expiresAt } },
          { upsert: false },
        );
        if ((result.matchedCount ?? 0) === 1) return { acquired: true };
      }
      const holder = await collection.findOne({ key: id });
      return {
        acquired: false,
        holder: typeof holder?.owner === 'string' ? holder.owner : null,
      };
    },
    renew: async ({ key, owner, ttlMs, now }) => {
      const result = await collection.updateOne(
        { key: keyOf(key), owner, expiresAt: { $gt: now } },
        { $set: { expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: false },
      );
      return (result.matchedCount ?? 0) === 1;
    },
    release: async ({ key, owner }) => {
      const result = await collection.deleteOne({ key: keyOf(key), owner });
      return result.deletedCount === 1;
    },
    inspect: async (key) => {
      const existing = await collection.findOne({ key: keyOf(key) });
      if (!existing || !(existing.expiresAt instanceof Date)) return null;
      return {
        owner: typeof existing.owner === 'string' ? existing.owner : '',
        expiresAt: existing.expiresAt.toISOString(),
      };
    },
  };
}

export async function ensureResourceLockIndexes(input: {
  collection: MongoCollectionLike;
}): Promise<void> {
  await input.collection.createIndex({ key: 1 }, { unique: true, name: 'resource_lock_key' });
}
