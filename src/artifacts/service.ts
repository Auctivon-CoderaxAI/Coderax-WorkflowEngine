import { createHash } from 'node:crypto';
import type {
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactKind,
  ArtifactMediaType,
  ArtifactProjectManifest,
  ArtifactPruneResult,
  ArtifactQuota,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactVersionDescriptor,
  ArtifactVersionList,
  ArtifactVersionRequest,
  DataMode,
} from '@coderax/contracts';
import type { ArtifactsSettings } from '../configuration/schema.js';
import type { ArtifactRecord, ArtifactVersionRecord } from '../domain.js';
import { artifactPathKey, type ArtifactKey, type ArtifactRepository } from '../persistence/artifacts.js';
import type { BlobRef, BlobStore } from '../persistence/blobs.js';
import { BlobIntegrityError, verifyContent } from '../persistence/blobs.js';
import type { CapacityReservation, CapacityStore } from '../persistence/capacity.js';
import { RESERVATION_TTL_MS } from '../persistence/capacity.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { AuditLog } from '../observability/audit.js';
import type { Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { decodeContent, validateContent, validateRelativePath } from './media.js';

/**
 * Durable artifacts.
 *
 * The service is the only writer of artifact metadata, and it writes only
 * through a content-addressed blob store that reports whether it is durable. A
 * deployment without durable storage refuses the write instead of succeeding
 * into a process that a restart will empty.
 *
 * Three rules are enforced here rather than trusted to callers:
 *
 * 1. Ownership and mode are part of every lookup. A known artifact id in the
 *    other data mode is reported as absent, not as forbidden, so the response
 *    does not confirm that it exists.
 * 2. Bytes are validated before they are stored: canonical base64, a signature
 *    that matches the declared media type, a bounded size, and no archive.
 * 3. Nothing here reaches an agent, a model or a gateway. Artifact content is
 *    returned only to the authenticated owner through the artifact operations.
 */

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const SWEEP_LIMIT = 500;
/** A download reads in-process, so a minute is ample; a crash releases by expiry. */
const READ_LEASE_TTL_MS = 60_000;

export type ArtifactService = {
  /** True only when the configured backend can survive a restart. */
  durable: boolean;
  backend: string;
  /** Rebuilds quota availability from committed rows; refuses while a reservation is live. */
  reconcile: () => Promise<void>;
  list: (
    principal: Principal,
    query: {
      mode?: DataMode;
      kind?: ArtifactKind;
      projectId?: string;
      conversationId?: string;
      taskId?: string;
      limit?: number;
    },
  ) => Promise<ServiceResult<ArtifactDescriptorList>>;
  get: (
    principal: Principal,
    artifactId: string,
    mode: DataMode,
  ) => Promise<ServiceResult<ArtifactDescriptor>>;
  versions: (
    principal: Principal,
    artifactId: string,
    mode: DataMode,
  ) => Promise<ServiceResult<ArtifactVersionList>>;
  restore: (
    principal: Principal,
    artifactId: string,
    request: { mode: DataMode; version: number; expectedVersion: number },
  ) => Promise<ServiceResult<ArtifactUploadResult>>;
  manifest: (
    principal: Principal,
    query: { mode: DataMode; projectId: string },
  ) => Promise<ServiceResult<ArtifactProjectManifest>>;
  upload: (
    principal: Principal,
    request: ArtifactUploadRequest,
  ) => Promise<ServiceResult<ArtifactUploadResult>>;
  addVersion: (
    principal: Principal,
    artifactId: string,
    request: ArtifactVersionRequest,
  ) => Promise<ServiceResult<ArtifactUploadResult>>;
  download: (
    principal: Principal,
    artifactId: string,
    query: { mode?: DataMode; version?: number },
  ) => Promise<ServiceResult<ArtifactContent>>;
  exportBundle: (
    principal: Principal,
    artifactId: string,
    query: { mode?: DataMode; version?: number },
  ) => Promise<ServiceResult<ArtifactExport>>;
  remove: (
    principal: Principal,
    artifactId: string,
    mode: DataMode,
  ) => Promise<ServiceResult<ArtifactDeleteResult>>;
  prune: (
    principal: Principal,
    mode: DataMode,
  ) => Promise<ServiceResult<ArtifactPruneResult>>;
  /** Startup and retention sweep; a non-durable store has nothing to sweep. */
  sweepExpiredArtifacts: () => Promise<ArtifactPruneResult>;
};

export type ArtifactServiceDeps = {
  artifacts: ArtifactRepository;
  blobs: BlobStore;
  capacity: CapacityStore;
  /** The single owner whose quota this instance reconciles and admits. */
  ownerId: string;
  conversations: ConversationRepository;
  tasks: TaskRepository;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  settings: ArtifactsSettings;
  /** Test seam; production uses the 60-second default. */
  readLeaseTtlMs?: number;
};

/**
 * A store error may be marked definitive only when the store guarantees that no
 * write landed. An ordinary thrown driver error is ambiguous: the write may have
 * committed before the connection failed. Releasing a reference or refunding an
 * admission on that error would corrupt a committed artifact, so the service
 * leaves both for the expiring reservation and leak reclamation to settle.
 */
function isDefinitiveStoreError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { definitive?: unknown }).definitive === true
  );
}

function storageFailure(error: unknown) {
  if (error instanceof BlobIntegrityError) {
    return fail(
      'internal_error',
      'Stored artifact content failed its integrity check and was not returned.',
    );
  }
  return fail('storage_unavailable', 'Durable artifact storage could not complete the operation.');
}

function durabilityFailure() {
  return fail(
    'storage_unavailable',
    'Durable artifact storage is not configured: persistence.driver=memory cannot survive a restart, so this write is refused rather than silently lost. Select persistence.driver=mongo with a reachable database.',
  );
}

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  const settings = deps.settings;

  function toDescriptor(record: ArtifactRecord): ArtifactDescriptor {
    return {
      artifactId: record.artifactId,
      kind: record.kind,
      filename: record.filename,
      ...(record.relativePath ? { relativePath: record.relativePath } : {}),
      mediaType: record.mediaType,
      bytes: record.bytes,
      sha256: record.sha256,
      mode: record.mode,
      version: record.version,
      versions: record.versions,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.taskId ? { taskId: record.taskId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      inferenceExposure: 'none',
    };
  }

  function toVersionDescriptor(record: ArtifactVersionRecord): ArtifactVersionDescriptor {
    return {
      artifactId: record.artifactId,
      version: record.version,
      filename: record.filename,
      ...(record.relativePath ? { relativePath: record.relativePath } : {}),
      mediaType: record.mediaType,
      kind: record.kind,
      bytes: record.bytes,
      sha256: record.sha256,
      createdAt: record.createdAt,
      ...(record.note ? { note: record.note } : {}),
    };
  }

  function quotaFor(usage: { bytes: number; artifacts: number }): ArtifactQuota {
    return {
      usedBytes: usage.bytes,
      maxBytes: settings.maxBytesPerOwner,
      artifacts: usage.artifacts,
      maxArtifacts: settings.maxArtifactsPerOwner,
    };
  }

  function associationFailure(detail: string) {
    return fail('not_found', detail);
  }

  async function resolveAssociations(input: {
    ownerId: string;
    mode: DataMode;
    conversationId?: string;
    taskId?: string;
  }): Promise<ServiceResult<{ conversationId: string | null; taskId: string | null }>> {
    let conversationTaskId: string | null = null;
    if (input.conversationId) {
      const conversation = await deps.conversations.get(input.ownerId, input.conversationId);
      if (!conversation || conversation.mode !== input.mode) {
        return associationFailure('That conversation does not exist for this owner.');
      }
    }
    if (input.taskId) {
      const task = await deps.tasks.get(input.taskId);
      if (!task || task.ownerId !== input.ownerId || task.mode !== input.mode) {
        return associationFailure('That task does not exist for this owner.');
      }
      conversationTaskId = task.conversationId;
      if (input.conversationId && conversationTaskId !== input.conversationId) {
        return fail(
          'validation_failed',
          'taskId and conversationId must belong to the same conversation.',
        );
      }
    }
    const conversationId = input.conversationId ?? conversationTaskId;
    return ok({ conversationId, taskId: input.taskId ?? null });
  }

  function expiryFor(
    requested: number | undefined,
    now: Date,
  ): ServiceResult<string | null> {
    const days = requested ?? settings.defaultRetentionDays;
    if (days === 0) return ok(null);
    if (days > settings.maxRetentionDays) {
      return fail(
        'validation_failed',
        `retentionDays must not exceed the configured maximum of ${settings.maxRetentionDays}.`,
      );
    }
    return ok(new Date(now.getTime() + days * 86_400_000).toISOString());
  }

  function kindAllowsProject(kind: ArtifactKind): boolean {
    return kind === 'project' || kind === 'game';
  }

  async function prepare(input: {
    filename: string;
    relativePath?: string;
    mediaType: ArtifactMediaType;
    contentBase64: string;
    sha256?: string;
    kind?: ArtifactKind;
    projectId?: string;
  }): Promise<ServiceResult<{
    filename: string;
    relativePath: string | null;
    pathKey: string | null;
    mediaType: ArtifactMediaType;
    kind: ArtifactKind;
    bytes: Buffer;
    sha256: string;
  }>> {
    const decoded = decodeContent(input.contentBase64);
    if (!decoded.ok) return fail(decoded.code, decoded.detail);

    const validated = validateContent({
      filename: input.filename,
      mediaType: input.mediaType,
      content: decoded.value,
      ...(input.kind ? { requestedKind: input.kind } : {}),
      ...(input.sha256 ? { declaredSha256: input.sha256 } : {}),
    });
    if (!validated.ok) return fail(validated.code, validated.detail);

    let relativePath: string | null = null;
    let pathKey: string | null = null;
    if (input.relativePath !== undefined) {
      const relative = validateRelativePath({
        path: input.relativePath,
        filename: validated.value.filename,
      });
      if (!relative.ok) return fail(relative.code, relative.detail);
      relativePath = relative.value;
      pathKey = artifactPathKey(relative.value);
      if (!input.projectId) {
        return fail(
          'validation_failed',
          'A relativePath is only valid on a file that names its projectId.',
        );
      }
    }

    if (validated.value.bytes.length > settings.maxBytesPerArtifact) {
      return fail(
        'payload_too_large',
        `An artifact may be at most ${settings.maxBytesPerArtifact} bytes.`,
      );
    }
    if (kindAllowsProject(validated.value.kind) && !input.projectId) {
      return fail(
        'validation_failed',
        'A project or game artifact must name the projectId it belongs to.',
      );
    }
    return ok({ ...validated.value, relativePath, pathKey });
  }

  /**
   * A project is a directory tree, not a bag of files. Reject a duplicate
   * case-folded path or a path that is both a file and a directory. The unique
   * index arbitrates the first race; this check also catches file/directory
   * conflicts that a unique index cannot express.
   */
  async function projectPathConflict(input: {
    principal: Principal;
    mode: DataMode;
    projectId: string | null;
    pathKey: string | null;
    excludeArtifactId?: string;
  }): Promise<boolean> {
    if (!input.projectId || !input.pathKey) return false;
    const records = await deps.artifacts.list(input.principal.ownerId, {
      mode: input.mode,
      projectId: input.projectId,
      limit: Math.max(1, settings.maxArtifactsPerOwner),
    });
    for (const record of records) {
      if (input.excludeArtifactId && record.artifactId === input.excludeArtifactId) continue;
      const existing =
        record.pathKey ?? (record.relativePath ? artifactPathKey(record.relativePath) : null);
      if (!existing) continue;
      if (existing === input.pathKey) return true;
      if (existing.startsWith(input.pathKey + '/') || input.pathKey.startsWith(existing + '/')) {
        return true;
      }
    }
    return false;
  }

  /** One version owns one reference; releasing it can delete only at zero. */
  async function releaseDigest(ref: {
    ownerId: string;
    mode: DataMode;
    sha256: string;
  }): Promise<void> {
    await deps.blobs.release(ref);
    await deps.blobs.deleteIfUnreferenced(ref);
  }

  /**
   * Writes the bytes once and takes a counted reference. A maintenance sweep can
   * delete a zero-reference blob between `put` and `acquire`; the retry re-puts
   * the same content and tries again. Only a genuine write failure escapes.
   */
  async function retainBytes(
    ref: { ownerId: string; mode: DataMode; sha256: string },
    content: Uint8Array,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deps.blobs.put({ ...ref, bytes: content.length, content });
      if (await deps.blobs.acquire(ref)) return true;
    }
    await deps.blobs.deleteIfUnreferenced(ref).catch(() => undefined);
    return false;
  }

  /**
   * Runs a read under a lease that renews itself. The initial 60 seconds is
   * ample for a 10 MiB in-process read, but a slow deployment can exceed it; a
   * renewal at one third of the TTL keeps an active authorized transfer alive.
   * A failed renewal is not silently ignored: the read either finishes from
   * bytes already verified or fails as unavailable, never as partial content.
   */
  async function withReadLease<T>(ref: BlobRef, read: () => Promise<T>): Promise<T | null> {
    const ttlMs = Math.max(10, Math.floor(deps.readLeaseTtlMs ?? READ_LEASE_TTL_MS));
    const acquired = await deps.blobs.lease({ ref, ttlMs });
    if (!acquired) return null;
    let leaseId: string = acquired;

    let stopped = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (stopped || renewing) return;
      renewing = true;
      void (async () => {
        try {
          const next = await deps.blobs.lease({ ref, ttlMs });
          if (!next) return;
          if (stopped) {
            await deps.blobs.releaseLease({ ref, leaseId: next }).catch(() => undefined);
            return;
          }
          const previous = leaseId;
          leaseId = next;
          await deps.blobs.releaseLease({ ref, leaseId: previous }).catch(() => undefined);
        } catch {
          // The old lease may still be live; the next tick retries. If it has
          // expired and a delete wins, the read fails closed below.
        } finally {
          renewing = false;
        }
      })();
    }, Math.max(10, Math.floor(ttlMs / 3)));
    timer.unref?.();

    try {
      return await read();
    } finally {
      stopped = true;
      clearInterval(timer);
      await deps.blobs.releaseLease({ ref, leaseId }).catch(() => undefined);
    }
  }

  function quotaFailure(reason: 'bytes' | 'artifacts') {
    return reason === 'artifacts'
      ? fail(
          'quota_exceeded',
          `The artifact count quota of ${settings.maxArtifactsPerOwner} is exhausted for this mode.`,
        )
      : fail(
          'quota_exceeded',
          `The artifact storage quota of ${settings.maxBytesPerOwner} bytes is exhausted for this mode.`,
        );
  }

  async function reserveQuota(input: {
    principal: Principal;
    mode: DataMode;
    bytes: number;
    artifacts: number;
    artifactId: string;
    version: number;
  }): Promise<ServiceResult<CapacityReservation>> {
    const decision = await deps.capacity.reserve({
      ownerId: input.principal.ownerId,
      mode: input.mode,
      bytes: input.bytes,
      artifacts: input.artifacts,
      artifactId: input.artifactId,
      version: input.version,
      now: deps.clock.iso(),
      maxBytes: settings.maxBytesPerOwner,
      maxArtifacts: settings.maxArtifactsPerOwner,
      ttlMs: RESERVATION_TTL_MS,
    });
    return decision.ok ? ok(decision.reservation) : quotaFailure(decision.reason);
  }

  /** Releases the references and the quota of an artifact that no longer exists. */
  async function refundRemoved(input: {
    ownerId: string;
    mode: DataMode;
    artifact: ArtifactRecord | null;
    versions: ArtifactVersionRecord[];
  }): Promise<number> {
    if (!input.artifact) return 0;
    const bytes = input.versions.reduce((total, row) => total + row.bytes, 0);
    for (const row of input.versions) {
      await releaseDigest({
        ownerId: input.ownerId,
        mode: input.mode,
        sha256: row.sha256,
      });
    }
    await deps.capacity.refund({
      ownerId: input.ownerId,
      mode: input.mode,
      bytes,
      artifacts: 1,
    });
    return bytes;
  }

  /**
   * Resolves admissions that outlived their process. A reservation whose version
   * row exists is committed; one whose row never materialized returns its quota.
   */
  async function sweepReservations(at: string): Promise<void> {
    const expired = await deps.capacity.expired({ now: at, limit: SWEEP_LIMIT });
    for (const reservation of expired) {
      const materialized = await deps.artifacts.version({
        ownerId: reservation.ownerId,
        mode: reservation.mode,
        artifactId: reservation.artifactId,
        version: reservation.version,
      });
      if (materialized) await deps.capacity.commit(reservation);
      else await deps.capacity.release(reservation);
    }
    await deps.capacity.discardStale({
      before: new Date(Date.parse(at) - 3_600_000).toISOString(),
      limit: SWEEP_LIMIT,
    });
  }

  function audit(input: {
    ownerId: string;
    action: string;
    artifactId: string;
    mode: DataMode;
    detail: string;
  }): void {
    deps.audit.record({
      actor: input.ownerId,
      action: input.action,
      outcome: 'accepted',
      detail: `${input.mode} ${input.artifactId} ${input.detail}`.slice(0, 300),
    });
  }

  async function pruneVersions(key: ArtifactKey, currentVersion: number): Promise<number> {
    const rows = await deps.artifacts.versions(key);
    let released = 0;
    let count = rows.length;
    for (const row of rows) {
      if (count <= settings.maxVersionsPerArtifact) break;
      if (row.version === currentVersion) continue;
      const removed = await deps.artifacts.removeVersion({ ...key, version: row.version });
      if (!removed) continue;
      count -= 1;
      released += removed.bytes;
      await releaseDigest({
        ownerId: key.ownerId,
        mode: key.mode,
        sha256: removed.sha256,
      });
      await deps.capacity.refund({
        ownerId: key.ownerId,
        mode: key.mode,
        bytes: removed.bytes,
        artifacts: 0,
      });
    }
    return released;
  }

  async function guard<T>(run: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    try {
      return await run();
    } catch (error) {
      return storageFailure(error);
    }
  }

  const service: ArtifactService = {
    durable: deps.blobs.durable,
    backend: deps.blobs.backend,

    list: (principal, query) =>
      guard(async () => {
        const mode: DataMode = query.mode ?? 'private';
        const records = await deps.artifacts.list(principal.ownerId, {
          mode,
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
          ...(query.taskId ? { taskId: query.taskId } : {}),
          limit: Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
        });
        const usage = await deps.artifacts.usage({ ownerId: principal.ownerId, mode });
        return ok({ artifacts: records.map(toDescriptor), quota: quotaFor(usage) });
      }),

    get: (principal, artifactId, mode) =>
      guard(async () => {
        const record = await deps.artifacts.get({
          ownerId: principal.ownerId,
          mode,
          artifactId,
        });
        if (!record) return fail('not_found', 'That artifact does not exist for this owner.');
        return ok(toDescriptor(record));
      }),

    versions: (principal, artifactId, mode) =>
      guard(async () => {
        const key = { ownerId: principal.ownerId, mode, artifactId };
        const artifact = await deps.artifacts.get(key);
        if (!artifact) return fail('not_found', 'That artifact does not exist for this owner.');
        const rows = await deps.artifacts.versions(key);
        return ok({ artifactId, versions: rows.map(toVersionDescriptor) });
      }),

    upload: (principal, request) =>
      guard(async () => {
        if (!deps.blobs.durable) return durabilityFailure();

        const prepared = await prepare({
          filename: request.filename,
          ...(request.relativePath ? { relativePath: request.relativePath } : {}),
          mediaType: request.mediaType,
          contentBase64: request.contentBase64,
          ...(request.sha256 ? { sha256: request.sha256 } : {}),
          ...(request.kind ? { kind: request.kind } : {}),
          ...(request.projectId ? { projectId: request.projectId } : {}),
        });
        if (!prepared.ok) return prepared;
        if (
          await projectPathConflict({
            principal,
            mode: request.mode,
            projectId: request.projectId ?? null,
            pathKey: prepared.value.pathKey,
          })
        ) {
          return fail(
            'conflict',
            'That relativePath already names a file or directory in this project.',
          );
        }

        const associations = await resolveAssociations({
          ownerId: principal.ownerId,
          mode: request.mode,
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(request.taskId ? { taskId: request.taskId } : {}),
        });
        if (!associations.ok) return associations;

        const now = deps.clock.now();
        const expires = expiryFor(request.retentionDays, now);
        if (!expires.ok) return expires;

        const artifactId = deps.ids.artifactId();
        const sha256 = prepared.value.sha256;
        const bytes = prepared.value.bytes.length;
        const createdAt = now.toISOString();

        // Admission is one conditional decrement on the durable capacity row,
        // not a usage read followed by a write. Two replicas racing the last
        // byte cannot both be admitted.
        const reservation = await reserveQuota({
          principal,
          mode: request.mode,
          bytes,
          artifacts: 1,
          artifactId,
          version: 1,
        });
        if (!reservation.ok) return reservation;

        const ref = { ownerId: principal.ownerId, mode: request.mode, sha256 };
        try {
          if (!(await retainBytes(ref, prepared.value.bytes))) {
            await deps.capacity.release(reservation.value).catch(() => undefined);
            return fail(
              'storage_unavailable',
              'The artifact bytes could not be written durably, so no quota was kept.',
            );
          }
        } catch (error) {
          if (isDefinitiveStoreError(error)) {
            await deps.capacity.release(reservation.value).catch(() => undefined);
          }
          throw error;
        }

        const artifact: ArtifactRecord = {
          artifactId,
          ownerId: principal.ownerId,
          tenantId: null,
          mode: request.mode,
          kind: prepared.value.kind,
          filename: prepared.value.filename,
          ...(prepared.value.relativePath
            ? { relativePath: prepared.value.relativePath }
            : {}),
          ...(prepared.value.pathKey ? { pathKey: prepared.value.pathKey } : {}),
          mediaType: prepared.value.mediaType,
          bytes,
          sha256,
          version: 1,
          versions: 1,
          projectId: request.projectId ?? null,
          conversationId: associations.value.conversationId,
          taskId: associations.value.taskId,
          createdAt,
          updatedAt: createdAt,
          expiresAt: expires.value,
        };
        const version: ArtifactVersionRecord = {
          ownerId: principal.ownerId,
          mode: request.mode,
          artifactId,
          version: 1,
          filename: prepared.value.filename,
          ...(prepared.value.relativePath
            ? { relativePath: prepared.value.relativePath }
            : {}),
          mediaType: prepared.value.mediaType,
          kind: prepared.value.kind,
          bytes,
          sha256,
          ...(request.note ? { note: request.note } : {}),
          createdAt,
        };

        const created = await deps.artifacts.create({ artifact, version }).catch(
          async (error: unknown) => {
            if (isDefinitiveStoreError(error)) {
              await releaseDigest(ref).catch(() => undefined);
              await deps.capacity.release(reservation.value).catch(() => undefined);
            }
            throw error;
          },
        );
        if (!created.ok) {
          await releaseDigest(ref).catch(() => undefined);
          await deps.capacity.release(reservation.value).catch(() => undefined);
          return fail('conflict', 'That artifact identity is already in use.');
        }

        // The version row exists, so the admission is committed usage. A failed
        // commit is not a failed upload: the reservation expires and the sweep
        // sees the version row and commits it without a refund.
        await deps.capacity.commit(reservation.value).catch(() => undefined);

        audit({
          ownerId: principal.ownerId,
          action: 'artifact.stored',
          artifactId,
          mode: request.mode,
          detail: `kind=${prepared.value.kind} bytes=${bytes} sha256=${sha256.slice(0, 12)}`,
        });
        return ok({ artifact: toDescriptor(artifact), version: toVersionDescriptor(version) });
      }),

    addVersion: (principal, artifactId, request) =>
      guard(async () => {
        if (!deps.blobs.durable) return durabilityFailure();

        const key = { ownerId: principal.ownerId, mode: request.mode, artifactId };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = await deps.artifacts.get(key);
          if (!current) return fail('not_found', 'That artifact does not exist for this owner.');

          const prepared = await prepare({
            filename: request.filename,
            ...(request.relativePath ? { relativePath: request.relativePath } : {}),
            mediaType: request.mediaType,
            contentBase64: request.contentBase64,
            ...(request.sha256 ? { sha256: request.sha256 } : {}),
            ...(request.kind ? { kind: request.kind } : {}),
            ...(current.projectId ? { projectId: current.projectId } : {}),
          });
          if (!prepared.ok) return prepared;
          if (
            await projectPathConflict({
              principal,
              mode: request.mode,
              projectId: current.projectId,
              pathKey: prepared.value.pathKey,
              excludeArtifactId: artifactId,
            })
          ) {
            return fail(
              'conflict',
              'That relativePath already names another file or directory in this project.',
            );
          }

          const now = deps.clock.now();
          const expires =
            request.retentionDays === undefined
              ? ok(current.expiresAt)
              : expiryFor(request.retentionDays, now);
          if (!expires.ok) return expires;

          const sha256 = prepared.value.sha256;
          const bytes = prepared.value.bytes.length;
          const nextVersion = current.version + 1;
          const reservation = await reserveQuota({
            principal,
            mode: request.mode,
            bytes,
            artifacts: 0,
            artifactId,
            version: nextVersion,
          });
          if (!reservation.ok) return reservation;

          const ref = { ownerId: principal.ownerId, mode: request.mode, sha256 };
          try {
            if (!(await retainBytes(ref, prepared.value.bytes))) {
              await deps.capacity.release(reservation.value).catch(() => undefined);
              return fail(
                'storage_unavailable',
                'The artifact bytes could not be written durably, so no quota was kept.',
              );
            }
          } catch (error) {
            if (isDefinitiveStoreError(error)) {
              await deps.capacity.release(reservation.value).catch(() => undefined);
            }
            throw error;
          }

          const updated: ArtifactRecord = {
            ...current,
            ...(prepared.value.relativePath
              ? { relativePath: prepared.value.relativePath }
              : {}),
            ...(prepared.value.pathKey ? { pathKey: prepared.value.pathKey } : {}),
            kind: prepared.value.kind,
            filename: prepared.value.filename,
            mediaType: prepared.value.mediaType,
            bytes,
            sha256,
            version: nextVersion,
            versions: current.versions + 1,
            updatedAt: now.toISOString(),
            expiresAt: expires.value,
          };
          const version: ArtifactVersionRecord = {
            ownerId: principal.ownerId,
            mode: request.mode,
            artifactId,
            version: nextVersion,
            filename: prepared.value.filename,
            ...(prepared.value.relativePath
              ? { relativePath: prepared.value.relativePath }
              : {}),
            mediaType: prepared.value.mediaType,
            kind: prepared.value.kind,
            bytes,
            sha256,
            ...(request.note ? { note: request.note } : {}),
            createdAt: now.toISOString(),
          };

          const appended = await deps.artifacts
            .appendVersion({
              artifact: updated,
              expectedVersion: current.version,
              version,
            })
            .catch(async (error: unknown) => {
              if (isDefinitiveStoreError(error)) {
                await releaseDigest(ref).catch(() => undefined);
                await deps.capacity.release(reservation.value).catch(() => undefined);
              }
              throw error;
            });
          if (!appended.ok) {
            await releaseDigest(ref).catch(() => undefined);
            await deps.capacity.release(reservation.value).catch(() => undefined);
            if (appended.reason === 'conflict' && attempt === 0) continue;
            return appended.reason === 'not_found'
              ? fail('not_found', 'That artifact does not exist for this owner.')
              : fail('conflict', 'That artifact changed concurrently; retry the upload.');
          }

          // The version row exists, so this admission is committed usage. A
          // lost commit is resolved by the expiry sweep against that row.
          await deps.capacity.commit(reservation.value).catch(() => undefined);
          // The version is durable; a failed prune is a retained old version,
          // not a failed upload, so it must not turn a committed write into an
          // error response the client would retry as a second version.
          const released = await pruneVersions(key, nextVersion).catch(() => 0);

          audit({
            ownerId: principal.ownerId,
            action: 'artifact.versioned',
            artifactId,
            mode: request.mode,
            detail: `version=${nextVersion} bytes=${bytes} sha256=${sha256.slice(0, 12)} pruned=${released}`,
          });
          // Re-read after pruning: the response must describe the retained set,
          // not the pre-prune count.
          const finalArtifact = (await deps.artifacts.get(key)) ?? updated;
          return ok({
            artifact: toDescriptor(finalArtifact),
            version: toVersionDescriptor(version),
          });
        }
        return fail('conflict', 'That artifact changed concurrently; retry the upload.');
      }),

    download: (principal, artifactId, query) =>
      guard(async () => {
        const mode: DataMode = query.mode ?? 'private';
        const key = { ownerId: principal.ownerId, mode, artifactId };
        const artifact = await deps.artifacts.get(key);
        if (!artifact) return fail('not_found', 'That artifact does not exist for this owner.');
        const versionNumber = query.version ?? artifact.version;
        const version = await deps.artifacts.version({ ...key, version: versionNumber });
        if (!version) return fail('not_found', 'That artifact version does not exist.');
        const ref = { ownerId: principal.ownerId, mode, sha256: version.sha256 };
        const result = await withReadLease(ref, async () => {
          const content = await deps.blobs.get(ref);
          if (!content) return null;
          verifyContent({ content, sha256: version.sha256, bytes: version.bytes });
          return {
            artifact: toDescriptor(artifact),
            version: toVersionDescriptor(version),
            contentBase64: Buffer.from(content).toString('base64'),
          };
        });
        if (!result) {
          return fail(
            'storage_unavailable',
            'The stored bytes are unavailable; the artifact was not reconstructed from memory.',
          );
        }
        return ok(result);
      }),

    restore: (principal, artifactId, request) =>
      guard(async () => {
        if (!deps.blobs.durable) return durabilityFailure();
        const key = { ownerId: principal.ownerId, mode: request.mode, artifactId };
        const current = await deps.artifacts.get(key);
        if (!current) return fail('not_found', 'That artifact does not exist for this owner.');
        const restored = await deps.artifacts.restoreVersion({
          ...key,
          version: request.version,
          expectedVersion: request.expectedVersion,
          now: deps.clock.iso(),
        });
        if (!restored.ok) {
          return restored.reason === 'not_found'
            ? fail('not_found', 'That artifact version does not exist.')
            : fail('conflict', 'That artifact changed concurrently; retry the restore.');
        }
        audit({
          ownerId: principal.ownerId,
          action: 'artifact.restored',
          artifactId,
          mode: request.mode,
          detail: `version=${restored.version.version} sha256=${restored.version.sha256.slice(0, 12)}`,
        });
        return ok({
          artifact: toDescriptor(restored.artifact),
          version: toVersionDescriptor(restored.version),
        });
      }),

    manifest: (principal, query) =>
      guard(async () => {
        const records = await deps.artifacts.list(principal.ownerId, {
          mode: query.mode,
          projectId: query.projectId,
          limit: Math.max(1, settings.maxArtifactsPerOwner),
        });
        const files = records
          .filter(
            (record): record is ArtifactRecord & { relativePath: string } =>
              typeof record.relativePath === 'string' && record.relativePath.length > 0,
          )
          .map((record) => ({
            relativePath: record.relativePath,
            artifactId: record.artifactId,
            version: record.version,
            sha256: record.sha256,
            bytes: record.bytes,
            mediaType: record.mediaType,
            kind: record.kind,
          }))
          .sort((left, right) =>
            artifactPathKey(left.relativePath).localeCompare(artifactPathKey(right.relativePath)),
          );

        const keys = new Set(files.map((file) => artifactPathKey(file.relativePath)));
        if (keys.size !== files.length) {
          return fail('conflict', 'The project manifest has two entries for the same path.');
        }
        for (const file of files) {
          const key = artifactPathKey(file.relativePath);
          let slash = key.indexOf('/');
          while (slash !== -1) {
            if (keys.has(key.slice(0, slash))) {
              return fail('conflict', 'The project manifest has a file and a directory at one path.');
            }
            slash = key.indexOf('/', slash + 1);
          }
        }

        const digest = createHash('sha256')
          .update(JSON.stringify({ projectId: query.projectId, mode: query.mode, files }))
          .digest('hex');
        return ok({
          projectId: query.projectId,
          mode: query.mode,
          files,
          digest,
          generatedAt: deps.clock.iso(),
        });
      }),

    exportBundle: (principal, artifactId, query) =>
      guard(async () => {
        const mode: DataMode = query.mode ?? 'private';
        const key = { ownerId: principal.ownerId, mode, artifactId };
        const artifact = await deps.artifacts.get(key);
        if (!artifact) return fail('not_found', 'That artifact does not exist for this owner.');
        const rows = await deps.artifacts.versions(key);
        const versionNumber = query.version ?? artifact.version;
        const version = rows.find((row) => row.version === versionNumber);
        if (!version) return fail('not_found', 'That artifact version does not exist.');
        const ref = { ownerId: principal.ownerId, mode, sha256: version.sha256 };
        const result = await withReadLease(ref, async () => {
          const content = await deps.blobs.get(ref);
          if (!content) return null;
          verifyContent({ content, sha256: version.sha256, bytes: version.bytes });
          return {
            artifact: toDescriptor(artifact),
            versions: rows.map(toVersionDescriptor),
            version: toVersionDescriptor(version),
            contentBase64: Buffer.from(content).toString('base64'),
            exportedAt: deps.clock.iso(),
          };
        });
        if (!result) {
          return fail(
            'storage_unavailable',
            'The stored bytes are unavailable; the export was not fabricated.',
          );
        }
        return ok(result);
      }),

    remove: (principal, artifactId, mode) =>
      guard(async () => {
        const key = { ownerId: principal.ownerId, mode, artifactId };
        const removed = await deps.artifacts.remove(key);
        const releasedBytes = await refundRemoved({
          ownerId: principal.ownerId,
          mode,
          artifact: removed.artifact,
          versions: removed.versions,
        });
        if (!removed.artifact) {
          return fail('not_found', 'That artifact does not exist for this owner.');
        }
        audit({
          ownerId: principal.ownerId,
          action: 'artifact.deleted',
          artifactId,
          mode,
          detail: `versions=${removed.versions.length} bytes=${releasedBytes}`,
        });
        return ok({
          artifactId,
          deletedVersions: removed.versions.length,
          releasedBytes,
        });
      }),

    prune: (principal, mode) =>
      guard(async () => {
        const at = deps.clock.iso();
        await sweepReservations(at);
        const expired = await deps.artifacts.listExpired({
          now: at,
          limit: SWEEP_LIMIT,
          ownerId: principal.ownerId,
          mode,
        });
        let releasedBytes = 0;
        for (const record of expired) {
          const removed = await deps.artifacts.remove({
            ownerId: record.ownerId,
            mode: record.mode,
            artifactId: record.artifactId,
          });
          releasedBytes += await refundRemoved({
            ownerId: record.ownerId,
            mode: record.mode,
            artifact: removed.artifact,
            versions: removed.versions,
          });
        }
        if (expired.length > 0) {
          audit({
            ownerId: principal.ownerId,
            action: 'artifact.pruned',
            artifactId: `${expired.length}`,
            mode,
            detail: `artifacts=${expired.length} bytes=${releasedBytes}`,
          });
        }
        return ok({ pruned: expired.length, releasedBytes, at });
      }),

    reconcile: async () => {
      if (!deps.blobs.durable) return;
      for (const mode of ['private', 'cloud'] as const) {
        const usage = await deps.artifacts.usage({ ownerId: deps.ownerId, mode });
        await deps.capacity.reconcile({
          ownerId: deps.ownerId,
          mode,
          usedBytes: usage.bytes,
          usedArtifacts: usage.artifacts,
          maxBytes: settings.maxBytesPerOwner,
          maxArtifacts: settings.maxArtifactsPerOwner,
        });
      }
      await deps.capacity.discardStale({
        before: new Date(deps.clock.now().getTime() - 3_600_000).toISOString(),
        limit: SWEEP_LIMIT,
      });
    },

    sweepExpiredArtifacts: async () => {
      const at = deps.clock.iso();
      if (!deps.blobs.durable) return { pruned: 0, releasedBytes: 0, at };
      // Reclaim abandoned chunks and old zero-reference blobs, then resolve
      // admissions whose process died. Both are bounded so startup stays fast.
      await deps.blobs.maintain({ graceMs: 86_400_000, limit: 200 });
      // A process can die after its metadata rows are removed but before every
      // reference is released. Such a blob has an old reference timestamp and
      // no version row, so it is a leak rather than a live artifact.
      await deps.blobs.reclaimLeaked({
        graceMs: 86_400_000,
        limit: 200,
        referenced: (ref) => deps.artifacts.referenced(ref),
      });
      await sweepReservations(at);
      const expired = await deps.artifacts.listExpired({ now: at, limit: SWEEP_LIMIT });
      let releasedBytes = 0;
      for (const record of expired) {
        const removed = await deps.artifacts.remove({
          ownerId: record.ownerId,
          mode: record.mode,
          artifactId: record.artifactId,
        });
        releasedBytes += await refundRemoved({
          ownerId: record.ownerId,
          mode: record.mode,
          artifact: removed.artifact,
          versions: removed.versions,
        });
      }
      return { pruned: expired.length, releasedBytes, at };
    },
  };

  return service;
}
