import { createHash } from 'node:crypto';
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
  /** Deletes only while the count is still zero; a concurrent acquire wins. */
  deleteIfUnreferenced: (ref: BlobRef) => Promise<boolean>;
  /** Unconditional delete, for maintenance and tests; never a normal release. */
  delete: (ref: BlobRef) => Promise<boolean>;
  /** Removes abandoned chunks and long-unreferenced descriptors, in bounds. */
  maintain: (input: { graceMs: number; limit: number }) => Promise<BlobMaintenance>;
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
};

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
      entries.set(key, { content: copy, refCount: 0, createdAtMs: Date.now() });
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
    deleteIfUnreferenced: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const entry = entries.get(key);
      if (!entry || entry.refCount > 0) return false;
      entries.delete(key);
      return true;
    },
    delete: async ({ ownerId, mode, sha256 }) => entries.delete(blobKey({ ownerId, mode, sha256 })),
    maintain: async () => ({ orphanChunks: 0, unreferencedBlobs: 0 }),
    check: async () => undefined,
  };
}
