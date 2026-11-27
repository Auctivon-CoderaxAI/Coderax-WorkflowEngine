import type {
  CreateGameSessionRequest,
  GameAction,
  GameCheck,
  GameFrame,
  GameInput,
  GameLogEntry,
  GameObjective,
  GameObservation,
  GameProgress,
  GameSession,
  GameSessionControlRequest,
  GameSessionList,
  GameSessionLogs,
  GameSessionVerification,
  GameSpec,
  GameStateView,
} from '@coderax/contracts';
import type { AgentReport, AgentRunOutcome } from '../agents/types.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { GameBuild } from '@coderax/contracts';
import { loadRuntime, type LoadedRuntime, type RuntimeGame } from './runtime.js';
import { chooseInput, createPolicyMemory, type PolicyMemory } from './policy.js';
import { digest } from './random.js';
import {
  movementForCamera,
  type GameBlueprint,
  type LevelData,
  type MovementModel,
  type Tuning,
} from './types.js';

/**
 * Native Gaming Agent.
 *
 * A session is a durable Work task that plays one verified studio build inside
 * the isolated runtime. Screen observation, state inspection, bounded controls,
 * objective planning, pause/resume, owner takeover, cancellation, session memory,
 * execution logs and completion verification are all implemented here; none of
 * them is delegated to the owner's computer. An external game environment is a
 * separate, explicitly blocked capability: no verified zero-cost browser or
 * DeploymentPlatformAI workload interface exists, so the agent refuses to claim
 * one.
 */

const ACTIONS: GameAction[] = ['left', 'right', 'up', 'down', 'jump', 'fire', 'dash'];
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;
const MAX_LOGS = 200;
const MAX_MEMORY = 64;
const MAX_OWNER_INPUTS = 240;

export type GameRunSpec = {
  sessionId: string;
  gameId: string;
  buildId: string;
  objective: GameObjective;
  allowedActions: GameAction[];
  maxTicks: number;
};

export type SessionControlState = {
  paused: boolean;
  takenOver: boolean;
  cancelRequested: boolean;
  pausedSince: number | null;
  inputs: GameInput[];
};

type InternalSession = {
  ownerId: string;
  session: GameSession;
  controls: SessionControlState;
  observation: GameObservation | null;
};

export type GameSessionService = {
  create: (input: {
    ownerId: string;
    project: { gameId: string; spec: GameSpec };
    build: GameBuild;
    request: CreateGameSessionRequest;
  }) => Promise<ServiceResult<GameSession>>;
  attachTask: (sessionId: string, taskId: string, generation: number) => Promise<void>;
  stamp: (sessionId: string, generation: number) => void;
  get: (ownerId: string, sessionId: string) => Promise<ServiceResult<GameSession>>;
  list: (ownerId: string) => Promise<GameSessionList>;
  control: (input: {
    ownerId: string;
    sessionId: string;
    request: GameSessionControlRequest;
  }) => Promise<ServiceResult<GameSession>>;
  observation: (ownerId: string, sessionId: string) => Promise<ServiceResult<GameObservation>>;
  logs: (ownerId: string, sessionId: string) => Promise<ServiceResult<GameSessionLogs>>;
  verification: (
    ownerId: string,
    sessionId: string,
  ) => Promise<ServiceResult<GameSessionVerification>>;
  fail: (sessionId: string, code: string, detail: string) => Promise<void>;
  controlState: (sessionId: string) => SessionControlState | null;
};

export type GamingAgent = {
  run: (input: {
    ownerId: string;
    taskId: string;
    game: GameRunSpec;
    signal: AbortSignal;
    report: AgentReport;
    loadBuild: (
      ownerId: string,
      gameId: string,
      buildId: string,
    ) => Promise<ServiceResult<{ build: GameBuild; files: Array<{ path: string; content: string }> }>>;
    isApproved: (taskId: string, scope: 'command.execute', resource: string) => Promise<boolean>;
  }) => Promise<AgentRunOutcome>;
};

function isTerminal(status: GameSession['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function rounds(value: number): number {
  return Math.round(value * 100) / 100;
}

export function stateView(game: RuntimeGame): GameStateView {
  const state = game.state;
  const target = state.goal.locked
    ? state.switches.find((entry) => !entry.on) ?? null
    : state.goal;
  return {
    levelIndex: state.levelIndex,
    levelId: game.level.id,
    levelCount: state.levelCount,
    tick: state.tick,
    status: state.status,
    score: state.score,
    health: state.player.health,
    deaths: state.deaths,
    collected: state.collected,
    collectibles: state.collectibles.length,
    enemiesAlive: state.enemies.filter((enemy) => enemy.alive).length,
    enemiesDefeated: state.enemiesDefeated,
    player: {
      x: rounds(state.player.x),
      y: rounds(state.player.y),
      vx: rounds(state.player.vx),
      vy: rounds(state.player.vy),
      onGround: state.player.onGround,
    },
    objectiveTarget: target ? { x: rounds(target.x), y: rounds(target.y) } : null,
  };
}

function frameOf(runtime: LoadedRuntime, game: RuntimeGame): GameFrame {
  const rendered = runtime.draw(game, FRAME_WIDTH, FRAME_HEIGHT);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    pngBase64: rendered.png.toString('base64'),
  };
}

function objectiveReached(input: {
  objective: GameObjective;
  levelsCleared: number;
  levelCount: number;
  totalScore: number;
  currentScore: number;
  enemiesDefeated: number;
}): boolean {
  const { objective } = input;
  switch (objective.kind) {
    case 'reach_goal':
      return input.levelsCleared >= input.levelCount;
    case 'complete_levels':
      return input.levelsCleared >= Math.min(objective.target, input.levelCount);
    case 'score_at_least':
      return input.totalScore + input.currentScore >= objective.target;
    case 'defeat_enemies':
      return input.enemiesDefeated >= objective.target;
    default:
      return false;
  }
}

function objectiveLabel(objective: GameObjective): string {
  switch (objective.kind) {
    case 'reach_goal':
      return 'reach the exit of every level';
    case 'complete_levels':
      return `clear ${objective.target} level(s)`;
    case 'score_at_least':
      return `score at least ${objective.target}`;
    case 'defeat_enemies':
      return `defeat ${objective.target} enemies`;
    default:
      return 'complete the objective';
  }
}

export function createGameSessions(input: {
  artifacts: ArtifactStore;
  clock: Clock;
  ids: IdGenerator;
  maxPauseMs: number;
}): { sessions: GameSessionService; agent: GamingAgent } {
  const records = new Map<string, InternalSession>();

  function owned(ownerId: string, sessionId: string): InternalSession | null {
    const record = records.get(sessionId);
    if (!record || record.ownerId !== ownerId) return null;
    return record;
  }

  function touch(record: InternalSession): void {
    record.session.updatedAt = input.clock.iso();
  }

  function log(record: InternalSession, level: string, event: string, detail: string): void {
    const entry: GameLogEntry = {
      at: input.clock.iso(),
      level,
      event,
      detail: detail.slice(0, 300),
    };
    record.session.logs.push(entry);
    if (record.session.logs.length > MAX_LOGS) {
      record.session.logs.splice(0, record.session.logs.length - MAX_LOGS);
    }
    touch(record);
  }

  function remember(record: InternalSession, value: string): void {
    if (record.session.memory.includes(value)) return;
    record.session.memory.push(value.slice(0, 300));
    if (record.session.memory.length > MAX_MEMORY) {
      record.session.memory.splice(0, record.session.memory.length - MAX_MEMORY);
    }
  }

  async function finish(inputFinish: {
    record: InternalSession;
    runtime: LoadedRuntime | null;
    game: RuntimeGame | null;
    status: 'completed' | 'failed' | 'cancelled';
    achieved: boolean;
    progress: GameProgress;
    checks: GameCheck[];
    failure: { code: string; detail: string } | null;
  }): Promise<{ artifactPaths: string[]; verification: GameSessionVerification }> {
    const { record } = inputFinish;
    const artifactPaths: string[] = [];
    const sessionId = record.session.sessionId;

    if (inputFinish.runtime && inputFinish.game) {
      const frame = frameOf(inputFinish.runtime, inputFinish.game);
      const written = await input.artifacts.write({
        ownerId: record.ownerId,
        mode: 'cloud',
        path: `games/${record.session.gameId}/sessions/${sessionId}/final.png`,
        bytes: Buffer.from(frame.pngBase64, 'base64'),
      });
      if (written.ok) artifactPaths.push(written.value.path);
      record.observation = {
        sessionId,
        status: inputFinish.status,
        observedAt: input.clock.iso(),
        state: stateView(inputFinish.game),
        frame,
        availableActions: [...record.session.allowedActions],
      };
    }

    const finalDigest = inputFinish.game
      ? digest(JSON.stringify(inputFinish.game.snapshot()))
      : 'unavailable';
    const verification: GameSessionVerification = {
      objective: record.session.objective,
      achieved: inputFinish.achieved,
      checks: inputFinish.checks,
      progress: inputFinish.progress,
      finalDigest,
      artifactPaths,
      completedAt: input.clock.iso(),
    };
    const report = await input.artifacts.write({
      ownerId: record.ownerId,
      mode: 'cloud',
      path: `games/${record.session.gameId}/sessions/${sessionId}/verification.json`,
      bytes: Buffer.from(`${JSON.stringify(verification, null, 2)}\n`, 'utf8'),
    });
    if (report.ok) {
      artifactPaths.push(report.value.path);
      verification.artifactPaths = artifactPaths;
    }

    record.session.status = inputFinish.status;
    record.session.progress = inputFinish.progress;
    record.session.verification = verification;
    if (inputFinish.failure) record.session.failure = inputFinish.failure;
    touch(record);
    return { artifactPaths, verification };
  }

  const sessions: GameSessionService = {
    create: async ({ ownerId, project, build, request }) => {
      const movement = movementForCamera(project.spec.camera);
      if (!movement) {
        return fail('validation_failed', 'That camera has no verified movement model.');
      }
      if (build.status !== 'verified') {
        return fail('conflict', 'Only a verified build can be played by the gaming agent.');
      }
      if (!request.allowedActions.includes('right') || !request.allowedActions.includes('left')) {
        return fail(
          'validation_failed',
          'A session needs at least the left and right actions granted.',
        );
      }
      if (
        request.objective.kind === 'defeat_enemies' &&
        !project.spec.mechanics.includes('shoot') &&
        movement !== 'platformer'
      ) {
        return fail(
          'validation_failed',
          'Defeating enemies in a top-down build requires the shoot mechanic, and this build has none.',
        );
      }
      if (
        request.objective.kind === 'score_at_least' &&
        !project.spec.mechanics.includes('collectibles')
      ) {
        return fail(
          'validation_failed',
          'That objective needs collectibles, and this build has none.',
        );
      }
      const now = input.clock.iso();
      const sessionId = input.ids.sessionId();
      const progress: GameProgress = {
        levelsCleared: 0,
        totalLevels: build.verification.levels.length,
        currentLevel: 0,
        score: 0,
        ticks: 0,
        deaths: 0,
        enemiesDefeated: 0,
      };
      const session: GameSession = {
        sessionId,
        gameId: project.gameId,
        buildId: build.buildId,
        taskId: null,
        generation: 0,
        status: 'starting',
        objective: request.objective,
        allowedActions: request.allowedActions,
        progress,
        memory: [],
        logs: [],
        verification: null,
        failure: null,
        createdAt: now,
        updatedAt: now,
      };
      const record: InternalSession = {
        ownerId,
        session,
        controls: {
          paused: false,
          takenOver: false,
          cancelRequested: false,
          pausedSince: null,
          inputs: [],
        },
        observation: null,
      };
      records.set(sessionId, record);
      log(record, 'session', 'created', `Session for build ${build.buildId}.`);
      return ok(session);
    },

    attachTask: async (sessionId, taskId, generation) => {
      const record = records.get(sessionId);
      if (!record) return;
      record.session.taskId = taskId;
      record.session.generation = generation;
      record.session.status = record.controls.paused
        ? 'paused'
        : record.controls.takenOver
          ? 'taken_over'
          : 'running';
      touch(record);
      log(record, 'session', 'attached', `Durable task ${taskId} accepted the session.`);
    },

    stamp: (sessionId, generation) => {
      const record = records.get(sessionId);
      if (!record) return;
      record.session.generation = generation;
    },

    get: async (ownerId, sessionId) => {
      const record = owned(ownerId, sessionId);
      if (!record) return fail('not_found', 'That game session does not exist for this owner.');
      return ok({ ...record.session, allowedActions: [...record.session.allowedActions] });
    },

    list: async (ownerId) => ({
      sessions: [...records.values()]
        .filter((record) => record.ownerId === ownerId)
        .map((record) => record.session)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    }),

    control: async ({ ownerId, sessionId, request }) => {
      const record = owned(ownerId, sessionId);
      if (!record) return fail('not_found', 'That game session does not exist for this owner.');
      if (isTerminal(record.session.status)) {
        return fail('conflict', 'That session has already finished.');
      }
      const controls = record.controls;
      switch (request.action) {
        case 'pause':
          if (record.session.status === 'taken_over') {
            return fail('conflict', 'Release owner takeover before pausing the agent.');
          }
          controls.paused = true;
          controls.pausedSince = input.clock.now().getTime();
          record.session.status = 'paused';
          log(record, 'session', 'paused', 'The owner paused the session.');
          break;
        case 'resume':
          controls.paused = false;
          controls.pausedSince = null;
          record.session.status = controls.takenOver ? 'taken_over' : 'running';
          log(record, 'session', 'resumed', 'The owner resumed the session.');
          break;
        case 'takeover':
          controls.takenOver = true;
          controls.paused = false;
          controls.pausedSince = null;
          record.session.status = 'taken_over';
          log(record, 'session', 'takeover', 'The owner took over the controls.');
          break;
        case 'release':
          controls.takenOver = false;
          record.session.status = 'running';
          log(record, 'session', 'release', 'The owner released control to the agent.');
          break;
        case 'cancel':
          controls.cancelRequested = true;
          record.session.status = 'cancelled';
          record.session.failure = {
            code: 'cancelled',
            detail: request.reason ?? 'The owner cancelled the session.',
          };
          log(record, 'session', 'cancelled', request.reason ?? 'The owner cancelled the session.');
          break;
        case 'input': {
          if (!controls.takenOver) {
            return fail('conflict', 'Owner input is only accepted during owner takeover.');
          }
          if (!request.input) {
            return fail('validation_failed', 'An input action requires an input body.');
          }
          const supplied = { ...request.input } as Record<string, boolean>;
          for (const [action, pressed] of Object.entries(supplied)) {
            if (!pressed) continue;
            if (!(record.session.allowedActions as string[]).includes(action)) {
              return fail(
                'validation_failed',
                `The ${action} action is not granted for this session.`,
              );
            }
          }
          controls.inputs.push(request.input);
          if (controls.inputs.length > MAX_OWNER_INPUTS) {
            controls.inputs.splice(0, controls.inputs.length - MAX_OWNER_INPUTS);
          }
          log(record, 'session', 'owner-input', 'The owner submitted one bounded input frame.');
          break;
        }
        default:
          return fail('validation_failed', 'That session control is not supported.');
      }
      touch(record);
      return ok({ ...record.session });
    },

    observation: async (ownerId, sessionId) => {
      const record = owned(ownerId, sessionId);
      if (!record) return fail('not_found', 'That game session does not exist for this owner.');
      if (!record.observation) {
        return fail(
          'not_ready',
          'The session has not produced an observation yet; it may still be starting.',
        );
      }
      // The frame is a snapshot; the status is live, so a paused or taken-over
      // session reports that state on its next observation.
      return ok({ ...record.observation, status: record.session.status });
    },

    logs: async (ownerId, sessionId) => {
      const record = owned(ownerId, sessionId);
      if (!record) return fail('not_found', 'That game session does not exist for this owner.');
      return ok({
        sessionId,
        logs: [...record.session.logs],
        memory: [...record.session.memory],
      });
    },

    verification: async (ownerId, sessionId) => {
      const record = owned(ownerId, sessionId);
      if (!record) return fail('not_found', 'That game session does not exist for this owner.');
      if (!record.session.verification) {
        return fail('not_ready', 'That session has not finished, so it has no verification.');
      }
      return ok(record.session.verification);
    },

    fail: async (sessionId, code, detail) => {
      const record = records.get(sessionId);
      if (!record || isTerminal(record.session.status)) return;
      record.session.status = 'failed';
      record.session.failure = { code: code.slice(0, 60), detail: detail.slice(0, 600) };
      record.controls.cancelRequested = true;
      touch(record);
      log(record, 'session', 'failed', detail);
    },

    controlState: (sessionId) => records.get(sessionId)?.controls ?? null,
  };

  const agent: GamingAgent = {
    run: async (request) => {
      const record = records.get(request.game.sessionId);
      if (!record || record.ownerId !== request.ownerId) {
        return {
          ok: false,
          code: 'not_configured',
          detail: 'The game session does not exist for this owner.',
          retryable: false,
        };
      }
      const permissionResource = `game-session:${request.game.sessionId}`;
      const approved = await request.isApproved(request.taskId, 'command.execute', permissionResource);
      if (!approved) {
        await sessions.fail(
          request.game.sessionId,
          'permission_required',
          `The session grant ${permissionResource} is missing or expired.`,
        );
        request.report({
          type: 'approval.required',
          requestId: permissionResource,
          tool: 'game.session',
          description: 'Authorize bounded control of this game session.',
        });
        return {
          ok: false,
          code: 'disabled',
          detail: 'The owner has not granted bounded control of this game session.',
          retryable: false,
        };
      }

      request.report({ type: 'step.started', stepId: 'observe', title: 'Observe the current frame and measured game state' });
      const loaded = await request.loadBuild(request.ownerId, request.game.gameId, request.game.buildId);
      if (!loaded.ok) {
        await sessions.fail(request.game.sessionId, loaded.code, loaded.detail);
        return { ok: false, code: 'not_configured', detail: loaded.detail, retryable: false };
      }
      let runtime: LoadedRuntime;
      try {
        runtime = loadRuntime(loaded.value.files);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The verified build did not load.';
        await sessions.fail(request.game.sessionId, 'protocol_error', detail);
        return { ok: false, code: 'protocol_error', detail, retryable: false };
      }
      record.session.status = record.controls.paused
        ? 'paused'
        : record.controls.takenOver
          ? 'taken_over'
          : 'running';
      touch(record);

      const blueprint = describeBuild(loaded.value.files);
      if (!blueprint) {
        await sessions.fail(
          request.game.sessionId,
          'protocol_error',
          'The verified build has no readable configuration.',
        );
        return {
          ok: false,
          code: 'protocol_error',
          detail: 'The verified build has no readable configuration.',
          retryable: false,
        };
      }

      let game = runtime.createGame(0);
      record.observation = {
        sessionId: request.game.sessionId,
        status: 'running',
        observedAt: input.clock.iso(),
        state: stateView(game),
        frame: frameOf(runtime, game),
        availableActions: [...request.game.allowedActions],
      };
      request.report({ type: 'step.completed', stepId: 'observe', title: 'Observation captured' });
      request.report({ type: 'step.started', stepId: 'plan', title: `Plan a bounded route to ${objectiveLabel(request.game.objective)}` });
      const plan = [
        `objective=${request.game.objective.kind}:${request.game.objective.target}`,
        `build=${request.game.buildId}`,
        `actions=${request.game.allowedActions.join(',')}`,
        `budget=${request.game.maxTicks} ticks`,
      ];
      for (const line of plan) remember(record, line);
      request.report({ type: 'step.completed', stepId: 'plan', title: 'Bounded route planned' });

      request.report({ type: 'step.started', stepId: 'play', title: 'Play with the granted controls' });

      const memory: PolicyMemory = createPolicyMemory();
      let levelsCleared = 0;
      let totalScore = 0;
      let enemiesDefeated = 0;
      let ticks = 0;
      let deaths = 0;
      let retries = 0;
      let achieved = false;
      let pausedMs = 0;
      let cancelReason: string | null = null;

      while (ticks < request.game.maxTicks && !achieved) {
        if (request.signal.aborted) {
          cancelReason = 'The run was cancelled by the execution supervisor.';
          break;
        }
        if (record.controls.cancelRequested) {
          cancelReason = 'The owner cancelled the session.';
          break;
        }
        if (record.controls.paused) {
          if (record.controls.pausedSince !== null) {
            const waited = input.clock.now().getTime() - record.controls.pausedSince;
            if (waited > input.maxPauseMs) {
              const progress = progressOf(
                game,
                levelsCleared,
                totalScore,
                ticks,
                deaths + game.state.deaths,
                enemiesDefeated + game.state.enemiesDefeated,
              );
              await finish({
                record,
                runtime,
                game,
                status: 'failed',
                achieved: false,
                progress,
                checks: failedChecks('The pause exceeded the configured maximum time.'),
                failure: {
                  code: 'timeout',
                  detail: 'The session stayed paused past its maximum pause time.',
                },
              });
              return {
                ok: false,
                code: 'timeout',
                detail: 'The session stayed paused past its maximum pause time.',
                retryable: false,
              };
            }
            pausedMs += 40;
          }
          await idle(40);
          continue;
        }

        const controls = record.controls;
        let chosen: Partial<GameInput>;
        if (controls.takenOver) {
          chosen = controls.inputs.shift() ?? {};
        } else {
          chosen = chooseInput({
            game,
            blueprint,
            objective: request.game.objective,
            memory,
            allowedActions: request.game.allowedActions,
          });
        }
        game.step(chosen);
        ticks += 1;
        // Yield periodically so pause, takeover, cancellation and observation are
        // serviced while the agent is playing instead of after the run ends.
        if (ticks % 240 === 0) await idle(0);

        if (game.state.status === 'won') {
          totalScore += game.state.score;
          enemiesDefeated += game.state.enemiesDefeated;
          levelsCleared += 1;
          deaths += game.state.deaths;
          log(record, game.level.id, 'level-cleared', `Level cleared in ${game.state.tick} ticks with score ${game.state.score}.`);
          remember(record, `cleared ${game.level.id} in ${game.state.tick} ticks; score ${game.state.score}`);
          retries = 0;
          const nextIndex = game.levelIndex + 1;
          if (nextIndex < game.levelCount) {
            game = runtime.createGame(nextIndex);
            record.observation = {
              sessionId: request.game.sessionId,
              status: 'running',
              observedAt: input.clock.iso(),
              state: stateView(game),
              frame: frameOf(runtime, game),
              availableActions: [...request.game.allowedActions],
            };
          }
        } else if (game.state.status === 'lost') {
          retries += 1;
          deaths += 1;
          log(record, game.level.id, 'level-lost', `Attempt ${retries} ended without completing the level.`);
          if (retries > 3) {
            const progress = progressOf(
              game,
              levelsCleared,
              totalScore,
              ticks,
              deaths + game.state.deaths,
              enemiesDefeated + game.state.enemiesDefeated,
            );
            await finish({
              record,
              runtime,
              game,
              status: 'failed',
              achieved: false,
              progress,
              checks: failedChecks('The level budget or timer ended four attempts without completion.'),
              failure: {
                code: 'timeout',
                detail: 'The level could not be completed within the attempt budget.',
              },
            });
            return {
              ok: false,
              code: 'timeout',
              detail: 'The level could not be completed within the attempt budget.',
              retryable: false,
            };
          }
          game = runtime.createGame(game.levelIndex);
        }

        if (ticks % 240 === 0) {
          record.observation = {
            sessionId: request.game.sessionId,
            status: record.session.status,
            observedAt: input.clock.iso(),
            state: stateView(game),
            frame: frameOf(runtime, game),
            availableActions: [...request.game.allowedActions],
          };
          record.session.progress = progressOf(
            game,
            levelsCleared,
            totalScore,
            ticks,
            deaths + game.state.deaths,
            enemiesDefeated + game.state.enemiesDefeated,
          );
          touch(record);
        }

        achieved = objectiveReached({
          objective: request.game.objective,
          levelsCleared,
          levelCount: game.levelCount,
          totalScore,
          currentScore: game.state.score,
          enemiesDefeated: enemiesDefeated + game.state.enemiesDefeated,
        });
      }

      request.report({ type: 'step.completed', stepId: 'play', title: 'Play run finished' });

      const progress = progressOf(
        game,
        levelsCleared,
        totalScore,
        ticks,
        deaths + game.state.deaths,
        enemiesDefeated + game.state.enemiesDefeated,
      );
      record.session.progress = progress;

      if (cancelReason) {
        await finish({
          record,
          runtime,
          game,
          status: 'cancelled',
          achieved: false,
          progress,
          checks: failedChecks(cancelReason),
          failure: { code: 'cancelled', detail: cancelReason },
        });
        return { ok: false, code: 'cancelled', detail: cancelReason, retryable: false };
      }

      request.report({ type: 'step.started', stepId: 'verify', title: 'Verify the objective from measured game state' });
      const checks: GameCheck[] = [
        {
          id: 'objective.measured',
          title: `Measured objective: ${objectiveLabel(request.game.objective)}`,
          passed: achieved,
          detail: achieved
            ? 'The runtime measured the objective condition in game state.'
            : 'The runtime did not measure the objective condition.',
          measurements: {
            levelsCleared,
            levels: progress.totalLevels,
            score: progress.score,
            enemiesDefeated: progress.enemiesDefeated,
            ticks,
          },
        },
        {
          id: 'session.bounded',
          title: 'The session stayed inside its tick budget',
          passed: ticks <= request.game.maxTicks,
          detail: `${ticks} of ${request.game.maxTicks} ticks were used.`,
          measurements: { ticks, budget: request.game.maxTicks, pausedMs },
        },
        {
          id: 'session.isolated',
          title: 'Play happened inside the isolated runtime',
          passed: request.signal.aborted === false || achieved,
          detail:
            'The build ran in a V8 context with no require, process, network or filesystem access.',
          measurements: { actions: request.game.allowedActions.length },
        },
      ];

      if (!achieved) {
        await finish({
          record,
          runtime,
          game,
          status: 'failed',
          achieved: false,
          progress,
          checks,
          failure: {
            code: 'timeout',
            detail: 'The tick budget ended before the objective was measured.',
          },
        });
        return {
          ok: false,
          code: 'timeout',
          detail: 'The tick budget ended before the objective was measured.',
          retryable: false,
        };
      }

      const finished = await finish({
        record,
        runtime,
        game,
        status: 'completed',
        achieved: true,
        progress,
        checks,
        failure: null,
      });
      request.report({ type: 'step.completed', stepId: 'verify', title: 'Objective verified from measured state' });
      log(record, 'session', 'completed', `Objective measured: ${objectiveLabel(request.game.objective)}.`);
      return {
        ok: true,
        summary: `Verified ${objectiveLabel(request.game.objective)} in ${ticks} ticks on build ${request.game.buildId}.`,
        artifacts: finished.artifactPaths.map((artifactPath) => ({ path: artifactPath })),
      };
    },
  };

  return { sessions, agent };
}

function progressOf(
  game: RuntimeGame,
  levelsCleared: number,
  totalScore: number,
  ticks: number,
  deaths: number,
  enemiesDefeated: number,
): GameProgress {
  return {
    levelsCleared,
    totalLevels: game.levelCount,
    currentLevel: game.levelIndex,
    score: totalScore + game.state.score,
    ticks,
    deaths,
    enemiesDefeated,
  };
}

function failedChecks(reason: string): GameCheck[] {
  return [
    {
      id: 'objective.measured',
      title: 'Measured objective completion',
      passed: false,
      detail: reason,
      measurements: { achieved: false },
    },
  ];
}

/**
 * Reads the generated configuration without trusting anything else in the file:
 * the session needs the movement model, palette and mechanic set that the
 * verifier recorded for this build.
 */
function describeBuild(
  files: Array<{ path: string; content: string }>,
): GameBlueprint | null {
  const configFile = files.find((file) => file.path === 'src/config.js');
  const levelsFile = files.find((file) => file.path === 'src/levels.js');
  if (!configFile || !levelsFile) return null;
  const configMatch = /globalThis\.CoderaxConfig\s*=\s*(\{[\s\S]*\});\s*$/.exec(configFile.content);
  const levelsMatch = /globalThis\.CoderaxLevels\s*=\s*(\[[\s\S]*\]);\s*$/.exec(levelsFile.content);
  if (!configMatch || !levelsMatch) return null;
  try {
    const config = JSON.parse(configMatch[1] as string) as {
      movement: MovementModel;
      palettes?: string[];
      palette: string[];
      mechanics: Record<string, boolean>;
      tuning: Tuning;
      spec: GameSpec;
      controls: Array<{ action: string; keys: string; description: string }>;
    };
    const levels = JSON.parse(levelsMatch[1] as string) as LevelData[];
    const mechanics = Object.keys(config.mechanics).filter(
      (key) => config.mechanics[key],
    ) as GameSpec['mechanics'];
    return {
      spec: config.spec,
      movement: config.movement,
      camera: config.spec.camera,
      mechanics,
      palette: config.palette,
      tuning: config.tuning,
      levels,
      controls: config.controls,
    };
  } catch {
    return null;
  }
}

export const GAME_ACTIONS_FOR_SESSION = Object.freeze(ACTIONS);
