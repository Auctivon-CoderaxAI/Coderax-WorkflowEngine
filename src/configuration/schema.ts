import { z } from 'zod';
import {
  CONTRACT_VERSION,
  EngineId,
  ModelRef,
  type BrowserLimits,
} from '@coderax/contracts';

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
    // `prefault` applies the empty object before nested defaults are parsed.
    // Zod 4's `default` requires the fully-populated output shape as its input.
    native: NativeConfig.prefault({}),
    opencode: OpenCodeConfig.prefault({}),
    freebuff: FreebuffConfig.prefault({}),
  })
  .strict();

export const ModelsConfig = z
  .object({
    /** Ordered candidates for free inference routing; first usable one wins. */
    route: z.array(ModelRef).min(1),
    /** Zero-cost is a literal: there is no configuration that enables paid use. */
    allowPaid: z.literal(false).default(false),
    dailyRequestBudget: z.number().int().min(1).max(100_000).default(1_000),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(2_000_000),
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
    /** How long graceful shutdown may drain before it fails closed. */
    shutdownGraceMs: z.number().int().min(100).max(300_000).default(10_000),
  })
  .strict();

export const GamesConfig = z
  .object({
    /** Off disables both game capabilities at the route boundary. */
    enabled: z.boolean().default(true),
    /** The gaming agent can be disabled without disabling the studio. */
    agentEnabled: z.boolean().default(true),
    maxProjectsPerOwner: z.number().int().min(1).max(500).default(50),
    /** The hard ceiling a session request may not exceed. */
    maxSessionTicks: z.number().int().min(600).max(200_000).default(40_000),
    /** A paused session holds its task slot for at most this long. */
    maxPauseMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
  })
  .strict();
export const BrowserRemoteConfig = z
  .object({
    /** An HTTPS endpoint that implements the versioned browser protocol. */
    baseURL: z.string().url().optional(),
    /** Name of the variable holding the provider token, never the token. */
    tokenEnv: z.string().trim().min(1).default('CODERAX_BROWSER_TOKEN'),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    /**
     * The owner's attestation that this endpoint is authorized, zero-cost and
     * cloud-hosted. Without it the adapter stays fail-closed and reports
     * `unverified`; it cannot be set on the owner's behalf.
     */
    zeroCostAttested: z.boolean().default(false),
  })
  .strict();

/**
 * Cloud browser integration. The default is disabled with no provider, which is
 * the only truthful state until an authorized zero-cost endpoint has been
 * verified. No field can enable paid infrastructure.
 */
export const BrowserConfig = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['none', 'http']).default('none'),
    allowPaid: z.literal(false).default(false),
    sessionTtlMs: z.number().int().min(60_000).max(3_600_000).default(900_000),
    maxSessionsPerOwner: z.number().int().min(1).max(16).default(3),
    maxScreenshotBytes: z.number().int().min(1_024).max(4_194_304).default(2_097_152),
    /** Bounded by the request body limit so an upload cannot be truncated. */
    maxUploadBytes: z.number().int().min(1_024).max(524_288).default(524_288),
    remote: BrowserRemoteConfig.prefault({}),
  })
  .strict();

export const SchedulesConfig = z
  .object({
    /** The loop is process-owned; disabling it leaves stored schedules dormant. */
    enabled: z.boolean().default(true),
    tickMs: z.number().int().min(50).max(60_000).default(5_000),
    /** Schedules and receipts examined per pass; bounds one tick's work. */
    batchSize: z.number().int().min(1).max(200).default(50),
    /** Engine-wide ceiling on concurrently dispatched scheduled runs. */
    maxConcurrentRuns: z.number().int().min(1).max(16).default(2),
    /** Lateness beyond this is a missed occurrence, never a fired backlog. */
    missedGraceMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
    /** A receipt with no task younger than this may still be dispatching. */
    dispatchTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
    /** Consecutive failures that pause a schedule to stop a runaway loop. */
    pauseAfterFailures: z.number().int().min(1).max(100).default(5),
    /** Execution receipts returned by the history operation by default. */
    historyLimit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

/**
 * Durable artifact bounds. Every ceiling is a hard refusal, never a warning:
 * an oversized upload is rejected before it is written and an owner over quota
 * is refused rather than allowed to grow unbounded storage.
 */
export const ArtifactsConfig = z
  .object({
    maxBytesPerArtifact: z.number().int().min(1_024).max(10_485_760).default(8_388_608),
    maxBytesPerOwner: z.number().int().min(1_024).max(1_073_741_824).default(268_435_456),
    maxArtifactsPerOwner: z.number().int().min(1).max(10_000).default(1_000),
    maxVersionsPerArtifact: z.number().int().min(1).max(100).default(20),
    /** 0 keeps an artifact until it is deleted or a version is pruned. */
    defaultRetentionDays: z.number().int().min(0).max(3_650).default(0),
    maxRetentionDays: z.number().int().min(1).max(3_650).default(365),
    /** MongoDB document limit is 16 MiB; a chunk stays comfortably below it. */
    chunkBytes: z.number().int().min(65_536).max(4_194_304).default(1_048_576),
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
    server: ServerConfig.prefault({}),
    auth: AuthConfig,
    workspaces: WorkspacesConfig,
    engines: EnginesConfig.prefault({}),
    models: ModelsConfig,
    execution: ExecutionConfig.prefault({}),
    browsers: BrowserConfig.prefault({}),
    schedules: SchedulesConfig.prefault({}),
    artifacts: ArtifactsConfig.prefault({}),
    persistence: PersistenceConfig.prefault({}),
    games: GamesConfig.prefault({}),
  })
  .strict();

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type AuthSettings = z.infer<typeof AuthConfig>;
export type ServerSettings = z.infer<typeof ServerConfig>;
export type PersistenceSettings = z.infer<typeof PersistenceConfig>;
export type BrowserSettings = z.infer<typeof BrowserConfig>;
export type BrowserRemoteSettings = z.infer<typeof BrowserRemoteConfig>;

/** Derived once so the provider and the API report the same enforced limits. */
export function browserLimits(browsers: BrowserSettings): BrowserLimits {
  return {
    maxSessionTtlSeconds: Math.floor(browsers.sessionTtlMs / 1000),
    maxSessionsPerOwner: browsers.maxSessionsPerOwner,
    maxScreenshotBytes: browsers.maxScreenshotBytes,
    maxUploadBytes: browsers.maxUploadBytes,
  };
}
export type ArtifactsSettings = z.infer<typeof ArtifactsConfig>;
