import { z } from 'zod';
import {
  ArtifactId,
  ConversationId,
  DataMode,
  IsoDateTime,
  ProjectId,
  Sha256,
  TaskId,
} from './primitives.js';

/**
 * Durable artifacts.
 *
 * An artifact is the authoritative record of a file the owner uploaded or the
 * engine generated. The bytes are content-addressed and stored behind the same
 * durable persistence the rest of the engine uses; the descriptor is the only
 * shape a client sees. Padding, offsets and storage keys never appear on the
 * wire.
 *
 * Two boundaries are contractual rather than advisory:
 *
 * - `inferenceExposure` is the literal `'none'`. An artifact is never handed to
 *   a model or an external agent implicitly; only an explicit, scoped read by
 *   the owner through this API retrieves it.
 * - Media types are a closed allowlist. Executable, scriptable and generic
 *   archive formats are not on it, so a stored artifact cannot become a code
 *   path and archive contents are never expanded.
 */

/** Decoded byte ceiling for one artifact version. */
export const MAX_ARTIFACT_BYTES = 10_485_760;
/** Base64 ceiling for a request body carrying one version. */
export const MAX_ARTIFACT_BASE64_CHARS = 14_000_000;
/** JSON envelope ceiling for upload operations, including base64 expansion. */
export const ARTIFACT_BODY_LIMIT_BYTES = 16_777_216;

export const ArtifactKind = z.enum([
  'document',
  'pdf',
  'spreadsheet',
  'presentation',
  'image',
  'audio',
  'video',
  'source',
  'project',
  'game',
  'visualization',
  'execution',
  'data',
  'dataset',
  'software',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/**
 * The accepted media types. `text/html`, `image/svg+xml` and every generic
 * archive type are deliberately absent: a client that renders a download must
 * never receive active content from this service.
 */
export const ARTIFACT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export const ArtifactMediaType = z.enum(ARTIFACT_MEDIA_TYPES);
export type ArtifactMediaType = z.infer<typeof ArtifactMediaType>;

export const ArtifactFilename = z.string().trim().min(1).max(200).describe('artifact file name');

export const ArtifactDescriptor = z
  .object({
    artifactId: ArtifactId,
    kind: ArtifactKind,
    filename: ArtifactFilename,
    mediaType: ArtifactMediaType,
    bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    /** Lowercase hex SHA-256 of the current version's exact bytes. */
    sha256: Sha256,
    mode: DataMode,
    version: z.number().int().positive(),
    /** Retained version count, including the current one. */
    versions: z.number().int().positive(),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    expiresAt: IsoDateTime.optional(),
    /**
     * Immutable. The service has no path that submits artifact content to a
     * model, an adapter or an inference provider.
     */
    inferenceExposure: z.literal('none'),
  })
  .strict();
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptor>;

export const ArtifactVersionDescriptor = z
  .object({
    artifactId: ArtifactId,
    version: z.number().int().positive(),
    filename: ArtifactFilename,
    mediaType: ArtifactMediaType,
    kind: ArtifactKind,
    bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    sha256: Sha256,
    createdAt: IsoDateTime,
    note: z.string().max(500).optional(),
  })
  .strict();
export type ArtifactVersionDescriptor = z.infer<typeof ArtifactVersionDescriptor>;

export const ArtifactQuota = z
  .object({
    usedBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    maxArtifacts: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactQuota = z.infer<typeof ArtifactQuota>;

export const ArtifactDescriptorList = z
  .object({ artifacts: z.array(ArtifactDescriptor), quota: ArtifactQuota })
  .strict();
export type ArtifactDescriptorList = z.infer<typeof ArtifactDescriptorList>;

export const ArtifactVersionList = z
  .object({ artifactId: ArtifactId, versions: z.array(ArtifactVersionDescriptor) })
  .strict();
export type ArtifactVersionList = z.infer<typeof ArtifactVersionList>;

/**
 * Upload accepts base64 so the bytes travel through the single validated JSON
 * surface instead of a second transport contract. `sha256` is optional; when a
 * client sends it, a mismatch rejects the upload rather than storing different
 * bytes than the client believes it sent.
 */
export const ArtifactUploadRequest = z
  .object({
    filename: ArtifactFilename,
    mediaType: ArtifactMediaType,
    contentBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS),
    sha256: Sha256.optional(),
    kind: ArtifactKind.optional(),
    mode: DataMode.default('private'),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    /** 0 keeps the artifact until it is deleted. Bounded by engine config. */
    retentionDays: z.number().int().min(0).max(3650).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ArtifactUploadRequest = z.infer<typeof ArtifactUploadRequest>;

export const ArtifactVersionRequest = z
  .object({
    filename: ArtifactFilename,
    mediaType: ArtifactMediaType,
    contentBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS),
    sha256: Sha256.optional(),
    kind: ArtifactKind.optional(),
    mode: DataMode.default('private'),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ArtifactVersionRequest = z.infer<typeof ArtifactVersionRequest>;

export const ArtifactUploadResult = z
  .object({ artifact: ArtifactDescriptor, version: ArtifactVersionDescriptor })
  .strict();
export type ArtifactUploadResult = z.infer<typeof ArtifactUploadResult>;

export const ArtifactContent = z
  .object({
    artifact: ArtifactDescriptor,
    version: ArtifactVersionDescriptor,
    contentBase64: z.string().max(MAX_ARTIFACT_BASE64_CHARS),
  })
  .strict();
export type ArtifactContent = z.infer<typeof ArtifactContent>;

/**
 * A portable export: the descriptor, every retained version's metadata and the
 * exact bytes of one version. Export never widens access; it is the same
 * owner-scoped read as a download with the version manifest attached.
 */
export const ArtifactExport = z
  .object({
    artifact: ArtifactDescriptor,
    versions: z.array(ArtifactVersionDescriptor),
    version: ArtifactVersionDescriptor,
    contentBase64: z.string().max(MAX_ARTIFACT_BASE64_CHARS),
    exportedAt: IsoDateTime,
  })
  .strict();
export type ArtifactExport = z.infer<typeof ArtifactExport>;

export const ArtifactModeRequest = z.object({ mode: DataMode.default('private') }).strict();
export type ArtifactModeRequest = z.infer<typeof ArtifactModeRequest>;

export const ArtifactDeleteResult = z
  .object({
    artifactId: ArtifactId,
    deletedVersions: z.number().int().nonnegative(),
    releasedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactDeleteResult = z.infer<typeof ArtifactDeleteResult>;

export const ArtifactPruneResult = z
  .object({
    pruned: z.number().int().nonnegative(),
    releasedBytes: z.number().int().nonnegative(),
    at: IsoDateTime,
  })
  .strict();
export type ArtifactPruneResult = z.infer<typeof ArtifactPruneResult>;

/*
 * Deliverable generation contracts, owned by the artifact-intelligence
 * toolkit. Artifacts themselves are durable `ArtifactDescriptor`s: the toolkit
 * stages and verifies bytes, then the durable service is the only writer that
 * makes them retrievable. There is no second artifact descriptor.
 */

export const ArtifactFormat = z.enum([
  'docx',
  'pdf',
  'xlsx',
  'pptx',
  'csv',
  'json',
  'markdown',
  'html',
  'source',
  'text',
]);
export type ArtifactFormat = z.infer<typeof ArtifactFormat>;

/**
 * `digest` is `sha256:<hex>`; `path` is always relative to the workspace root
 * named by the request's data mode, never an absolute host path.
 */


const FileName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'use letters, digits, dot, dash or underscore');

const Cell = z.union([z.string().max(4000), z.number(), z.null()]);
export type Cell = z.infer<typeof Cell>;

export const DocumentBlock = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      level: z.number().int().min(1).max(3),
      text: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      type: z.literal('bullets'),
      items: z.array(z.string().min(1).max(2000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('numbers'),
      items: z.array(z.string().min(1).max(2000)).min(1).max(100),
    })
    .strict(),
  z.object({ type: z.literal('quote'), text: z.string().min(1).max(4000) }).strict(),
  z
    .object({
      type: z.literal('code'),
      text: z.string().max(40_000),
      language: z.string().min(1).max(40).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      headers: z.array(z.string().min(1).max(200)).min(1).max(12),
      rows: z.array(z.array(z.string().max(2000)).max(12)).max(500),
    })
    .strict(),
  z.object({ type: z.literal('pageBreak') }).strict(),
]);
export type DocumentBlock = z.infer<typeof DocumentBlock>;

export const ChartType = z.enum(['bar', 'line', 'pie']);
export type ChartType = z.infer<typeof ChartType>;

export const ChartSeries = z
  .object({
    name: z.string().min(1).max(80),
    values: z.array(z.number()).min(1).max(200),
  })
  .strict();
export type ChartSeries = z.infer<typeof ChartSeries>;

export const ChartSpec = z
  .object({
    type: ChartType,
    title: z.string().min(1).max(200),
    categories: z.array(z.string().min(1).max(120)).min(1).max(200),
    series: z.array(ChartSeries).min(1).max(6),
  })
  .strict();
export type ChartSpec = z.infer<typeof ChartSpec>;

const StoredDocumentShape = {
  version: z.literal(1),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  author: z.string().max(120).optional(),
  blocks: z.array(DocumentBlock).max(2000),
};

/** The editable source of a document this engine produced. */
export const StoredDocument = z.object(StoredDocumentShape).strict();
export type StoredDocument = z.infer<typeof StoredDocument>;

export const DocumentEdit = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('append'), blocks: z.array(DocumentBlock).min(1).max(2000) })
    .strict(),
  z
    .object({
      op: z.literal('replace'),
      index: z.number().int().nonnegative(),
      block: DocumentBlock,
    })
    .strict(),
  z.object({ op: z.literal('remove'), index: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('setTitle'), title: z.string().min(1).max(200) }).strict(),
]);
export type DocumentEdit = z.infer<typeof DocumentEdit>;

export const DocumentRequest = z
  .object({
    kind: z.literal('document'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    author: z.string().max(120).optional(),
    blocks: z.array(DocumentBlock).max(2000).default([]),
    formats: z.array(z.enum(['docx', 'pdf', 'markdown', 'html'])).min(1).max(4),
    /** A `.document.json` artifact from an earlier run, edited in place. */
    base: z.string().min(1).max(300).optional(),
    edits: z.array(DocumentEdit).max(200).default([]),
  })
  .strict();
export type DocumentRequest = z.infer<typeof DocumentRequest>;

export const ColumnType = z.enum(['text', 'number', 'currency', 'percent', 'date']);

export const ColumnSpec = z
  .object({
    header: z.string().min(1).max(120),
    type: ColumnType.default('text'),
    width: z.number().min(4).max(80).optional(),
    total: z.boolean().default(false),
  })
  .strict();
export type ColumnSpec = z.infer<typeof ColumnSpec>;

export const FormulaSpec = z
  .object({
    cell: z
      .string()
      .min(2)
      .max(10)
      .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/, 'use an A1-style cell reference'),
    formula: z.string().min(2).max(500),
  })
  .strict();
export type FormulaSpec = z.infer<typeof FormulaSpec>;

export const SheetRequest = z
  .object({
    name: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'worksheet names cannot contain special characters'),
    columns: z.array(ColumnSpec).min(1).max(50),
    rows: z.array(z.array(Cell)).max(10_000),
    formulas: z.array(FormulaSpec).max(500).default([]),
    table: z.boolean().default(true),
    charts: z.array(ChartSpec).max(4).default([]),
    freezeHeader: z.boolean().default(true),
  })
  .strict();
export type SheetRequest = z.infer<typeof SheetRequest>;

export const SpreadsheetRequest = z
  .object({
    kind: z.literal('spreadsheet'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    title: z.string().min(1).max(200),
    author: z.string().max(120).optional(),
    sheets: z.array(SheetRequest).min(1).max(20),
  })
  .strict();
export type SpreadsheetRequest = z.infer<typeof SpreadsheetRequest>;

export const SlideLayout = z.enum(['title', 'content', 'section', 'twoColumn']);

export const SlideRequest = z
  .object({
    layout: SlideLayout.default('content'),
    title: z.string().max(200).optional(),
    subtitle: z.string().max(400).optional(),
    bullets: z.array(z.string().min(1).max(400)).max(12).default([]),
    columns: z.array(z.array(z.string().min(1).max(400)).max(8)).max(2).default([]),
    table: z
      .object({
        headers: z.array(z.string().min(1).max(120)).min(1).max(8),
        rows: z.array(z.array(z.string().max(200)).max(8)).max(50),
      })
      .strict()
      .optional(),
    chart: ChartSpec.optional(),
    flow: z.array(z.string().min(1).max(120)).max(8).default([]),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type SlideRequest = z.infer<typeof SlideRequest>;

export const PresentationRequest = z
  .object({
    kind: z.literal('presentation'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    title: z.string().min(1).max(200),
    author: z.string().max(120).optional(),
    slides: z.array(SlideRequest).min(1).max(100),
  })
  .strict();
export type PresentationRequest = z.infer<typeof PresentationRequest>;

const FilterValue = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string().max(1000), z.number()])).max(100),
]);

const AggregateSpec = z
  .object({
    column: z.string().min(1).max(120),
    fn: z.enum(['sum', 'mean', 'min', 'max', 'count']),
    as: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * A transformation is data, not code. Each step is applied in order to a typed
 * table and recorded in the persisted recipe, so an analysis is reproducible
 * from its source digest and step list alone.
 */
export const TransformStep = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('filter'),
      column: z.string().min(1).max(120),
      operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'notEmpty']),
      value: FilterValue,
    })
    .strict(),
  z.object({ op: z.literal('select'), columns: z.array(z.string().min(1).max(120)).min(1).max(50) }).strict(),
  z
    .object({
      op: z.literal('rename'),
      from: z.string().min(1).max(120),
      to: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal('derive'),
      column: z.string().min(1).max(120),
      expression: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      op: z.literal('sort'),
      column: z.string().min(1).max(120),
      direction: z.enum(['asc', 'desc']).default('asc'),
    })
    .strict(),
  z
    .object({
      op: z.literal('groupBy'),
      columns: z.array(z.string().min(1).max(120)).min(1).max(5),
      aggregates: z.array(AggregateSpec).min(1).max(10),
    })
    .strict(),
  z.object({ op: z.literal('dropMissing'), columns: z.array(z.string().max(120)).max(50).default([]) }).strict(),
  z.object({ op: z.literal('dedupe'), columns: z.array(z.string().max(120)).max(50).default([]) }).strict(),
  z
    .object({
      op: z.literal('replace'),
      column: z.string().min(1).max(120),
      find: z.string().min(1).max(200),
      replace: z.string().max(200),
    })
    .strict(),
  z.object({ op: z.literal('trim'), columns: z.array(z.string().max(120)).max(50).default([]) }).strict(),
  z
    .object({
      op: z.literal('cast'),
      column: z.string().min(1).max(120),
      type: z.enum(['number', 'string', 'date']),
    })
    .strict(),
]);
export type TransformStep = z.infer<typeof TransformStep>;

export const DatasetRequest = z
  .object({
    kind: z.literal('dataset'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    source: z
      .object({
        format: z.enum(['csv', 'json']),
        text: z.string().min(1).max(700_000),
      })
      .strict(),
    steps: z.array(TransformStep).max(50).default([]),
    charts: z.array(ChartSpec).max(4).default([]),
    exports: z.array(z.enum(['xlsx', 'csv', 'json', 'pdf'])).min(1).max(4).default(['xlsx', 'json']),
  })
  .strict();
export type DatasetRequest = z.infer<typeof DatasetRequest>;

const SourcePath = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    'paths are relative and may not contain a parent segment',
  );

export const SourceFile = z
  .object({
    path: SourcePath,
    content: z.string().max(300_000),
  })
  .strict();
export type SourceFile = z.infer<typeof SourceFile>;

export const SoftwareRequest = z
  .object({
    kind: z.literal('software'),
    mode: DataMode.default('cloud'),
    name: FileName,
    description: z.string().min(1).max(4000),
    template: z.enum(['none', 'module', 'cli', 'service']).default('none'),
    language: z.enum(['javascript', 'typescript']).default('javascript'),
    files: z.array(SourceFile).max(100).default([]),
    entry: z.string().max(300).optional(),
  })
  .strict();
export type SoftwareRequest = z.infer<typeof SoftwareRequest>;

export const MediaInspectRequest = z
  .object({
    kind: z.literal('media'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    action: z.literal('inspect'),
    /** Base64 image bytes. Inspection reads headers only; it decodes no pixels. */
    data: z.string().min(8).max(700_000),
  })
  .strict();
export type MediaInspectRequest = z.infer<typeof MediaInspectRequest>;

export const DeliverableRequest = z.discriminatedUnion('kind', [
  DocumentRequest,
  SpreadsheetRequest,
  PresentationRequest,
  DatasetRequest,
  SoftwareRequest,
  MediaInspectRequest,
]);
export type DeliverableRequest = z.infer<typeof DeliverableRequest>;
/** The wire shape: defaults may be omitted by a client and are applied on receipt. */
export type DeliverableRequestInput = z.input<typeof DeliverableRequest>;

export const VerificationCheck = z
  .object({
    name: z.string().min(1).max(80),
    ok: z.boolean(),
    detail: z.string().max(500),
  })
  .strict();
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const VerificationReport = z
  .object({
    ok: z.boolean(),
    checks: z.array(VerificationCheck).min(1).max(60),
  })
  .strict();
export type VerificationReport = z.infer<typeof VerificationReport>;

export const DatasetField = z
  .object({
    name: z.string().min(1).max(120),
    type: z.enum(['number', 'string', 'date', 'boolean', 'empty']),
    missing: z.number().int().nonnegative(),
    unique: z.number().int().nonnegative(),
    min: z.number().optional(),
    max: z.number().optional(),
    mean: z.number().optional(),
    median: z.number().optional(),
    stdev: z.number().optional(),
  })
  .strict();
export type DatasetField = z.infer<typeof DatasetField>;

export const DatasetProfile = z
  .object({
    rows: z.number().int().nonnegative(),
    columns: z.number().int().nonnegative(),
    duplicateRows: z.number().int().nonnegative(),
    fields: z.array(DatasetField).max(100),
    sample: z.array(z.array(Cell)).max(10),
  })
  .strict();
export type DatasetProfile = z.infer<typeof DatasetProfile>;

export const DatasetAnalysis = z
  .object({
    sourceFormat: z.enum(['csv', 'json']),
    sourceDigest: z.string().min(1).max(128),
    rowsIn: z.number().int().nonnegative(),
    rowsOut: z.number().int().nonnegative(),
    stepsApplied: z.array(z.string().max(300)).max(50),
    profile: DatasetProfile,
    recipeDigest: z.string().min(1).max(128),
  })
  .strict();
export type DatasetAnalysis = z.infer<typeof DatasetAnalysis>;

export const MediaDimensions = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const MediaInspection = z
  .object({
    mediaType: z.string().min(1).max(60),
    format: z.string().min(1).max(20),
    bytes: z.number().int().positive(),
    dimensions: MediaDimensions.optional(),
    /** What was actually read: headers only, never pixels or model inference. */
    method: z.literal('header'),
  })
  .strict();
export type MediaInspection = z.infer<typeof MediaInspection>;

export const Deliverable = z
  .object({
    kind: ArtifactKind,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    artifacts: z.array(ArtifactDescriptor).min(1),
    verification: VerificationReport,
    receipt: z
      .object({
        receiptId: z.string().min(1).max(80),
        at: IsoDateTime,
      })
      .strict(),
    analysis: DatasetAnalysis.optional(),
    inspection: MediaInspection.optional(),
  })
  .strict();
export type Deliverable = z.infer<typeof Deliverable>;
