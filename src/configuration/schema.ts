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
 * Recorded capability and quota evidence for one model. The router ranks on
 * these numbers; a model with no entry inherits neutral defaults and is still
 * free-only, so omission cannot create a paid path.
 */
export const ModelCatalogEntry = z
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
  })
  .strict();

export const ModelsConfig = z
  .object({
    /** Ordered candidates for free inference routing; first usable one wins. */
    route: z.array(ModelRef).min(1),
    /** Optional capability/quota evidence; ranking is neutral without it. */
    catalog: z.array(ModelCatalogEntry).default([]),
    /** Bounded fallback across approved free models, never to a paid one. */
    maxFallbacks: z.number().int().min(0).max(5).default(2),
    /** Zero-cost is a literal: there is no configuration that enables paid use. */
    allowPaid: z.literal(false).default(false),
    dailyRequestBudget: z.number().int().min(1).max(100_000).default(1_000),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(2_000_000),
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
    /**
     * How long a workspace root stays held after an execution whose termination
     * could not be verified. A new run is refused in that root rather than
     * writing alongside code this process can no longer observe.
     */
    containmentHoldMs: z.number().int().min(1_000).max(600_000).default(60_000),
    /** Events kept per task after it settles; older ones are pruned. */
    eventRetain: z.number().int().min(16).max(100_000).default(5_000),
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

/**
 * Teams are bounded by configuration, not by the model's willingness to stop.
 * Every limit is enforced by the orchestrator; a request above a bound is
 * refused at submission.
 */
export const TeamConfig = z
  .object({
    maxMembers: z.number().int().min(1).max(64).default(8),
    maxParallel: z.number().int().min(1).max(16).default(3),
    maxDurationMs: z.number().int().min(1_000).max(86_400_000).default(900_000),
    maxStepsPerMember: z.number().int().min(1).max(64).default(8),
    maxEvidenceChars: z.number().int().min(100).max(100_000).default(4_000),
    maxArtifactBytes: z.number().int().min(1_024).max(50_000_000).default(1_000_000),
    /** Bound on waiting for a cancelled adapter before authority is revoked. */
    cancelGraceMs: z.number().int().min(100).max(30_000).default(2_000),
    /** A replica that stops heartbeating leaves an interrupted, resumable team. */
    staleAfterMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
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
    teams: TeamConfig.default({}),
  })
  .strict();

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type AuthSettings = z.infer<typeof AuthConfig>;
export type ServerSettings = z.infer<typeof ServerConfig>;
export type PersistenceSettings = z.infer<typeof PersistenceConfig>;
