import type {
  ArtifactDescriptor,
  ArtifactKind,
  ArtifactMediaType,
  DataMode,
  Deliverable,
  DeliverableRequestInput,
  VerificationCheck,
} from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import type { Clock, IdGenerator } from '../support/clock.js';

/**
 * The artifact layer has no dependency on persistence, HTTP or orchestration.
 *
 * It receives a confined workspace root, an authorization callback for writes
 * and a receipt sink; everything else (leases, task state, permissions) stays
 * with the modules that already own it. That is what lets the same toolkit run
 * inside a Coderax Native task and behind an owner-initiated API call without
 * creating a second execution runtime.
 */

export type WriteAuthorization = (input: {
  mode: DataMode;
  relativePath: string;
}) => Promise<boolean> | boolean;

export type ReceiptSink = (input: {
  action: 'deliverable.created' | 'deliverable.refused';
  outcome: 'completed' | 'refused';
  detail: string;
}) => { receipt: string; at: string };

/**
 * The durable artifact service, seen from the toolkit. A produced file is staged
 * and verified inside the confined workspace, then committed here. Returning a
 * workspace path without a descriptor would be a false success, so the port is
 * mandatory and a refusal fails the deliverable.
 */
export type PersistArtifact = (input: {
  filename: string;
  mediaType: ArtifactMediaType;
  /** Optional hint; the durable service derives the authoritative kind. */
  kind?: ArtifactKind;
  data: Buffer | string;
  title?: string;
  /** Validated project-relative path for a file inside a source tree. */
  relativePath?: string;
  /** Groups every file of one generated tree. */
  projectId?: string;
  /** The digest the toolkit verified locally; the service re-checks it. */
  sha256?: string;
}) => Promise<ArtifactDescriptor>;

export class ArtifactPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPersistError';
  }
}

export type ToolkitContext = {
  mode: DataMode;
  /** Absolute, already validated workspace root for the mode. */
  root: string;
  clock: Clock;
  ids: IdGenerator;
  authorize: WriteAuthorization;
  receipts: ReceiptSink;
  persist: PersistArtifact;
};

export type ProduceInput = {
  request: DeliverableRequestInput;
  context: ToolkitContext;
};

export type ArtifactToolkit = {
  produce: (input: ProduceInput) => Promise<ServiceResult<Deliverable>>;
};

export type WrittenArtifact = {
  /** Workspace-relative path, using forward slashes. */
  path: string;
  bytes: number;
  digest: string;
};

export type CheckList = VerificationCheck[];

export function checksPass(checks: CheckList): boolean {
  return checks.every((check) => check.ok);
}

/** A deterministic, path-safe folder name; no random component is needed. */
export function runFolder(input: { clock: Clock; slug: string }): string {
  const stamp = input.clock
    .now()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '');
  return `deliverables/${stamp}-${input.slug}`;
}

export function slugOf(value: string, fallback = 'deliverable'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}
