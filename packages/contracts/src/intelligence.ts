import { z } from 'zod';
import { PermissionScope } from './permissions.js';
import { DataMode, IsoDateTime } from './primitives.js';

/**
 * Intelligence surfaces are additive to the execution contract. They describe
 * what the engine can do and what it remembers, without changing any operation an
 * existing client already consumes.
 */

export const ToolSource = z.enum(['builtin', 'mcp', 'plugin', 'browser']);
export type ToolSource = z.infer<typeof ToolSource>;

export const ToolDescriptor = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    source: ToolSource,
    scopes: z.array(PermissionScope).min(1),
    /** `once` asks the owner per invocation; `never` is a read-only tool. */
    approval: z.enum(['never', 'once', 'always']),
    /** Human-readable parameter names and types; the tool validates its input. */
    parameters: z.record(z.string(), z.string()),
  })
  .strict();
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const ToolList = z.object({ tools: z.array(ToolDescriptor) }).strict();
export type ToolList = z.infer<typeof ToolList>;

export const KnowledgeIngestRequest = z
  .object({
    title: z.string().min(1).max(300),
    text: z.string().min(1).max(1_000_000),
    mode: DataMode.default('cloud'),
  })
  .strict();
export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestRequest>;

export const KnowledgeIngestResult = z
  .object({
    documentId: z.string().min(1).max(128),
    title: z.string().min(1).max(300),
    chunks: z.number().int().positive(),
    /**
     * `semantic` means an embedding provider was configured and answered.
     * `lexical` means retrieval is term-based; the distinction is reported so a
     * caller never mistakes lexical recall for vector search.
     */
    embedding: z.enum(['semantic', 'lexical']),
    createdAt: IsoDateTime,
  })
  .strict();
export type KnowledgeIngestResult = z.infer<typeof KnowledgeIngestResult>;

export const KnowledgeHit = z
  .object({
    documentId: z.string().min(1).max(128),
    title: z.string().min(1).max(300),
    text: z.string().max(4000),
    score: z.number().min(0),
  })
  .strict();
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

export const KnowledgeSearchResult = z
  .object({
    hits: z.array(KnowledgeHit),
    embedding: z.enum(['semantic', 'lexical']),
  })
  .strict();
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const KnowledgeSummary = z
  .object({
    documentId: z.string().min(1).max(128),
    title: z.string().min(1).max(300),
    chunks: z.number().int().positive(),
    mode: DataMode,
    createdAt: IsoDateTime,
  })
  .strict();
export type KnowledgeSummary = z.infer<typeof KnowledgeSummary>;

export const KnowledgeList = z
  .object({ documents: z.array(KnowledgeSummary) })
  .strict();
export type KnowledgeList = z.infer<typeof KnowledgeList>;
