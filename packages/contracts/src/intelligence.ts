import { ChatReply } from './tasks.js';
import { z } from 'zod';
import { Availability } from './capabilities.js';
import { PermissionScope } from './permissions.js';
import { CostClass, DataMode, IsoDateTime, ModelRef } from './primitives.js';

/**
 * Intelligence surfaces are additive to the execution contract. They describe
 * what the engine can route to, what it can do, and what it remembers, without
 * changing any operation an existing client already consumes.
 */

export const RoutingMode = z.enum(['auto', 'fast', 'complex']);
export type RoutingMode = z.infer<typeof RoutingMode>;

/**
 * Capability scores are recorded evidence for a configured provider, not a
 * marketing claim. `toolCalling` and `multimodal` are booleans because a model
 * either accepts tools/images on the wire or it does not.
 */
export const ModelCapabilities = z
  .object({
    coding: z.number().min(0).max(1),
    reasoning: z.number().min(0).max(1),
    speed: z.number().min(0).max(1),
    toolCalling: z.boolean(),
    multimodal: z.boolean(),
    contextTokens: z.number().int().positive().max(10_000_000),
  })
  .strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const RouterModel = z
  .object({
    ref: ModelRef,
    label: z.string().min(1).max(160),
    providerId: z.string().min(1).max(64),
    costClass: CostClass,
    capabilities: ModelCapabilities,
    availability: Availability,
    requestsRemaining: z.number().int().nonnegative(),
    tokensRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type RouterModel = z.infer<typeof RouterModel>;

export const ProviderStatus = z
  .object({
    id: z.string().min(1).max(64),
    /** `unverified` is refused; free is never inferred from an identifier. */
    costEvidence: z.enum(['verified-free', 'unverified']),
    quota: z
      .object({
        requestsPerMinute: z.number().int().positive(),
        requestsPerDay: z.number().int().positive(),
        tokensPerDay: z.number().int().positive(),
      })
      .strict(),
    used: z
      .object({
        requestsThisMinute: z.number().int().nonnegative(),
        requestsToday: z.number().int().nonnegative(),
        tokensToday: z.number().int().nonnegative(),
      })
      .strict(),
    models: z.array(RouterModel),
  })
  .strict();
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const RoutingReport = z
  .object({
    mode: RoutingMode,
    providers: z.array(ProviderStatus),
    /** Ordered candidates the selected mode would try. */
    route: z.array(ModelRef),
    allowPaid: z.literal(false),
  })
  .strict();
export type RoutingReport = z.infer<typeof RoutingReport>;

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

/**
 * One frame of the Chat SST stream.
 *
 * Chat answers `text/event-stream` when the client asks for it and a JSON body
 * otherwise. The frames are published here so a client cannot invent its own
 * shape: `chat.delta` carries the assistant text, and `chat.completed` carries
 * the same `ChatReply` the JSON response would have returned.
 */
export const ChatFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('chat.completed'), reply: ChatReply }).strict(),
]);
export type ChatFrame = z.infer<typeof ChatFrame>;
