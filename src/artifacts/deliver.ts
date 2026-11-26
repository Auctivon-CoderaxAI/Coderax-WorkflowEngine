import {
  DeliverableRequest,
  DocumentSourceArtifact,
  type ArtifactDescriptor,
  type DataMode,
  type Deliverable,
  type DeliverableRequestInput,
} from '@coderax/contracts';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactService } from './service.js';
import type { ArtifactToolkit, ResolvedBase, ToolkitContext } from './types.js';
import { persistProduced } from './persist.js';
import type { AuditLog } from '../observability/audit.js';
import type { Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { WorkspaceRoots } from '../execution/workspace.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * The deliverable use case.
 *
 * It owns exactly the sequence the artifact architecture requires: resolve an
 * isolated staging directory in the request's data mode, retrieve a base
 * artifact by id when the request revises one, generate and verify, persist
 * through the durable service, and remove staging. It creates no metadata of its
 * own and reports a created deliverable only after persistence returned
 * descriptors.
 */

const STAGING_DIRECTORY = '.deliverables';
const STAGING_MAX_AGE_MS = 3_600_000;
const SWEEP_LIMIT = 100;

export type DeliverOptions = {
  conversationId?: string;
  taskId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

export type DeliverableService = {
  deliver: (
    principal: Principal,
    request: DeliverableRequestInput,
    options?: DeliverOptions,
  ) => Promise<ServiceResult<Deliverable>>;
  /** Removes staging left by a process that died mid-generation. */
  sweepStaging: () => Promise<number>;
};

export type DeliverableServiceDeps = {
  toolkit: ArtifactToolkit;
  artifacts: ArtifactService;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  /** Validated, non-overlapping absolute roots, one per data mode. */
  roots: WorkspaceRoots;
};

function stagingPath(roots: WorkspaceRoots, mode: DataMode, id: string): string {
  return path.join(roots[mode], STAGING_DIRECTORY, id);
}

export function createDeliverableService(deps: DeliverableServiceDeps): DeliverableService {
  async function sweepStaging(): Promise<number> {
    let removed = 0;
    for (const mode of ['private', 'cloud'] as const) {
      const directory = path.join(deps.roots[mode], STAGING_DIRECTORY);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.slice(0, SWEEP_LIMIT)) {
        if (!entry.isDirectory()) continue;
        const full = path.join(directory, entry.name);
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        if (Date.now() - info.mtimeMs < STAGING_MAX_AGE_MS) continue;
        const deleted = await rm(full, { recursive: true, force: true }).then(
          () => true,
          () => false,
        );
        if (deleted) removed += 1;
      }
    }
    return removed;
  }

  /**
   * Downloads the base document into the request's staging directory and parses
   * it. The artifact must exist in the *request's* mode; a known id in the other
   * partition is reported as absent, which is what the durable service already
   * does and what keeps one mode from confirming the other.
   */
  async function resolveBase(
    principal: Principal,
    input: { artifactId: string; mode: DataMode; expectedVersion?: number },
    requestMode: DataMode,
  ): Promise<ServiceResult<ResolvedBase>> {
    if (input.mode !== requestMode) {
      return fail(
        'validation_failed',
        'The base artifact belongs to the other data mode and cannot be read by this request.',
      );
    }
    const content = await deps.artifacts.download(principal, input.artifactId, {
      mode: requestMode,
      ...(input.expectedVersion ? { version: input.expectedVersion } : {}),
    });
    if (!content.ok) return content;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(Buffer.from(content.value.contentBase64, 'base64').toString('utf8'));
    } catch {
      return fail('validation_failed', 'The base artifact is not a JSON document source.');
    }
    const source = DocumentSourceArtifact.safeParse(parsedJson);
    if (!source.success) {
      return fail(
        'validation_failed',
        'The base artifact is not a document source this engine produced.',
      );
    }
    return ok({
      artifactId: content.value.version.artifactId,
      version: content.value.version.version,
      model: source.data.document,
      outputs: source.data.outputs,
    });
  }

  async function deliver(
    principal: Principal,
    request: DeliverableRequestInput,
    options: DeliverOptions = {},
  ): Promise<ServiceResult<Deliverable>> {
    const parsed = DeliverableRequest.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'request';
      return fail('validation_failed', `${where}: ${issue?.message ?? 'invalid deliverable request'}`);
    }
    const normalised = parsed.data;
    const mode: DataMode = normalised.mode;
    const staging = stagingPath(deps.roots, mode, deps.ids.receipt());
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      if (options.signal?.aborted) {
        return fail('cancelled', 'The deliverable was cancelled before generation started.');
      }

      let base: ResolvedBase | undefined;
      if (normalised.kind === 'document' && normalised.base) {
        const resolved = await resolveBase(
          principal,
          {
            artifactId: normalised.base.artifactId,
            mode: normalised.base.mode,
            ...(normalised.base.expectedVersion
              ? { expectedVersion: normalised.base.expectedVersion }
              : {}),
          },
          mode,
        );
        if (!resolved.ok) {
          deps.audit.record({
            actor: principal.ownerId,
            action: 'deliverable.refused',
            outcome: 'refused',
            detail: `document edit ${resolved.code}`.slice(0, 300),
          });
          return resolved;
        }
        base = resolved.value;
      }

      const context: ToolkitContext = {
        mode,
        staging,
        clock: deps.clock,
        ids: deps.ids,
        ...(base ? { base } : {}),
      };

      const produced = await deps.toolkit.produce({ request: normalised, context });
      if (!produced.ok) {
        deps.audit.record({
          actor: principal.ownerId,
          action: 'deliverable.refused',
          outcome: 'refused',
          detail: `${normalised.kind} ${produced.code}`.slice(0, 300),
        });
        return produced;
      }

      // A generated project needs a project to belong to: the one the request
      // names, the one the caller associated, or a new one for this deliverable.
      const projectId =
        normalised.kind === 'software'
          ? (normalised.projectId ??
            options.projectId ??
            `proj_${deps.ids.receipt().replace(/^rcpt_/, '')}`)
          : options.projectId;

      const persisted = await persistProduced({
        artifacts: deps.artifacts,
        principal,
        mode,
        produced: produced.value,
        note: `deliverable:${normalised.kind}`,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!persisted.ok) return persisted;

      const receipt = deps.audit.record({
        actor: principal.ownerId,
        action: 'deliverable.created',
        outcome: 'accepted',
        detail: `${normalised.kind} ${persisted.value.descriptors.length} artifact(s) ${persisted.value.descriptors[0]?.sha256.slice(0, 12) ?? ''}`.slice(
          0,
          300,
        ),
      });

      const artifacts: ArtifactDescriptor[] = persisted.value.descriptors;
      return ok({
        kind: produced.value.kind,
        title: produced.value.title,
        summary: produced.value.summary,
        artifacts,
        verification: { ok: true, checks: produced.value.checks },
        receipt: { receiptId: receipt.receipt, at: receipt.at },
        ...(persisted.value.source ? { source: persisted.value.source } : {}),
        ...(persisted.value.project ? { project: persisted.value.project } : {}),
        ...(produced.value.analysis ? { analysis: produced.value.analysis } : {}),
      });
    } catch (error) {
      deps.audit.record({
        actor: principal.ownerId,
        action: 'deliverable.refused',
        outcome: 'refused',
        detail: `${parsed.data.kind} generation failed`.slice(0, 300),
      });
      const detail =
        error instanceof RangeError
          ? error.message
          : 'The deliverable could not be produced from that request.';
      return fail(error instanceof RangeError ? 'validation_failed' : 'internal_error', detail);
    } finally {
      // Staging holds the only copy of unverified bytes; it never survives the
      // request, whether generation, verification or persistence failed.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { deliver, sweepStaging };
}
