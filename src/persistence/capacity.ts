import { randomUUID } from 'node:crypto';
import type { DataMode } from '@coderax/contracts';
import { isDuplicateKey, type MongoCollectionLike } from './mongo.js';

/**
 * Quota admission that survives a crash and two replicas.
 *
 * Usage is not re-counted from rows before every write: that read-then-write
 * admits both writers when only one fits. Instead a per-partition capacity
 * document holds `availableBytes` and `availableArtifacts`, and an admission is
 * one conditional `$inc` on that document. MongoDB applies the filter and the
 * decrement as one operation, so the loser of a race is refused rather than
 * both being admitted.
 *
 * An admission also writes a reservation row before touching the counter. The
 * reservation expires, so a process that dies between admission and the
 * metadata write cannot hold quota forever. A sweep resolves each expired row
 * against the durable version it claims to have written: materialized means
 * commit (the bytes are used), absent means release (the bytes return). The
 * refund is marked before the counter is incremented, so a crash during a
 * release can lose a refund (under-admission, repaired by `reconcile`) but can
 * never double-refund (over-admission).
 *
 * `reconcile` rebuilds availability from the committed rows at startup. It
 * refuses to run while a reservation is live, so one replica starting cannot
 * erase another replica's in-flight admission.
 */

export const RESERVATION_TTL_MS = 15 * 60_000;

export type CapacityReservation = {
  reservationId: string;
  ownerId: string;
  mode: DataMode;
  key: string;
  bytes: number;
  artifacts: number;
  artifactId: string;
  version: number;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
};

export type CapacityDecision =
  | { ok: true; reservation: CapacityReservation }
  | { ok: false; reason: 'bytes' | 'artifacts' };

export type CapacitySnapshot = {
  availableBytes: number;
  availableArtifacts: number;
};

export type ReserveInput = {
  ownerId: string;
  mode: DataMode;
  bytes: number;
  artifacts: number;
  artifactId: string;
  version: number;
  now: string;
  maxBytes: number;
  maxArtifacts: number;
  ttlMs: number;
};

export type CapacityStore = {
  readonly durable: boolean;
  ensure: (input: {
    ownerId: string;
    mode: DataMode;
    maxBytes: number;
    maxArtifacts: number;
  }) => Promise<void>;
  reserve: (input: ReserveInput) => Promise<CapacityDecision>;
  commit: (reservation: Pick<CapacityReservation, 'reservationId'>) => Promise<void>;
  commitLegacyVersion?: (key: { ownerId: string; mode: DataMode; artifactId: string; version: number }) => Promise<void>;
  release: (reservation: CapacityReservation) => Promise<void>;
  refund: (input: {
    ticket?: string;
    legacyTicket?: string;
    ownerId: string;
    mode: DataMode;
    bytes: number;
    artifacts: number;
  }) => Promise<void>;
  available: (input: { ownerId: string; mode: DataMode }) => Promise<CapacitySnapshot>;
  reconcile: (input: {
    ownerId: string;
    mode: DataMode;
    usage: () => Promise<{ bytes: number; artifacts: number } | null>;
    maxBytes: number;
    maxArtifacts: number;
  }) => Promise<void>;
  expired: (input: { now: string; limit: number }) => Promise<CapacityReservation[]>;
  /** Drops dead rows left in the refunding state; `reconcile` repairs the count. */
  discardStale: (input: { before: string; limit: number }) => Promise<number>;
};

function keyFor(ownerId: string, mode: DataMode): string {
  return `${ownerId}\u0000${mode}`;
}

function reservationId(): string {
  return `res_${randomUUID()}`;
}

function bounded(value: number): number {
  return Math.max(0, Math.floor(value));
}

type MemoryDocument = {
  ownerId: string;
  mode: DataMode;
  availableBytes: number;
  availableArtifacts: number;
  maxBytes: number;
  maxArtifacts: number;
};

type MemoryReservation = {
  reservation: CapacityReservation;
  state: 'held' | 'refunding';
  updatedAt: string;
};

export function createInMemoryCapacityStore(): CapacityStore {
  let revision = 0;
  const documents = new Map<string, MemoryDocument>();
  const reservations = new Map<string, MemoryReservation>();

  function ensureDocument(input: {
    ownerId: string;
    mode: DataMode;
    maxBytes: number;
    maxArtifacts: number;
  }): MemoryDocument {
    const key = keyFor(input.ownerId, input.mode);
    const existing = documents.get(key);
    if (existing) {
      existing.maxBytes = input.maxBytes;
      existing.maxArtifacts = input.maxArtifacts;
      return existing;
    }
    const created: MemoryDocument = {
      ownerId: input.ownerId,
      mode: input.mode,
      availableBytes: bounded(input.maxBytes),
      availableArtifacts: bounded(input.maxArtifacts),
      maxBytes: bounded(input.maxBytes),
      maxArtifacts: bounded(input.maxArtifacts),
    };
    documents.set(key, created);
    return created;
  }

  return {
    durable: false,

    ensure: async (input) => {
      ensureDocument(input);
    },

    reserve: async (input) => {
      const document = ensureDocument(input);
      const bytes = bounded(input.bytes);
      const artifacts = bounded(input.artifacts);
      if (document.availableBytes < bytes) return { ok: false, reason: 'bytes' };
      if (document.availableArtifacts < artifacts) return { ok: false, reason: 'artifacts' };
      revision++;
      document.availableBytes -= bytes;
      document.availableArtifacts -= artifacts;
      const expiresAtMs = Date.parse(input.now) + Math.max(1, input.ttlMs);
      const reservation: CapacityReservation = {
        reservationId: reservationId(),
        ownerId: input.ownerId,
        mode: input.mode,
        key: keyFor(input.ownerId, input.mode),
        bytes,
        artifacts,
        artifactId: input.artifactId,
        version: input.version,
        createdAt: input.now,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      reservations.set(reservation.reservationId, {
        reservation,
        state: 'held',
        updatedAt: input.now,
      });
      return { ok: true, reservation };
    },

    commit: async (reservation) => {
      const held = reservations.get(reservation.reservationId);
      if (held?.state === 'held') reservations.delete(reservation.reservationId);
    },

    release: async (reservation) => {
      const held = reservations.get(reservation.reservationId);
      if (!held || held.state !== 'held') return;
      revision++;
      reservations.delete(reservation.reservationId);
      const document = documents.get(reservation.key);
      if (!document) return;
      document.availableBytes = Math.min(
        document.maxBytes,
        document.availableBytes + reservation.bytes,
      );
      document.availableArtifacts = Math.min(
        document.maxArtifacts,
        document.availableArtifacts + reservation.artifacts,
      );
    },

    refund: async ({ ownerId, mode, bytes, artifacts }) => {
      revision++;
      const document = documents.get(keyFor(ownerId, mode)) ?? ensureDocument({
        ownerId,
        mode,
        maxBytes: bounded(bytes),
        maxArtifacts: bounded(artifacts),
      });
      document.availableBytes = Math.min(document.maxBytes, document.availableBytes + bounded(bytes));
      document.availableArtifacts = Math.min(
        document.maxArtifacts,
        document.availableArtifacts + bounded(artifacts),
      );
    },

    available: async ({ ownerId, mode }) => {
      const document = documents.get(keyFor(ownerId, mode));
      return document
        ? {
            availableBytes: document.availableBytes,
            availableArtifacts: document.availableArtifacts,
          }
        : { availableBytes: 0, availableArtifacts: 0 };
    },

    reconcile: async (input) => {
      const key = keyFor(input.ownerId, input.mode);
      const live = [...reservations.values()].some(
        (entry) => entry.state === 'held' && entry.reservation.key === key,
      );
      if (live) return;
      const snapshot = revision;
      const usage = await input.usage();
      if (!usage) return;
      if (snapshot !== revision) return;
      revision++;
      documents.set(key, {
        ownerId: input.ownerId,
        mode: input.mode,
        availableBytes: Math.max(0, bounded(input.maxBytes) - bounded(usage.bytes)),
        availableArtifacts: Math.max(0, bounded(input.maxArtifacts) - bounded(usage.artifacts)),
        maxBytes: bounded(input.maxBytes),
        maxArtifacts: bounded(input.maxArtifacts),
      });
    },

    expired: async ({ now, limit }) =>
      [...reservations.values()]
        .filter((entry) => entry.state === 'held' && entry.reservation.expiresAt <= now)
        .map((entry) => entry.reservation)
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
        .slice(0, Math.max(0, Math.floor(limit))),

    discardStale: async ({ before, limit }) => {
      let removed = 0;
      for (const [id, entry] of reservations) {
        if (removed >= limit) break;
        if (entry.state === 'refunding' && entry.updatedAt < before) {
          reservations.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export type MongoCapacityCollections = {
  capacity: MongoCollectionLike;
  reservations: MongoCollectionLike;
};

function toReservation(document: Record<string, unknown>): CapacityReservation | null {
  const {
    reservationId: id,
    ownerId,
    mode,
    key,
    bytes,
    artifacts,
    artifactId,
    version,
    createdAt,
    expiresAt,
    expiresAtMs,
  } = document;
  if (
    typeof id !== 'string' ||
    typeof ownerId !== 'string' ||
    (mode !== 'private' && mode !== 'cloud') ||
    typeof key !== 'string' ||
    typeof bytes !== 'number' ||
    typeof artifacts !== 'number' ||
    typeof artifactId !== 'string' ||
    typeof version !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof expiresAtMs !== 'number'
  ) {
    return null;
  }
  return {
    reservationId: id,
    ownerId,
    mode,
    key,
    bytes,
    artifacts,
    artifactId,
    version,
    createdAt,
    expiresAt,
    expiresAtMs,
  };
}

export async function ensureCapacityIndexes(
  collections: MongoCapacityCollections,
): Promise<void> {
  await collections.capacity.createIndex(
    { key: 1 },
    { unique: true, name: 'artifact_capacity_key' },
  );
  await collections.reservations.createIndex(
    { reservationId: 1 },
    { unique: true, name: 'artifact_reservation_id' },
  );
  await collections.reservations.createIndex(
    { key: 1, state: 1, expiresAtMs: 1 },
    { name: 'artifact_reservation_expiry' },
  );
  await collections.reservations.createIndex(
    { state: 1, updatedAt: 1 },
    { name: 'artifact_reservation_stale' },
  );
}

export function createMongoCapacityStore(
  collections: MongoCapacityCollections,
): CapacityStore {
  const { capacity, reservations } = collections;

  async function ensure(input: {
    ownerId: string;
    mode: DataMode;
    maxBytes: number;
    maxArtifacts: number;
  }): Promise<void> {
    const key = keyFor(input.ownerId, input.mode);
    const updatedAt = new Date().toISOString();
    // One atomic upsert: the availability fields exist only on insert, while a
    // changed configuration updates the ceilings without resetting what is left.
    await capacity.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          ownerId: input.ownerId,
          mode: input.mode,
          availableBytes: bounded(input.maxBytes),
          availableArtifacts: bounded(input.maxArtifacts),
        },
        $set: {
          maxBytes: bounded(input.maxBytes),
          maxArtifacts: bounded(input.maxArtifacts),
          updatedAt,
        },
      },
      { upsert: true },
    );
  }

  return {
    durable: true,

    ensure,

    reserve: async (input) => {
      await ensure(input);
      const bytes = bounded(input.bytes);
      const artifacts = bounded(input.artifacts);
      const expiresAtMs = Date.parse(input.now) + Math.max(1, input.ttlMs);
      const reservation: CapacityReservation = {
        reservationId: reservationId(),
        ownerId: input.ownerId,
        mode: input.mode,
        key: keyFor(input.ownerId, input.mode),
        bytes,
        artifacts,
        artifactId: input.artifactId,
        version: input.version,
        createdAt: input.now,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };

      // The reservation exists before the counter moves, so a crash after the
      // decrement is visible to the expiry sweep rather than silently lost.
      try {
        await reservations.insertOne({
          ...reservation,
          state: 'held',
          updatedAt: input.now,
        });
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, reason: 'bytes' };
        throw error;
      }

      try {
        const admitted = await capacity.updateOne(
          {
            key: reservation.key,
            availableBytes: { $gte: bytes },
            availableArtifacts: { $gte: artifacts },
          },
          { $push: { tickets: reservation.reservationId, ...(artifacts ? { slots: reservation.artifactId } : {}) }, $inc: { revision: 1, availableBytes: -bytes, availableArtifacts: -artifacts } },
          { upsert: false },
        );
        if ((admitted.matchedCount ?? 0) === 1) return { ok: true, reservation };
      } catch (error) {
        await reservations.deleteOne({ reservationId: reservation.reservationId }).catch(
          () => undefined,
        );
        throw error;
      }

      await reservations.deleteOne({ reservationId: reservation.reservationId }).catch(
        () => undefined,
      );
      const document = await capacity.findOne({ key: reservation.key });
      return {
        ok: false,
        reason:
          document &&
          typeof document.availableArtifacts === 'number' &&
          document.availableArtifacts < artifacts
            ? 'artifacts'
            : 'bytes',
      };
    },

    commitLegacyVersion: async key => {
      await reservations.deleteMany({ ...key, state: 'held' });
    },

    commit: async (reservation) => {
      await reservations.deleteOne({
        reservationId: reservation.reservationId,
        state: 'held',
      });
    },

    release: async (reservation) => {
      const marked = await reservations.findOneAndUpdate(
        { reservationId: reservation.reservationId, state: 'held' },
        { $set: { state: 'refunding', updatedAt: new Date().toISOString() } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (!marked) return;
      await capacity.updateOne(
        { key: reservation.key },
        {
          $pull: { tickets: reservation.reservationId, ...(reservation.artifacts ? { slots: reservation.artifactId } : {}) },
          $inc: {
            revision: 1,
            availableBytes: reservation.bytes,
            availableArtifacts: reservation.artifacts,
          },
        },
        { upsert: false },
      );
      await reservations.deleteOne({
        reservationId: reservation.reservationId,
      });
    },

    refund: async ({ ownerId, mode, bytes, artifacts, ticket, legacyTicket }) => {
      const field = artifacts ? 'slots' : 'tickets';
      await capacity.updateOne(
        { key: keyFor(ownerId, mode), ...(ticket ? { [field]: ticket } : {}),
          ...(legacyTicket ? { legacyRefunds: { $nin: [legacyTicket] } } : {}) },
        {
          ...(ticket ? { $pull: { [field]: ticket } } : {}),
          ...(legacyTicket ? { $push: { legacyRefunds: legacyTicket } } : {}),
          $inc: {
            revision: 1,
            availableBytes: bounded(bytes),
            availableArtifacts: bounded(artifacts),
          },
        },
        { upsert: false },
      );
    },

    available: async ({ ownerId, mode }) => {
      const document = await capacity.findOne({ key: keyFor(ownerId, mode) });
      if (!document) return { availableBytes: 0, availableArtifacts: 0 };
      return {
        availableBytes:
          typeof document.availableBytes === 'number' ? document.availableBytes : 0,
        availableArtifacts:
          typeof document.availableArtifacts === 'number'
            ? document.availableArtifacts
            : 0,
      };
    },

    reconcile: async (input) => {
      const key = keyFor(input.ownerId, input.mode);
      await ensure(input);
      const snapshot = await capacity.findOne({ key });
      if (!snapshot) return;
      const live = await reservations
        .find({ key, state: 'held' })
        .limit(1)
        .toArray();
      if (live.length > 0) return;
      const usage = await input.usage();
      if (!usage) return;
      await capacity.updateOne(
        { key, revision: snapshot.revision ?? { $exists: false } },
        {
          $inc: { revision: 1 },
          $set: {
            key,
            ownerId: input.ownerId,
            mode: input.mode,
            availableBytes: Math.max(0, bounded(input.maxBytes) - bounded(usage.bytes)),
            availableArtifacts: Math.max(
              0,
              bounded(input.maxArtifacts) - bounded(usage.artifacts),
            ),
            maxBytes: bounded(input.maxBytes),
            maxArtifacts: bounded(input.maxArtifacts),
            updatedAt: new Date().toISOString(),
          },
        },
        { upsert: false },
      );
    },

    expired: async ({ now, limit }) => {
      const documents = await reservations
        .find({ state: 'held', expiresAtMs: { $lte: Date.parse(now) } })
        .sort({ expiresAtMs: 1 })
        .limit(Math.max(0, Math.floor(limit)))
        .toArray();
      return documents
        .map(toReservation)
        .filter((entry): entry is CapacityReservation => entry !== null);
    },

    discardStale: async ({ before, limit }) => {
      const removed = await reservations.deleteMany({
        state: 'refunding',
        updatedAt: { $lt: before },
      });
      return Math.min(removed.deletedCount ?? 0, Math.max(0, Math.floor(limit)));
    },
  };
}
