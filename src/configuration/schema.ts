import { z } from 'zod';
import { CONTRACT_VERSION, EngineId, ModelRef } from '@coderax/contracts';
import {
  CREDENTIAL_SOURCES,
  DATA_RETENTION,
  PROCESSING_LOCATIONS,
  PROCESSING_OPERATIONS,
  TRAINING_USE,
} from '../models/policy.js';
import { endpointIssue } from '../security/endpoint.js';

/**
 * Every endpoint that receives a credential must be https unless it is loopback,
 * and no endpoint may carry a credential in its URL. The rule lives here so a
 * provider, an external agent and an embedding endpoint cannot disagree.
 */
const SecureEndpoint = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const issue = endpointIssue(value);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: `endpoint ${issue}` });
  });

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
    /**
     * Bounded so a media upload fits its canonical base64 envelope while a
     * malformed client still cannot make the process buffer without limit.
     */
    maxBodyBytes: z.number().int().min(1_048_576).max(16_777_216).default(8_388_608),
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
    /** Independent steps a complex plan may run at once. */
    maxParallelSteps: z.number().int().min(1).max(8).default(3),
    /** Revised plans allowed after a step or verification failure. */
    maxReplans: z.number().int().min(0).max(5).default(2),
    /** Attempts per step, including the first; corrections stay on this model. */
    maxStepAttempts: z.number().int().min(1).max(3).default(2),
    /** Hard bound on model calls and file reads for one run. */
    maxIterations: z.number().int().min(1).max(128).default(32),
  })
  .strict();

export const OpenCodeConfig = z
  .object({
    enabled: z.boolean().default(false),
    baseURL: SecureEndpoint.optional(),
    model: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
  })
  .strict();

export const FreebuffConfig = z
  .object({
    enabled: z.boolean().default(false),
    baseURL: SecureEndpoint.optional(),
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
    // `prefault` applies the empty object before nested defaults are parsed.
    // Zod 4's `default` requires the fully-populated output shape as its input.
    native: NativeConfig.prefault({}),
    opencode: OpenCodeConfig.prefault({}),
    freebuff: FreebuffConfig.prefault({}),
  })
  .strict();

/**
 * A provider is configured by URL and the *name* of its credential variable.
 * The key is resolved from the environment at startup; no secret belongs in the
 * configuration document.
 */
export const ModelProviderConfig = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'provider id must be lower-case letters, digits, - or _'),
    kind: z.enum(['openai', 'gemini']).default('openai'),
    baseURL: SecureEndpoint,
    apiKeyEnv: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'apiKeyEnv must be an environment variable name'),
    requestsPerMinute: z.number().int().min(1).max(600).default(20),
    tokensPerMinute: z.number().int().min(1_000).max(50_000_000).default(100_000),
    maxConcurrency: z.number().int().min(1).max(8).default(2),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  })
  .strict();

/**
 * A time-bounded statement that an exact provider model is on a zero-cost tier,
 * with a URL that evidences it. Required only when the provider publishes no
 * machine-readable price. It expires so a stale claim cannot route forever.
 */
export const FreeTierAttestationConfig = z
  .object({
    providerId: z.string().trim().min(1).max(64),
    modelId: z.string().trim().min(1).max(160),
    evidenceUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'evidenceUrl must be https'),
    verifiedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * One explicitly approved provider policy. Every field is recorded evidence, not
 * a default: a provider without a record is refused, and a mode or operation
 * that is not listed is not approved. Private grants additionally require no
 * stored retention, prohibited training, a declared location and an
 * owner-managed credential; the router enforces those at request time.
 */
export const ProviderPolicyGrantConfig = z
  .object({
    operation: z.enum(PROCESSING_OPERATIONS),
    mode: z.enum(['private', 'cloud']),
    location: z.enum(PROCESSING_LOCATIONS),
  })
  .strict();

export const ProviderPolicyConfig = z
  .object({
    providerId: z.string().trim().min(1).max(64),
    retention: z.enum(DATA_RETENTION),
    training: z.enum(TRAINING_USE),
    location: z.enum(PROCESSING_LOCATIONS),
    credentials: z.enum(CREDENTIAL_SOURCES),
    modes: z.array(z.enum(['private', 'cloud'])).min(1),
    grants: z.array(ProviderPolicyGrantConfig).default([]),
    evidenceUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'evidenceUrl must be https'),
    verifiedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

export const RoutingConfig = z
  .object({
    /** How many ranked candidates a plan may consider. Bound, never unbounded. */
    maxCandidates: z.number().int().min(1).max(8).default(4),
    /** Extra candidates tried after the first failure. 0 disables fallback. */
    maxFallbacks: z.number().int().min(0).max(4).default(2),
    failureThreshold: z.number().int().min(1).max(10).default(3),
    cooldownMs: z.number().int().min(1_000).max(600_000).default(30_000),
    discoveryIntervalMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
    defaultMaxOutputTokens: z.number().int().min(32).max(32_768).default(1_024),
    contextMarginTokens: z.number().int().min(0).max(8_192).default(64),
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
    /**
     * Preferred ordering, not a free claim. A listed model is still refused unless
     * discovery and verification establish zero cost.
     */
    route: z.array(ModelRef).default([]),
    /** Optional capability/quota evidence; ranking is neutral without it. */
    catalog: z.array(ModelCatalogEntry).default([]),
    /** Bounded fallback across approved free models, never to a paid one. */
    maxFallbacks: z.number().int().min(0).max(5).default(2),
    /** Zero-cost is a literal: there is no configuration that enables paid use. */
    allowPaid: z.literal(false).default(false),
    dailyRequestBudget: z.number().int().min(1).max(100_000).default(1_000),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(2_000_000),
    providers: z.array(ModelProviderConfig).default([]),
    attestations: z.array(FreeTierAttestationConfig).default([]),
    /** Hosted inference requires an explicit owner-approved policy record. */
    policy: z.array(ProviderPolicyConfig).default([]),
    routing: RoutingConfig.prefault({}),
    /** Optional results file produced by `npm run benchmark`. */
    benchmarkResultsPath: z.string().min(1).optional(),
  })
  .strict();

/**
 * Media limits are enforced before a byte is decoded and before a provider is
 * called. `maxBytes` is also bounded by the transport body limit, so an upload
 * that passes validation cannot be larger than the server is willing to read.
 */
export const MediaConfig = z
  .object({
    enabled: z.boolean().default(true),
    maxBytes: z.number().int().min(1_024).max(5_242_880).default(4_194_304),
    maxPixels: z.number().int().min(10_000).max(100_000_000).default(40_000_000),
    maxAttachments: z.number().int().min(1).max(4).default(4),
    creativeMaxBytes: z.number().int().min(4_096).max(1_048_576).default(262_144),
    /**
     * Private mode is a storage partition, not a local inference guarantee. An
     * attachment would be sent to the verified-free provider, so exporting one
     * from a private conversation requires an explicit operator decision.
     */
    allowPrivateModeAttachments: z.boolean().default(false),
  })
  .strict();

export const ExecutionConfig = z
  .object({
    /** A run holds its lease only while it heartbeats inside this window. */
    leaseTtlMs: z.number().int().min(3_000).max(600_000).default(30_000),
    heartbeatIntervalMs: z.number().int().min(500).max(60_000).default(10_000),
    maxConcurrentTasks: z.number().int().min(1).max(64).default(4),
    /**
     * Bounds one replay read and the memory driver's retained window. The durable
     * log keeps everything else; a tail reads the next page on its next poll.
     */
    eventBufferSize: z.number().int().min(16).max(100_000).default(2_000),
    /** How often a live tail re-reads the durable log for new events. */
    eventPollMs: z.number().int().min(10).max(5_000).default(100),
    /** Age at which a stored event expires; the only source of truncation. */
    eventRetentionMs: z.number().int().min(60_000).max(2_592_000_000).default(604_800_000),
    /** A crashed run's row is readable for this long before a sweep reclaims it. */
    retentionMs: z.number().int().min(60_000).max(604_800_000).default(86_400_000),
    /** How long a cancelled adapter may take to stop before the run is settled. */
    cancelGraceMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();

export const ScheduleConfig = z
  .object({
    /** A durable schedule is only fired by a running engine tick. */
    enabled: z.boolean().default(true),
    tickIntervalMs: z.number().int().min(100).max(300_000).default(2_000),
    /** Maximum due schedules handled in one tick, bounding a thundering herd. */
    tickBatch: z.number().int().min(1).max(100).default(10),
  })
  .strict();

export const ArtifactsConfig = z
  .object({
    maxBytesPerArtifact: z.number().int().min(1_024).max(10_485_760).default(8_388_608),
    maxBytesPerOwner: z.number().int().min(1_024).max(1_073_741_824).default(268_435_456),
    maxArtifactsPerOwner: z.number().int().min(1).max(10_000).default(1_000),
    maxVersionsPerArtifact: z.number().int().min(1).max(100).default(20),
    defaultRetentionDays: z.number().int().min(0).max(3_650).default(0),
    maxRetentionDays: z.number().int().min(1).max(3_650).default(365),
    chunkBytes: z.number().int().min(65_536).max(4_194_304).default(1_048_576),
    /**
     * Test/dev only: allow artifact and media writes through the in-memory
     * backend, which cannot survive a restart. Production defaults to false.
     */
    allowEphemeral: z.boolean().default(false),
  })
  .strict();

export type ArtifactsSettings = z.infer<typeof ArtifactsConfig>;

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
    server: ServerConfig.prefault({}),
    auth: AuthConfig,
    workspaces: WorkspacesConfig,
    engines: EnginesConfig.prefault({}),
    models: ModelsConfig,
    media: MediaConfig.default({}),
    execution: ExecutionConfig.default({}),
    schedules: ScheduleConfig.default({}),
    artifacts: ArtifactsConfig.default({}),
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
