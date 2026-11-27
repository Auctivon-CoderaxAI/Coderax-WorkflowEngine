import { z } from 'zod';
import { IsoDateTime } from './primitives.js';

/**
 * Native Game Studio and Native Gaming Agent contracts.
 *
 * These are two distinct Coderax Native capabilities that share one contract
 * module because they share one evidence chain: a studio build is only playable
 * by the gaming agent once it has a verification report, and the gaming agent
 * only observes screens and state that the studio's own deterministic runtime
 * produced. Nothing here asserts that an arbitrary third-party game can be
 * played; that would require a verified external environment, and the capability
 * report says so explicitly.
 */

export const GAME_GENRES = [
  'platformer',
  'puzzle',
  'shooter',
  'arcade',
  'strategy',
  'role_playing',
  'adventure',
  'other',
] as const;
export type GameGenre = (typeof GAME_GENRES)[number];

export const GAME_CAMERAS = [
  'side_view',
  'top_down',
  'isometric',
  'ui_only',
  'first_person',
] as const;
export type GameCamera = (typeof GAME_CAMERAS)[number];

/**
 * Mechanics are composed, not chosen from a fixed gallery. A build includes the
 * subset the spec names, and the generated source contains exactly those systems.
 */
export const GAME_MECHANICS = [
  'gravity',
  'jump',
  'double_jump',
  'dash',
  'shoot',
  'enemies',
  'hazards',
  'collectibles',
  'moving_platforms',
  'push_blocks',
  'switches',
  'timer',
] as const;
export type GameMechanic = (typeof GAME_MECHANICS)[number];

/** Every action an owner or the agent may send. The granted subset is per session. */
export const GAME_ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'fire', 'dash'] as const;
export type GameAction = (typeof GAME_ACTIONS)[number];

export const GameInput = z
  .object({
    left: z.boolean().default(false),
    right: z.boolean().default(false),
    up: z.boolean().default(false),
    down: z.boolean().default(false),
    jump: z.boolean().default(false),
    fire: z.boolean().default(false),
    dash: z.boolean().default(false),
  })
  .strict();
export type GameInput = z.infer<typeof GameInput>;

export const GameSpec = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    genre: z.enum(GAME_GENRES),
    camera: z.enum(GAME_CAMERAS),
    players: z.union([z.literal(1), z.literal(2)]),
    difficulty: z.number().int().min(1).max(5),
    mechanics: z.array(z.enum(GAME_MECHANICS)).min(1).max(GAME_MECHANICS.length),
    levels: z.number().int().min(1).max(8),
    seed: z.number().int().min(0).max(2_147_483_647),
    coreLoop: z.string().max(2000),
    winCondition: z.string().max(2000),
    artDirection: z.string().max(2000),
  })
  .strict();
export type GameSpec = z.infer<typeof GameSpec>;

export const GameMechanicPlan = z
  .object({
    id: z.enum(GAME_MECHANICS),
    purpose: z.string().min(1).max(300),
    systems: z.array(z.string().min(1).max(80)).min(1).max(12),
  })
  .strict();
export type GameMechanicPlan = z.infer<typeof GameMechanicPlan>;

export const GameDesignPlan = z
  .object({
    title: z.string().min(1).max(120),
    logline: z.string().min(1).max(600),
    pillars: z.array(z.string().min(1).max(200)).min(1).max(8),
    mechanics: z.array(GameMechanicPlan).min(1).max(GAME_MECHANICS.length),
    levelArc: z
      .array(
        z
          .object({
            index: z.number().int().min(1),
            name: z.string().min(1).max(80),
            intent: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    controls: z
      .array(
        z
          .object({
            action: z.enum(GAME_ACTIONS),
            keys: z.string().min(1).max(60),
            description: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(GAME_ACTIONS.length),
    scoring: z
      .array(
        z
          .object({
            event: z.string().min(1).max(80),
            points: z.number().int(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    art: z
      .object({
        palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).min(3).max(8),
        style: z.string().min(1).max(300),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            kind: z.enum(['sprite', 'tile']),
            purpose: z.string().min(1).max(200),
            license: z.literal('generated-original'),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    risks: z.array(z.string().min(1).max(300)).max(8),
    modelAssisted: z.boolean(),
  })
  .strict();
export type GameDesignPlan = z.infer<typeof GameDesignPlan>;

export const GAME_FILE_KINDS = ['html', 'js', 'json', 'svg', 'md'] as const;

export const GameFile = z
  .object({
    path: z.string().min(1).max(200),
    kind: z.enum(GAME_FILE_KINDS),
    bytes: z.number().int().nonnegative(),
    digest: z.string().min(1).max(128),
  })
  .strict();
export type GameFile = z.infer<typeof GameFile>;

export const GameMeasurement = z.union([z.number(), z.string().max(300), z.boolean()]);
export type GameMeasurement = z.infer<typeof GameMeasurement>;

export const GameCheck = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    passed: z.boolean(),
    detail: z.string().max(600),
    measurements: z.record(GameMeasurement),
  })
  .strict();
export type GameCheck = z.infer<typeof GameCheck>;

export const GameLevelResult = z
  .object({
    levelId: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    completed: z.boolean(),
    ticks: z.number().int().nonnegative(),
    score: z.number().int(),
    deaths: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
  })
  .strict();
export type GameLevelResult = z.infer<typeof GameLevelResult>;

export const GameVerification = z
  .object({
    passed: z.boolean(),
    checks: z.array(GameCheck).min(1).max(40),
    levels: z.array(GameLevelResult).min(1).max(8),
    deterministicReplay: z.boolean(),
    replayDigest: z.string().min(1).max(128),
    frameCount: z.number().int().nonnegative(),
    distinctColors: z.number().int().nonnegative(),
    artifactPaths: z.array(z.string().min(1).max(400)).max(24),
    createdAt: IsoDateTime,
  })
  .strict();
export type GameVerification = z.infer<typeof GameVerification>;

export const GameBuild = z
  .object({
    buildId: z.string().min(1).max(120),
    gameId: z.string().min(1).max(120),
    specRevision: z.number().int().min(1),
    attempt: z.number().int().min(1),
    status: z.enum(['verified', 'failed']),
    digest: z.string().min(1).max(128),
    entry: z.string().min(1).max(200),
    previewPath: z.string().min(1).max(300),
    files: z.array(GameFile).min(1).max(64),
    verification: GameVerification,
    createdAt: IsoDateTime,
  })
  .strict();
export type GameBuild = z.infer<typeof GameBuild>;

/** A historical build as listed by the version-history operation. */
export const GameBuildSummary = z
  .object({
    buildId: z.string().min(1).max(120),
    specRevision: z.number().int().min(1),
    attempt: z.number().int().min(1),
    status: z.enum(['verified', 'failed']),
    digest: z.string().min(1).max(128),
    verified: z.boolean(),
    createdAt: IsoDateTime,
  })
  .strict();
export type GameBuildSummary = z.infer<typeof GameBuildSummary>;

export const GameBuildList = z
  .object({
    gameId: z.string().min(1).max(120),
    builds: z.array(GameBuildSummary).max(64),
  })
  .strict();
export type GameBuildList = z.infer<typeof GameBuildList>;

/** Restores a build and the exact spec it was generated from. */
export const RestoreGameBuildRequest = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict();
export type RestoreGameBuildRequest = z.infer<typeof RestoreGameBuildRequest>;

export const GAME_PROJECT_STATUSES = ['draft', 'spec_ready', 'built', 'verified', 'failed'] as const;

export const GameProject = z
  .object({
    gameId: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    summary: z.string().max(600),
    spec: GameSpec.nullable(),
    specRevision: z.number().int().nonnegative(),
    revision: z.number().int().min(1),
    status: z.enum(GAME_PROJECT_STATUSES),
    design: GameDesignPlan.nullable(),
    build: GameBuild.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .strict();
export type GameProject = z.infer<typeof GameProject>;

export const GameProjectList = z
  .object({
    projects: z.array(GameProject),
    nextCursor: z.string().max(200).nullable(),
  })
  .strict();
export type GameProjectList = z.infer<typeof GameProjectList>;

export const CreateGameRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    summary: z.string().max(600).optional(),
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();
export type CreateGameRequest = z.infer<typeof CreateGameRequest>;

export const SaveGameSpecRequest = z
  .object({
    spec: GameSpec,
    expectedRevision: z.number().int().min(1),
  })
  .strict();
export type SaveGameSpecRequest = z.infer<typeof SaveGameSpecRequest>;

export const BuildGameRequest = z
  .object({
    expectedSpecRevision: z.number().int().min(1).optional(),
  })
  .strict();
export type BuildGameRequest = z.infer<typeof BuildGameRequest>;

export const IterateGameRequest = z
  .object({
    instruction: z.string().trim().min(1).max(2000),
    expectedRevision: z.number().int().min(1),
  })
  .strict();
export type IterateGameRequest = z.infer<typeof IterateGameRequest>;

export const GameIteration = z
  .object({
    project: GameProject,
    changes: z.array(z.string().min(1).max(300)).min(1).max(24),
    debugAttempts: z.number().int().min(1).max(8),
    modelAssisted: z.boolean(),
  })
  .strict();
export type GameIteration = z.infer<typeof GameIteration>;

export const GameExport = z
  .object({
    filename: z.string().min(1).max(160),
    mediaType: z.literal('application/zip'),
    bytes: z.number().int().nonnegative(),
    digest: z.string().min(1).max(128),
    base64: z.string().min(1),
  })
  .strict();
export type GameExport = z.infer<typeof GameExport>;

/** A session objective is verified against measured game state, never self-reported. */
export const GAME_OBJECTIVES = [
  'reach_goal',
  'complete_levels',
  'score_at_least',
  'defeat_enemies',
] as const;

export const GameObjective = z
  .object({
    kind: z.enum(GAME_OBJECTIVES),
    target: z.number().int().min(1).max(100_000),
  })
  .strict();
export type GameObjective = z.infer<typeof GameObjective>;

export const CreateGameSessionRequest = z
  .object({
    buildId: z.string().min(1).max(120).optional(),
    objective: GameObjective,
    allowedActions: z.array(z.enum(GAME_ACTIONS)).min(1).max(GAME_ACTIONS.length),
    maxTicks: z.number().int().min(600).max(200_000).default(40_000),
  })
  .strict();
export type CreateGameSessionRequest = z.infer<typeof CreateGameSessionRequest>;

export const GAME_SESSION_STATUSES = [
  'starting',
  'running',
  'paused',
  'taken_over',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GameSessionStatus = (typeof GAME_SESSION_STATUSES)[number];

export const GameProgress = z
  .object({
    levelsCleared: z.number().int().nonnegative(),
    totalLevels: z.number().int().nonnegative(),
    currentLevel: z.number().int().nonnegative(),
    score: z.number().int(),
    ticks: z.number().int().nonnegative(),
    deaths: z.number().int().nonnegative(),
    enemiesDefeated: z.number().int().nonnegative(),
  })
  .strict();
export type GameProgress = z.infer<typeof GameProgress>;

export const GameLogEntry = z
  .object({
    at: IsoDateTime,
    level: z.string().min(1).max(80),
    event: z.string().min(1).max(80),
    detail: z.string().max(300),
  })
  .strict();
export type GameLogEntry = z.infer<typeof GameLogEntry>;

export const GameSessionVerification = z
  .object({
    objective: GameObjective,
    achieved: z.boolean(),
    checks: z.array(GameCheck).min(1).max(20),
    progress: GameProgress,
    finalDigest: z.string().min(1).max(128),
    artifactPaths: z.array(z.string().min(1).max(400)).max(12),
    completedAt: IsoDateTime,
  })
  .strict();
export type GameSessionVerification = z.infer<typeof GameSessionVerification>;

export const GameSession = z
  .object({
    sessionId: z.string().min(1).max(120),
    gameId: z.string().min(1).max(120),
    buildId: z.string().min(1).max(120),
    taskId: z.string().min(1).max(120).nullable(),
    generation: z.number().int().nonnegative(),
    status: z.enum(GAME_SESSION_STATUSES),
    objective: GameObjective,
    allowedActions: z.array(z.enum(GAME_ACTIONS)).min(1).max(GAME_ACTIONS.length),
    progress: GameProgress,
    memory: z.array(z.string().min(1).max(300)).max(64),
    logs: z.array(GameLogEntry).max(200),
    verification: GameSessionVerification.nullable(),
    failure: z
      .object({ code: z.string().min(1).max(60), detail: z.string().max(600) })
      .strict()
      .nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .strict();
export type GameSession = z.infer<typeof GameSession>;

export const GameSessionList = z
  .object({ sessions: z.array(GameSession) })
  .strict();
export type GameSessionList = z.infer<typeof GameSessionList>;

export const GameSessionLogs = z
  .object({
    sessionId: z.string().min(1).max(120),
    logs: z.array(GameLogEntry).max(200),
    memory: z.array(z.string().min(1).max(300)).max(64),
  })
  .strict();
export type GameSessionLogs = z.infer<typeof GameSessionLogs>;

export const GameFrame = z
  .object({
    width: z.number().int().min(1).max(1024),
    height: z.number().int().min(1).max(1024),
    pngBase64: z.string().min(1),
  })
  .strict();
export type GameFrame = z.infer<typeof GameFrame>;

export const GameStateView = z
  .object({
    levelIndex: z.number().int().nonnegative(),
    levelId: z.string().min(1).max(80),
    levelCount: z.number().int().nonnegative(),
    tick: z.number().int().nonnegative(),
    status: z.enum(['playing', 'won', 'lost']),
    score: z.number().int(),
    health: z.number().int(),
    deaths: z.number().int().nonnegative(),
    collected: z.number().int().nonnegative(),
    collectibles: z.number().int().nonnegative(),
    enemiesAlive: z.number().int().nonnegative(),
    enemiesDefeated: z.number().int().nonnegative(),
    player: z
      .object({
        x: z.number(),
        y: z.number(),
        vx: z.number(),
        vy: z.number(),
        onGround: z.boolean(),
      })
      .strict(),
    objectiveTarget: z
      .object({ x: z.number(), y: z.number() })
      .strict()
      .nullable(),
  })
  .strict();
export type GameStateView = z.infer<typeof GameStateView>;

export const GameObservation = z
  .object({
    sessionId: z.string().min(1).max(120),
    status: z.enum(GAME_SESSION_STATUSES),
    observedAt: IsoDateTime,
    state: GameStateView,
    frame: GameFrame.nullable(),
    availableActions: z.array(z.enum(GAME_ACTIONS)).min(1).max(GAME_ACTIONS.length),
  })
  .strict();
export type GameObservation = z.infer<typeof GameObservation>;

export const GameSessionControlRequest = z
  .object({
    action: z.enum(['pause', 'resume', 'takeover', 'release', 'cancel', 'input']),
    input: GameInput.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type GameSessionControlRequest = z.infer<typeof GameSessionControlRequest>;

export const GAME_CAPABILITY_STATUSES = ['operational', 'degraded', 'blocked', 'unsupported'] as const;

export const GameCapability = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    status: z.enum(GAME_CAPABILITY_STATUSES),
    summary: z.string().min(1).max(500),
    available: z.boolean(),
    detail: z.string().min(1).max(600),
    evidence: z.array(z.string().min(1).max(300)).max(20),
    environments: z.array(z.string().min(1).max(120)).max(8),
    isolation: z.string().min(1).max(80).nullable(),
    modelAssisted: z.boolean(),
    blockedBy: z.string().min(1).max(400).nullable(),
  })
  .strict();
export type GameCapability = z.infer<typeof GameCapability>;

export const GameCapabilityReport = z
  .object({
    checkedAt: IsoDateTime,
    capabilities: z.array(GameCapability).min(1).max(8),
  })
  .strict();
export type GameCapabilityReport = z.infer<typeof GameCapabilityReport>;
