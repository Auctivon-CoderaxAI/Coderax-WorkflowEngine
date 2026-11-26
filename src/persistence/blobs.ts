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
 */
export type BlobRef = {
  ownerId: string;
  mode: DataMode;
  sha256: string;
};

export type BlobStore = {
  readonly durable: boolean;
  readonly backend: string;
  put: (
    input: BlobRef & { bytes: number; content: Uint8Array },
  ) => Promise<{ created: boolean }>;
  get: (ref: BlobRef) => Promise<Uint8Array | null>;
  delete: (ref: BlobRef) => Promise<boolean>;
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

export function createInMemoryBlobStore(): BlobStore {
  const entries = new Map<string, Uint8Array>();
  return {
    durable: false,
    backend: 'memory',
    put: async ({ ownerId, mode, sha256, bytes, content }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const existing = entries.get(key);
      if (existing) {
        verifyContent({ content: existing, sha256, bytes });
        return { created: false };
      }
      const copy = Uint8Array.from(content);
      verifyContent({ content: copy, sha256, bytes });
      entries.set(key, copy);
      return { created: true };
    },
    get: async ({ ownerId, mode, sha256 }) => {
      const content = entries.get(blobKey({ ownerId, mode, sha256 }));
      return content ? Uint8Array.from(content) : null;
    },
    delete: async ({ ownerId, mode, sha256 }) => entries.delete(blobKey({ ownerId, mode, sha256 })),
    check: async () => undefined,
  };
}
