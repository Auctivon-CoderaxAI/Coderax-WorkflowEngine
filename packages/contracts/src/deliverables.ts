import { z } from 'zod';
import { ArtifactDescriptor, ArtifactProjectManifest } from './artifacts.js';
import { ArtifactId, DataMode, IsoDateTime, ProjectId } from './primitives.js';

/**
 * Deliverable generation.
 *
 * A deliverable is a request to *produce* real files (a DOCX, a PDF, a workbook,
 * a deck, a dataset export, a software project). It owns the generation request
 * shapes and the objective verification report, and nothing else:
 *
 * - Persistence, metadata, versions, quotas and deletion belong to the durable
 *   artifact service. A produced deliverable names its files with
 *   `ArtifactDescriptor`, so there is exactly one artifact metadata authority.
 * - Capability reporting belongs to the multimodal capability registry. This
 *   module declares no capability list of its own.
 *
 * Generation writes into an isolated staging directory, verifies the bytes by
 * reading them back, and only then persists them. A deliverable whose files were
 * not stored durably is not reported as created.
 */

/** The editable-source artifact this deliverable can be revised from. */
export const DeliverableSourceFormat = z.enum(['document.json']);
export type DeliverableSourceFormat = z.infer<typeof DeliverableSourceFormat>;

export const DeliverableSource = z
  .object({
    artifactId: ArtifactId,
    version: z.number().int().positive(),
    format: DeliverableSourceFormat,
  })
  .strict();
export type DeliverableSource = z.infer<typeof DeliverableSource>;

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

/** The editable source of a document this engine produced. */
export const StoredDocument = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    author: z.string().max(120).optional(),
    blocks: z.array(DocumentBlock).max(2000),
  })
  .strict();
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

/**
 * Revision is addressed by artifact id, not by a workspace path. The engine
 * downloads that artifact version into isolated staging, applies the edits,
 * re-verifies every produced file and appends new versions.
 *
 * `expectedVersion` is the version the caller read. When it is supplied the
 * durable service appends only if the artifact is still at that version, so two
 * concurrent edits cannot silently overwrite one another.
 */
export const DocumentBase = z
  .object({
    artifactId: ArtifactId,
    mode: DataMode.default('cloud'),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type DocumentBase = z.infer<typeof DocumentBase>;

/**
 * `html` is deliberately absent: the durable artifact store refuses active
 * content, so HTML is never persisted or served as an artifact. Markdown remains
 * the portable text form.
 */
export const DocumentFormat = z.enum(['docx', 'pdf', 'markdown']);
export type DocumentFormat = z.infer<typeof DocumentFormat>;

export const DocumentRequest = z
  .object({
    kind: z.literal('document'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    author: z.string().max(120).optional(),
    blocks: z.array(DocumentBlock).max(2000).default([]),
    formats: z.array(DocumentFormat).min(1).max(3),
    base: DocumentBase.optional(),
    edits: z.array(DocumentEdit).max(200).default([]),
  })
  .strict();
export type DocumentRequest = z.infer<typeof DocumentRequest>;

export const ColumnType = z.enum(['text', 'number', 'currency', 'percent', 'date']);
export type ColumnType = z.infer<typeof ColumnType>;

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
export type SlideLayout = z.infer<typeof SlideLayout>;

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

export const DatasetFormat = z.enum(['csv', 'tsv', 'json']);
export type DatasetFormat = z.infer<typeof DatasetFormat>;

export const DatasetExport = z.enum(['xlsx', 'csv', 'tsv', 'json', 'pdf']);
export type DatasetExport = z.infer<typeof DatasetExport>;

export const DatasetRequest = z
  .object({
    kind: z.literal('dataset'),
    mode: DataMode.default('cloud'),
    filename: FileName,
    source: z
      .object({
        format: DatasetFormat,
        text: z.string().min(1).max(700_000),
      })
      .strict(),
    steps: z.array(TransformStep).max(50).default([]),
    charts: z.array(ChartSpec).max(4).default([]),
    exports: z.array(DatasetExport).min(1).max(5).default(['xlsx', 'json']),
  })
  .strict();
export type DatasetRequest = z.infer<typeof DatasetRequest>;

/**
 * A project path is relative, uses forward slashes and may not contain a parent
 * segment. It is validated again on extraction against the real staging root, so
 * a symlink cannot turn a legal-looking path into an escape.
 */
export const SourcePath = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    'paths are relative and may not contain a parent segment',
  );
export type SourcePath = z.infer<typeof SourcePath>;

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
    /**
     * An existing project whose tree this generation extends. Each path is
     * matched by relative path and gains a version instead of a second file;
     * omitted, the deliverable opens a project of its own.
     */
    projectId: ProjectId.optional(),
  })
  .strict();
export type SoftwareRequest = z.infer<typeof SoftwareRequest>;

export const DeliverableKind = z.enum([
  'document',
  'spreadsheet',
  'presentation',
  'dataset',
  'software',
]);
export type DeliverableKind = z.infer<typeof DeliverableKind>;

export const DeliverableRequest = z.discriminatedUnion('kind', [
  DocumentRequest,
  SpreadsheetRequest,
  PresentationRequest,
  DatasetRequest,
  SoftwareRequest,
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
    sourceFormat: DatasetFormat,
    sourceDigest: z.string().min(1).max(128),
    rowsIn: z.number().int().nonnegative(),
    rowsOut: z.number().int().nonnegative(),
    stepsApplied: z.array(z.string().max(300)).max(50),
    profile: DatasetProfile,
    recipeDigest: z.string().min(1).max(128),
  })
  .strict();
export type DatasetAnalysis = z.infer<typeof DatasetAnalysis>;

/**
 * A generated project, as the durable store owns it.
 *
 * The manifest is not a stored copy: the store derives it from the rows that
 * carry the same `projectId`, so the tree has one authority. `manifest.files`
 * names each relative path, its artifact id, its current version and its digest.
 */
export const DeliverableProject = z
  .object({
    projectId: ProjectId,
    manifest: ArtifactProjectManifest,
  })
  .strict();
export type DeliverableProject = z.infer<typeof DeliverableProject>;

/**
 * Every file in `artifacts` is a stored, integrity-verified artifact descriptor
 * returned by the durable service. `source` points at the artifact that can be
 * revised by id; `receipt` is the audit receipt recorded after persistence
 * succeeded, so a created deliverable always has both stored bytes and a receipt.
 */
export const Deliverable = z
  .object({
    kind: DeliverableKind,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    artifacts: z.array(ArtifactDescriptor).min(1).max(40),
    verification: VerificationReport,
    receipt: z
      .object({
        receiptId: z.string().min(1).max(80),
        at: IsoDateTime,
      })
      .strict(),
    source: DeliverableSource.optional(),
    /** The stored tree of a generated software project, as the store lists it. */
    project: DeliverableProject.optional(),
    analysis: DatasetAnalysis.optional(),
  })
  .strict();
export type Deliverable = z.infer<typeof Deliverable>;

/** One produced format and the stored artifact that holds its current bytes. */
export const DocumentSourceOutput = z
  .object({
    format: DocumentFormat,
    artifactId: ArtifactId,
    version: z.number().int().positive(),
    filename: z.string().min(1).max(200),
  })
  .strict();
export type DocumentSourceOutput = z.infer<typeof DocumentSourceOutput>;

/**
 * The stored editable source of a document, referenced by `DeliverableSource`.
 * It records the artifact identity of every produced format, so a later edit by
 * artifact id appends versions to the same artifacts instead of creating a new
 * set and orphaning the previous one.
 */
export const DocumentSourceArtifact = z
  .object({
    version: z.literal(1),
    document: StoredDocument,
    outputs: z.array(DocumentSourceOutput).max(3).default([]),
  })
  .strict();
export type DocumentSourceArtifact = z.infer<typeof DocumentSourceArtifact>;
