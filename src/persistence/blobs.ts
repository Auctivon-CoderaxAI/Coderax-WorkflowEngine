import { createHash, randomUUID } from 'node:crypto';
import type { DataMode } from '@coderax/contracts';

/**
 * Content-addressed blob storage.
 *
 * The key is derived from the owner, the data-mode partition and the SHA-256 of
 * the bytes. A caller never supplies a key, a path or a directory, so no input
 * can address outside its own partition. `durable` is a property of the backend:
 * the in-memory store reports `false` and the artifact service refuses to write
 * through it, rather than pretending a restart could not lose the file.
 *
 * References are counted. A version row owns exactly one reference, so deleting
 * a version can never delete content that another version still names. The
 * count is acquired before the version row is written and released after it is
 * removed; deletion is conditional on the count still being zero. That closes
 * the check-then-delete race a plain `referenced()` query leaves open.
 */
export type BlobRef = {
  ownerId: string;
  mode: DataMode;
  sha256: string;
};

export type BlobMaintenance = {
  /** Chunk rows whose descriptor no longer exists. */
  orphanChunks: number;
  /** Descriptors at zero references older than the grace period. */
  unreferencedBlobs: number;
};

export type BlobStore = {
  readonly durable: boolean;
  readonly backend: string;
  put: (
    input: BlobRef & { bytes: number; content: Uint8Array },
  ) => Promise<{ created: boolean }>;
  get: (ref: BlobRef) => Promise<Uint8Array | null>;
  /** Adds one durable reference; false when the blob is absent. */
  acquire: (ref: BlobRef) => Promise<boolean>;
  /** Removes one reference and returns what remains (0 when already absent). */
  release: (ref: BlobRef) => Promise<number>;
  /**
   * Takes an expiring read lease and returns its id, or null when the blob is
   * absent. A lease is not an ownership reference: it pins the bytes only until
   * it expires, so a process that crashes mid-download cannot leak the blob.
   */
  lease: (input: { ref: BlobRef; ttlMs: number }) => Promise<string | null>;
  /** Ends a lease early; harmless when it already expired or was swept. */
  releaseLease: (input: { ref: BlobRef; leaseId: string }) => Promise<void>;
  /** Deletes only while the count is still zero; a concurrent acquire wins. */
  deleteIfUnreferenced: (ref: BlobRef) => Promise<boolean>;
  /** Unconditional delete, for maintenance and tests; never a normal release. */
  delete: (ref: BlobRef) => Promise<boolean>;
  /** Removes abandoned chunks and long-unreferenced descriptors, in bounds. */
  maintain: (input: { graceMs: number; limit: number }) => Promise<BlobMaintenance>;
  /**
   * Reclaims descriptors whose counted references no version row claims. This is
   * the recovery path for a crash between metadata removal and reference
   * release: only an old reference is eligible, so an upload in flight is never
   * mistaken for a leak.
   */
  reclaimLeaked: (input: {
    graceMs: number;
    limit: number;
    referenced: (ref: BlobRef) => Promise<boolean>;
  }) => Promise<number>;
  /** A read-only round trip used by the startup and health probes. */
  check: () => Promise<void>;
};

/** Stored content that no longer matches its digest is a failure, not a miss. */
export class BlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobIntegrityError';
  }
}

export function blobKey(ref: BlobRef): string {
  // NUL is not valid in an identifier or a data mode, so two different owners or
  // partitions cannot collide into one key.
  return `${ref.ownerId}\u0000${ref.mode}\u0000${ref.sha256}`;
}

export function verifyContent(input: {
  content: Uint8Array;
  sha256: string;
  bytes: number;
}): void {
  if (input.content.length !== input.bytes) {
    throw new BlobIntegrityError('Stored content has an unexpected length.');
  }
  const digest = createHash('sha256').update(input.content).digest('hex');
  if (digest !== input.sha256) {
    throw new BlobIntegrityError('Stored content does not match its digest.');
  }
}

type MemoryEntry = {
  content: Uint8Array;
  refCount: number;
  createdAtMs: number;
  leases: Map<string, number>;
};

function pruneLeases(entry: MemoryEntry, nowMs: number): void {
  for (const [id, expiresAtMs] of entry.leases) {
    if (expiresAtMs <= nowMs) entry.leases.delete(id);
  }
}

export function createInMemoryBlobStore(): BlobStore {
  const entries = new Map<string, MemoryEntry>();
  return {
    durable: false,
    backend: 'memory',
    put: async ({ ownerId, mode, sha256, bytes, content }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const existing = entries.get(key);
      if (existing) {
        verifyContent({ content: existing.content, sha256, bytes });
        return { created: false };
      }
      const copy = Uint8Array.from(content);
      verifyContent({ content: copy, sha256, bytes });
      entries.set(key, { content: copy, refCount: 0, createdAtMs: Date.now(), leases: new Map() });
      return { created: true };
    },
    get: async ({ ownerId, mode, sha256 }) => {
      const content = entries.get(blobKey({ ownerId, mode, sha256 }));
      return content ? Uint8Array.from(content.content) : null;
    },
    acquire: async ({ ownerId, mode, sha256 }) => {
      const entry = entries.get(blobKey({ ownerId, mode, sha256 }));
      if (!entry) return false;
      entry.refCount += 1;
      return true;
    },
    release: async ({ ownerId, mode, sha256 }) => {
      const entry = entries.get(blobKey({ ownerId, mode, sha256 }));
      if (!entry) return 0;
      entry.refCount = Math.max(0, entry.refCount - 1);
      return entry.refCount;
    },
    lease: async ({ ref: { ownerId, mode, sha256 }, ttlMs }) => {
      const entry = entries.get(blobKey({ ownerId, mode, sha256 }));
      if (!entry) return null;
      const id = randomUUID();
      entry.leases.set(id, Date.now() + Math.max(1, Math.floor(ttlMs)));
      return id;
    },
    releaseLease: async ({ ref: { ownerId, mode, sha256 }, leaseId }) => {
      entries.get(blobKey({ ownerId, mode, sha256 }))?.leases.delete(leaseId);
    },
    deleteIfUnreferenced: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const entry = entries.get(key);
      if (!entry) return false;
      pruneLeases(entry, Date.now());
      if (entry.refCount > 0 || entry.leases.size > 0) return false;
      entries.delete(key);
      return true;
    },
    delete: async ({ ownerId, mode, sha256 }) => entries.delete(blobKey({ ownerId, mode, sha256 })),
    maintain: async () => {
      const now = Date.now();
      for (const entry of entries.values()) pruneLeases(entry, now);
      return { orphanChunks: 0, unreferencedBlobs: 0 };
    },
    reclaimLeaked: async () => 0,
    check: async () => undefined,
  };
}
