import { z } from 'zod';
import { CONTRACT_VERSION, EngineId, ModelRef } from '@coderax/contracts';
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
    native: NativeConfig.default({}),
    opencode: OpenCodeConfig.default({}),
    freebuff: FreebuffConfig.default({}),
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

export const ModelsConfig = z
  .object({
    /**
     * Preferred ordering, not a free claim. A listed model is still refused unless
     * discovery and verification establish zero cost.
     */
    route: z.array(ModelRef).default([]),
    /** Zero-cost is a literal: there is no configuration that enables paid use. */
    allowPaid: z.literal(false).default(false),
    dailyRequestBudget: z.number().int().min(1).max(100_000).default(1_000),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(2_000_000),
    providers: z.array(ModelProviderConfig).default([]),
    attestations: z.array(FreeTierAttestationConfig).default([]),
    routing: RoutingConfig.default({}),
    /** Optional results file produced by `npm run benchmark`. */
    benchmarkResultsPath: z.string().min(1).optional(),
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
    /** Events kept per task after it settles; older ones are pruned. */
    eventRetain: z.number().int().min(16).max(100_000).default(5_000),
    /**
     * How long a workspace stays off-limits after an adapter ignored its abort.
     * The engine cannot kill in-process code, so it refuses to share the
     * directory with it; the entry expires so a deployment recovers by itself.
     */
    cancelQuarantineMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
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
  })
  .strict();

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type AuthSettings = z.infer<typeof AuthConfig>;
export type ServerSettings = z.infer<typeof ServerConfig>;
export type PersistenceSettings = z.infer<typeof PersistenceConfig>;
