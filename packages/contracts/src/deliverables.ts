import { z } from 'zod';
import { DataMode, IsoDateTime } from './primitives.js';

/**
 * Deliverables are real files, not rendered approximations.
 *
 * A document is a DOCX/PDF produced by an OOXML/PDF writer, a spreadsheet is an
 * XLSX with formulas and worksheet charts, and a presentation is a PPTX with
 * editable slides. Every deliverable is verified after it is written by reading
 * the artifact back, so a producer that emits a malformed file fails the request
 * instead of returning a path to it.
 */

export const ArtifactKind = z.enum([
  'document',
  'spreadsheet',
  'presentation',
  'dataset',
  'software',
  'image',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

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
export const Artifact = z
  .object({
    path: z.string().min(1).max(1024),
    kind: ArtifactKind.optional(),
    format: ArtifactFormat.optional(),
    mediaType: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(200).optional(),
    bytes: z.number().int().nonnegative().optional(),
    digest: z.string().min(1).max(128).optional(),
  })
  .strict();
export type Artifact = z.infer<typeof Artifact>;

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
    artifacts: z.array(Artifact).min(1),
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

export const ArtifactCapability = z
  .object({
    kind: ArtifactKind,
    formats: z.array(ArtifactFormat).max(10),
    available: z.boolean(),
    detail: z.string().min(1).max(300),
  })
  .strict();
export type ArtifactCapability = z.infer<typeof ArtifactCapability>;

export const MediaCapabilityName = z.enum([
  'image.inspect',
  'image.generate',
  'image.edit',
  'audio.transcribe',
  'speech.synthesize',
  'video.understand',
]);
export type MediaCapabilityName = z.infer<typeof MediaCapabilityName>;

export const MediaCapability = z
  .object({
    capability: MediaCapabilityName,
    available: z.boolean(),
    reason: z.enum(['ready', 'not_configured', 'unsupported']),
    detail: z.string().min(1).max(300),
  })
  .strict();
export type MediaCapability = z.infer<typeof MediaCapability>;

export const CapabilityReport = z
  .object({
    artifacts: z.array(ArtifactCapability).max(20),
    media: z.array(MediaCapability).max(20),
  })
  .strict();
export type CapabilityReport = z.infer<typeof CapabilityReport>;
