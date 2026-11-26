import { z } from 'zod';
import { CONTRACT_VERSION, EngineId, ModelRef } from '@coderax/contracts';

/**
 * Configuration is validated once, at startup, and then treated as immutable.
 * Every switch that changes behavior has a field here rather than an env-only
 * branch, and every default reproduces the safe (disabled, zero-cost) state.
 */

export const ServerConfig = z
  .object({
    /** Loopback by default; the engine is never public-facing. */
    host: z.string().min(1).default('127.0.0.1'),
    /** 0 asks the operating system for a free port, which tests rely on. */
    port: z.number().int().min(0).max(65535).default(8788),
  })
  .strict();

export const AuthConfig = z
  .object({
    ownerId: z.string().trim().min(1),
    /** Name of the environment variable holding the owner token, never the token. */
    tokenEnv: z.string().trim().min(1).default('CODERAX_OWNER_TOKEN'),
    /** Reject a token shorter than this; a guessable owner token is not auth. */
    minTokenLength: z.number().int().min(16).max(4096).default(32),
  })
  .strict();

export const WorkspacesConfig = z
  .object({
    privateRoot: z.string().min(1),
    cloudRoot: z.string().min(1),
  })
  .strict();

export const NativeConfig = z
  .object({
    enabled: z.boolean().default(true),
    maxSteps: z.number().int().min(1).max(64).default(12),
  })
  .strict();

export const OpenCodeConfig = z
  .object({
    enabled: z.boolean().default(false),
    baseURL: z.string().url().optional(),
    model: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
  })
  .strict();

export const FreebuffConfig = z
  .object({
    enabled: z.boolean().default(false),
    baseURL: z.string().url().optional(),
    sdkPath: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const EnginesConfig = z
  .object({
    /**
     * The default agent is Coderax Native. It is the only engine with no
     * external dependency, so an unconfigured deployment still has one engine.
     */
    default: EngineId.default('native'),
    native: NativeConfig.default({}),
    opencode: OpenCodeConfig.default({}),
    freebuff: FreebuffConfig.default({}),
  })
  .strict();

/**
 * A provider's published zero-cost terms for one exact model.
 *
 * This is the only field that can make a model eligible. It is deliberately
 * shaped like a price list rather than a boolean: an owner records where the
 * price was observed, when, and for how long that observation is valid, and the
 * engine checks all three. `source` must be an HTTPS URL; a value that is a
 * label, a guess or a local file is not evidence.
 */
export const ModelTerms = z
  .object({
    source: z.string().url().max(2048),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    currency: z.literal('USD'),
    inputPerMillionTokens: z.number().min(0),
    outputPerMillionTokens: z.number().min(0),
    requestPerCall: z.number().min(0).default(0),
  })
  .strict();

/**
 * Recorded capability, quota and pricing evidence for one model. Capability and
 * quota numbers only rank and bound a model; they cannot make it eligible. Only
 * `terms`, evaluated against the clock, can do that. Omitting `terms` leaves the
 * cost unknown, which the engine treats as `paid` and refuses.
 */
export const ModelEvidence = z
  .object({
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(160),
    label: z.string().min(1).max(160).optional(),
    coding: z.number().min(0).max(1).default(0.5),
    reasoning: z.number().min(0).max(1).default(0.5),
    speed: z.number().min(0).max(1).default(0.5),
    toolCalling: z.boolean().default(false),
    multimodal: z.boolean().default(false),
    contextTokens: z.number().int().min(1).max(10_000_000).default(8192),
    requestsPerMinute: z.number().int().min(1).max(10_000).default(20),
    requestsPerDay: z.number().int().min(1).max(1_000_000).default(500),
    tokensPerDay: z.number().int().min(1).max(1_000_000_000).default(500_000),
    /** A per-request input ceiling published by the provider, when it has one. */
    maxInputTokens: z.number().int().min(1).max(50_000_000).optional(),
    /** A per-request output ceiling published by the provider, when it has one. */
    maxOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
    /** Concurrent requests the provider's free tier allows. */
    concurrentRequests: z.number().int().min(1).max(1_000).default(1),
    terms: ModelTerms.optional(),
    /**
     * Where the privacy term below was observed. This is a record, not an
     * enforcement: the engine can report the term but cannot make a third party
     * honour it.
     */
    privacySource: z.string().url().max(2048).optional(),
    promptTraining: z.enum(['prohibited', 'allowed', 'unknown']).default('unknown'),
    /**
     * An observed successful inference. This is separate from `terms` (price)
     * and from a configured credential: a model listing proves neither.
     */
    inferenceSource: z.string().url().max(2048).optional(),
    inferenceObservedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ModelsConfig = z
  .object({
    /** Ordered candidates; order is a tie-break, never proof of cost. */
    route: z.array(ModelRef).min(1),
    /** Capability, quota and pricing evidence per model. */
    evidence: z.array(ModelEvidence).default([]),
    /** Bounded fallback across verified-free models, never to a paid one. */
    maxFallbacks: z.number().int().min(0).max(5).default(2),
    /** Zero-cost is a literal: there is no configuration that enables paid use. */
    allowPaid: z.literal(false).default(false),
    dailyRequestBudget: z.number().int().min(1).max(100_000).default(1_000),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(2_000_000),
    /** Consecutive provider failures before its circuit opens. */
    circuitFailureThreshold: z.number().int().min(1).max(20).default(3),
    /** How long an open circuit refuses traffic before one probe is allowed. */
    circuitCooldownMs: z.number().int().min(1_000).max(600_000).default(60_000),
  })
  .strict();

export const ToolsConfig = z
  .object({
    enabled: z.boolean().default(true),
    /** Shell and network are off unless the owner turns them on explicitly. */
    shellEnabled: z.boolean().default(false),
    allowedCommands: z.array(z.string().min(1).max(120)).max(50).default([]),
    networkEnabled: z.boolean().default(false),
    allowedHosts: z.array(z.string().min(1).max(255)).max(50).default([]),
    maxOutputBytes: z.number().int().min(1024).max(1_000_000).default(65_536),
    commandTimeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    maxSearchFiles: z.number().int().min(1).max(20_000).default(2_000),
  })
  .strict();

export const KnowledgeConfig = z
  .object({
    enabled: z.boolean().default(true),
    maxDocuments: z.number().int().min(1).max(10_000).default(500),
    /** Set together with an inference endpoint to enable semantic retrieval. */
    embeddingModel: z.string().min(1).max(160).optional(),
  })
  .strict();

export const McpServerConfig = z.discriminatedUnion('transport', [
  z
    .object({
      name: z.string().min(1).max(60),
      transport: z.literal('http'),
      url: z.string().url(),
      headersEnv: z.record(z.string().min(1).max(200)).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(60),
      transport: z.literal('stdio'),
      command: z.string().min(1).max(200),
      args: z.array(z.string().max(500)).max(40).default([]),
      envFrom: z.array(z.string().min(1).max(200)).max(40).default([]),
    })
    .strict(),
]);

export const McpConfig = z
  .object({ servers: z.array(McpServerConfig).max(10).default([]) })
  .strict();

export const RoutingConfig = z
  .object({
    defaultMode: z.enum(['auto', 'fast', 'complex']).default('auto'),
  })
  .strict();

export const ExecutionConfig = z
  .object({
    /** A run holds its lease only while it heartbeats inside this window. */
    leaseTtlMs: z.number().int().min(3_000).max(600_000).default(30_000),
    heartbeatIntervalMs: z.number().int().min(500).max(60_000).default(10_000),
    /** Total attempts, including the first. 1 disables retry. */
    maxAttempts: z.number().int().min(1).max(5).default(1),
    retryDelayMs: z.number().int().min(0).max(1_000).default(250),
    maxConcurrentTasks: z.number().int().min(1).max(64).default(4),
    /** Events retained per task for replay; older events require a new query. */
    eventBufferSize: z.number().int().min(16).max(100_000).default(2_000),
    /** A crashed run's row is readable for this long before a sweep reclaims it. */
    retentionMs: z.number().int().min(60_000).max(604_800_000).default(86_400_000),
    /** How long a cancelled adapter may take to stop before the run is settled. */
    cancelGraceMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();

export const PersistenceConfig = z
  .object({
    /**
     * `memory` keeps leases inside one process and loses them on restart.
     * `mongo` is the production table: a unique index arbitrates a claim, so two
     * replicas cannot both own one conversation.
     */
    driver: z.enum(['memory', 'mongo']).default('memory'),
    /** Name of the variable holding the connection string; never the string. */
    uriEnv: z.string().trim().min(1).default('CODERAX_MONGODB_URI'),
    database: z.string().trim().min(1).default('coderax'),
    /**
     * Prepended to every collection name. One prefix keeps a deployment's
     * collections together without six separate name settings that can drift.
     */
    collectionPrefix: z
      .string()
      .max(40)
      .regex(/^[a-z0-9_]*$/, 'collectionPrefix may contain only a-z, 0-9 and _')
      .default(''),
  })
  .strict();

export const EngineConfigSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
    server: ServerConfig.default({}),
    auth: AuthConfig,
    workspaces: WorkspacesConfig,
    engines: EnginesConfig.default({}),
    models: ModelsConfig,
    execution: ExecutionConfig.default({}),
    persistence: PersistenceConfig.default({}),
    tools: ToolsConfig.default({}),
    knowledge: KnowledgeConfig.default({}),
    mcp: McpConfig.default({}),
    routing: RoutingConfig.default({}),
  })
  .strict();

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type AuthSettings = z.infer<typeof AuthConfig>;
export type ServerSettings = z.infer<typeof ServerConfig>;
export type PersistenceSettings = z.infer<typeof PersistenceConfig>;
