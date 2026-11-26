import type {
  ArtifactKind,
  ArtifactMediaType,
  DataMode,
  DatasetAnalysis,
  DeliverableKind,
  DeliverableRequestInput,
  DocumentFormat,
  StoredDocument,
  VerificationCheck,
} from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import type { Clock, IdGenerator } from '../support/clock.js';

/**
 * The generation layer has no dependency on persistence, HTTP or orchestration.
 *
 * It receives an isolated staging directory that the caller created and owns. It
 * writes files there only, verifies them by reading them back, and hands the
 * staged bytes to the caller. It never claims an artifact exists: only the
 * durable service creates artifact metadata, and a deliverable is reported as
 * created only after every staged file was stored there.
 */

export type StagedRole = 'source' | 'output' | 'part';

/**
 * One file produced in staging, described by the metadata the durable store
 * needs. `filename` is flat and unique inside one deliverable because the
 * artifact store treats a file name as metadata, never as a path.
 */
export type StagedArtifact = {
  filename: string;
  /** Absolute path inside the caller-owned staging directory. */
  absolute: string;
  bytes: number;
  /** Lowercase hex, matching the artifact contract's `sha256`. */
  sha256: string;
  kind: ArtifactKind;
  mediaType: ArtifactMediaType;
  title: string;
  role: StagedRole;
  /** Which document format this file is, when it is one. */
  format?: DocumentFormat;
  /** Project-relative path for a generated software tree. */
  projectPath?: string;
  /**
   * Present when this file revises an artifact the caller resolved. The
   * persistence adapter appends a version with this expected version instead of
   * creating a second artifact, so history stays on one identity and a
   * concurrent edit is refused rather than overwritten.
   */
  versionOf?: { artifactId: string; expectedVersion?: number };
};

/** One previously produced artifact of a document being revised. */
export type ResolvedBaseOutput = {
  format: DocumentFormat;
  artifactId: string;
  version: number;
  filename: string;
};

/**
 * A base document the caller downloaded from the durable store and validated.
 * The toolkit never reaches the store itself; it receives the resolved model and
 * the identities its regenerated files must revise.
 */
export type ResolvedBase = {
  artifactId: string;
  version: number;
  model: StoredDocument;
  outputs: ResolvedBaseOutput[];
};

export type ToolkitContext = {
  mode: DataMode;
  /** Absolute, engine-owned staging root; the caller removes it afterwards. */
  staging: string;
  clock: Clock;
  ids: IdGenerator;
  /** Set only when the request revises a stored artifact by id. */
  base?: ResolvedBase;
};

export type ProduceInput = {
  request: DeliverableRequestInput;
  context: ToolkitContext;
};

/**
 * A verified deliverable whose bytes are still in staging. Persistence turns
 * this into a `Deliverable` by attaching the artifact descriptors the durable
 * service returned.
 */
export type ProducedDeliverable = {
  kind: DeliverableKind;
  title: string;
  summary: string;
  files: StagedArtifact[];
  checks: VerificationCheck[];
  analysis?: DatasetAnalysis;
  /**
   * The document model to store as its own artifact. Persistence composes it
   * after the outputs exist so it can record which artifact each format lives in.
   */
  document?: {
    model: StoredDocument;
    filename: string;
    versionOf?: { artifactId: string; expectedVersion?: number };
  };
  /**
   * A software tree. The manifest names artifact ids, so the persistence adapter
   * stores the parts first and then writes the manifest that references them.
   */
  project?: {
    name: string;
    entry: string;
    description: string;
    language: string;
    template: string;
    verification: { executed: false; method: string; note: string };
  };
};

export type ArtifactToolkit = {
  produce: (input: ProduceInput) => Promise<ServiceResult<ProducedDeliverable>>;
};

export type CheckList = VerificationCheck[];

export function checksPass(checks: CheckList): boolean {
  return checks.every((check) => check.ok);
}

export function slugOf(value: string, fallback = 'deliverable'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}

