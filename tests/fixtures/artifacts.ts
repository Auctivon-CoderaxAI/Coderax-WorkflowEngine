import type { ArtifactMediaType, DataMode } from '@coderax/contracts';
import { ArtifactsConfig, type ArtifactsSettings } from '../../src/configuration/schema.js';
import type { ArtifactRecord, ArtifactVersionRecord } from '../../src/domain.js';
import { createArtifactRepository } from '../../src/persistence/artifacts.js';
import { createInMemoryBlobStore, type BlobStore } from '../../src/persistence/blobs.js';
import { createInMemoryCapacityStore } from '../../src/persistence/capacity.js';
import { createConversationRepository } from '../../src/persistence/conversations.js';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import { createArtifactService, type ArtifactService } from '../../src/artifacts/service.js';
import { createAuditLog } from '../../src/observability/audit.js';
import { createIdGenerator, type Clock } from '../../src/support/clock.js';
import type { Principal } from '../../src/security/auth.js';
import { OWNER_ID } from '../helpers.js';

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Minimal byte signatures. The validator decides on the signature, not on the
 * full container, so these are enough to prove detection without embedding
 * binary fixtures in the repository.
 */
export function pngBytes(extra = 'IHDR'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(extra, 'latin1'),
  ]);
}

export function jpegBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF', 'latin1')]);
}

export function pdfBytes(text = 'artifact'): Buffer {
  return Buffer.from(`%PDF-1.7\n${text}\n%%EOF`, 'latin1');
}

export function textBytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

export function codeBytes(): Buffer {
  return Buffer.from('export const answer = 42;\n', 'utf8');
}

export function zipBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('PK\x03\x04payload-that-is-not-an-office-document', 'latin1'),
  ]);
}

export function ooxmlBytes(kind: 'docx' | 'xlsx' | 'pptx'): Buffer {
  const folder = kind === 'docx' ? 'word/' : kind === 'xlsx' ? 'xl/' : 'ppt/';
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`[Content_Types].xml ${folder}document.xml`, 'latin1'),
  ]);
}

export function odfBytes(kind: 'text' | 'spreadsheet' | 'presentation'): Buffer {
  const mime = `application/vnd.oasis.opendocument.${kind}`;
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`mimetype${mime}`, 'latin1'),
  ]);
}

export type MutableClock = Clock & { advance: (ms: number) => void };

export function mutableClock(start = '2026-01-01T00:00:00.000Z'): MutableClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    iso: () => current.toISOString(),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** An in-memory store presented as durable, for behavior tests only. */
export function testDurableBlobs(): BlobStore {
  const store = createInMemoryBlobStore();
  return { ...store, durable: true, backend: 'memory-test' };
}

export function artifactSettings(overrides: Record<string, unknown> = {}): ArtifactsSettings {
  return ArtifactsConfig.parse(overrides);
}

export type ArtifactHarness = {
  service: ArtifactService;
  repository: ReturnType<typeof createArtifactRepository>;
  blobs: BlobStore;
  conversations: ReturnType<typeof createConversationRepository>;
  tasks: ReturnType<typeof createTaskRepository>;
  audit: ReturnType<typeof createAuditLog>;
  clock: MutableClock;
  settings: ArtifactsSettings;
  owner: Principal;
  other: Principal;
};

export function artifactHarness(
  options: {
    settings?: Record<string, unknown>;
    durable?: boolean;
    blobs?: BlobStore;
    readLeaseTtlMs?: number;
  } = {},
): ArtifactHarness {
  const clock = mutableClock();
  const ids = createIdGenerator();
  const conversations = createConversationRepository();
  const tasks = createTaskRepository();
  const audit = createAuditLog({ clock, ids });
  const repository = createArtifactRepository();
  const blobs =
    options.blobs ??
    (options.durable === false ? createInMemoryBlobStore() : testDurableBlobs());
  const capacity = createInMemoryCapacityStore();
  const settings = artifactSettings(options.settings);
  const service = createArtifactService({
    artifacts: repository,
    blobs,
    capacity,
    ownerId: OWNER_ID,
    conversations,
    tasks,
    audit,
    clock,
    ids,
    settings,
    ...(options.readLeaseTtlMs !== undefined
      ? { readLeaseTtlMs: options.readLeaseTtlMs }
      : {}),
  });
  return {
    service,
    repository,
    blobs,
    conversations,
    tasks,
    audit,
    clock,
    settings,
    owner: { ownerId: OWNER_ID, isOwner: true },
    other: { ownerId: 'owner-other', isOwner: true },
  };
}

export function artifactRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    artifactId: 'art_test',
    ownerId: OWNER_ID,
    tenantId: null,
    mode: 'cloud',
    kind: 'pdf',
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    bytes: 32,
    sha256: 'a'.repeat(64),
    version: 1,
    versions: 1,
    projectId: null,
    conversationId: null,
    taskId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    ...overrides,
  };
}

export function versionRecord(
  overrides: Partial<ArtifactVersionRecord> = {},
): ArtifactVersionRecord {
  return {
    ownerId: OWNER_ID,
    mode: 'cloud' as DataMode,
    artifactId: 'art_test',
    version: 1,
    filename: 'report.pdf',
    mediaType: 'application/pdf' as ArtifactMediaType,
    kind: 'pdf',
    bytes: 32,
    sha256: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
