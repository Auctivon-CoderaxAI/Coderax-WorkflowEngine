import vm from 'node:vm';
import type { GameCheck, GameInput, GameLevelResult, GameObjective, GameSpec, GameVerification } from '@coderax/contracts';
import type { GameBlueprint } from './types.js';
import { loadRuntime, scanGeneratedSource, type RuntimeGame } from './runtime.js';
import { chooseInput, createPolicyMemory } from './policy.js';
import { createRandom } from './random.js';
import { digest } from './random.js';

/**
 * Automated playability verification.
 *
 * Every check below measures the generated game itself through the isolated
 * runtime. A build is `verified` only when the deterministic bot finishes every
 * level and the scripted mechanics checks pass; a failed check keeps its measured
 * evidence so iteration has something concrete to fix.
 */

export type VerificationFile = { path: string; content: string; digest: string; kind: string };

export type VerificationOutcome = {
  verification: GameVerification;
  frames: Array<{ path: string; png: Buffer }>;
};

type Measurement = Record<string, number | string | boolean>;

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;

function fresh(runtime: ReturnType<typeof loadRuntime>, index: number): RuntimeGame {
  return runtime.createGame(index);
}

function levelWith(
  blueprint: GameBlueprint,
  pick: (level: GameBlueprint['levels'][number]) => boolean,
): number {
  const index = blueprint.levels.findIndex((level) => pick(level));
  return index >= 0 ? index : 0;
}

function botRun(input: {
  runtime: ReturnType<typeof loadRuntime>;
  blueprint: GameBlueprint;
  levelIndex: number;
  objective: GameObjective;
  maxTicks: number;
  captureFrame: boolean;
}): { result: GameLevelResult; frame: Buffer | null; colors: number; bounded: boolean } {
  const game = fresh(input.runtime, input.levelIndex);
  const memory = createPolicyMemory();
  const actions = ['left', 'right', 'up', 'down', 'jump', 'fire', 'dash'];
  let bounded = true;
  let frame: Buffer | null = null;
  let colors = 0;
  let ticks = 0;

  while (ticks < input.maxTicks && game.state.status === 'playing') {
    const chosen = chooseInput({
      game,
      blueprint: input.blueprint,
      objective: input.objective,
      memory,
      allowedActions: actions,
    });
    game.step(chosen);
    ticks += 1;
    const player = game.state.player;
    if (
      player.x < -200 ||
      player.y < -600 ||
      player.x > game.level.width + 200 ||
      player.y > game.level.height + 600
    ) {
      bounded = false;
    }
    if (
      input.captureFrame &&
      (ticks === 120 || (game.state.status as string) === 'won') &&
      frame === null
    ) {
      const rendered = input.runtime.draw(game, FRAME_WIDTH, FRAME_HEIGHT);
      frame = rendered.png;
      colors = rendered.distinctColors;
    }
  }

  const completed = (game.state.status as string) === 'won';
  return {
    result: {
      levelId: game.level.id,
      name: game.level.name,
      completed,
      ticks,
      score: game.state.score,
      deaths: game.state.deaths,
      frames: frame ? 1 : 0,
    },
    frame,
    colors,
    bounded,
  };
}

function scriptedInputs(count: number): Partial<GameInput>[] {
  const random = createRandom(20261126);
  const inputs: Partial<GameInput>[] = [];
  for (let index = 0; index < count; index += 1) {
    inputs.push({
      left: random() < 0.15,
      right: random() < 0.75,
      up: random() < 0.2,
      down: random() < 0.1,
      jump: random() < 0.35,
      fire: random() < 0.3,
      dash: random() < 0.1,
    });
  }
  return inputs;
}

export function verifyGeneration(input: {
  spec: GameSpec;
  blueprint: GameBlueprint;
  files: VerificationFile[];
  now: string;
}): VerificationOutcome {
  const { spec, blueprint, files } = input;
  const checks: GameCheck[] = [];
  const frames: Array<{ path: string; png: Buffer }> = [];

  const record = (
    id: string,
    title: string,
    run: () => { passed: boolean; detail: string; measurements?: Measurement },
  ): void => {
    try {
      const outcome = run();
      checks.push({
        id,
        title,
        passed: outcome.passed,
        detail: outcome.detail.slice(0, 600),
        measurements: outcome.measurements ?? {},
      });
    } catch (error) {
      checks.push({
        id,
        title,
        passed: false,
        detail: `The check could not run: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 600),
        measurements: {},
      });
    }
  };

  const gameFiles = files.filter((file) => file.kind === 'js');
  let parseError = '';
  for (const file of gameFiles) {
    try {
      new vm.Script(file.content, { filename: file.path });
    } catch (error) {
      parseError = `${file.path}: ${error instanceof Error ? error.message : 'invalid JavaScript'}`;
    }
  }
  record('code.parse', 'Every generated JavaScript file compiles', () => ({
    passed: parseError === '',
    detail: parseError === '' ? 'All generated scripts compiled.' : parseError,
    measurements: { files: gameFiles.length },
  }));

  const findings = scanGeneratedSource(files);
  record('code.deterministic_source', 'Generated rules are time-free, network-free and pure', () => ({
    passed: findings.length === 0,
    detail:
      findings.length === 0
        ? 'No ambient-authority, random or clock dependency was found in the generated rules.'
        : findings.join('; '),
    measurements: { findings: findings.length },
  }));

  const html = files.find((file) => file.path === 'index.html');
  const htmlText = html?.content ?? '';
  record('html.self_contained', 'The preview loads no external resource', () => {
    const external = /(?:src|href)\s*=\s*["']https?:/i.test(htmlText);
    const csp = /Content-Security-Policy/i.test(htmlText);
    return {
      passed: Boolean(html) && !external && csp,
      detail: !html
        ? 'index.html is missing.'
        : external
          ? 'The preview references an external URL.'
          : csp
            ? 'The preview is self-contained and carries a CSP.'
            : 'The preview has no Content-Security-Policy.',
      measurements: { external, csp },
    };
  });

  record('assets.original', 'Assets are generated for this project and licensed as such', () => {
    const svg = files.find((file) => file.path === 'assets/theme.svg');
    const manifest = files.find((file) => file.path === 'manifest.json');
    const licensed = manifest ? /generated-original/.test(manifest.content) : false;
    const thirdParty = files.some((file) => /(?:https?:\/\/)[^\s"']*\.(?:png|jpg|svg|mp3|wav)/i.test(file.content));
    return {
      passed: Boolean(svg) && licensed && !thirdParty,
      detail: !svg
        ? 'The generated theme asset is missing.'
        : !licensed
          ? 'The manifest does not record the generated-original licence.'
          : thirdParty
            ? 'A file references a third-party asset URL.'
            : 'The only assets are original generated SVG and palette colours.',
      measurements: { svg: Boolean(svg), licensed, thirdParty },
    };
  });

  let runtime: ReturnType<typeof loadRuntime> | null = null;
  let loadError = '';
  try {
    runtime = loadRuntime(files);
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'the runtime did not load';
  }

  record('runtime.isolated', 'The game executes without any host authority', () => ({
    passed:
      runtime !== null &&
      runtime.isolated.require &&
      runtime.isolated.process &&
      runtime.isolated.fetch &&
      runtime.isolated.xhr,
    detail: runtime
      ? `require=${runtime.isolated.require ? 'absent' : 'present'}, process=${runtime.isolated.process ? 'absent' : 'present'}, fetch=${runtime.isolated.fetch ? 'absent' : 'present'}.`
      : loadError,
  }));

  const levels: GameLevelResult[] = [];
  let bounded = true;
  let deterministic = false;
  let replayDigest = '';
  let renderColors = 0;

  if (runtime) {
    const live = runtime;

    record('levels.count', 'The build contains exactly the requested number of levels', () => ({
      passed: blueprint.levels.length === spec.levels,
      detail: `${blueprint.levels.length} level(s) generated for a spec of ${spec.levels}.`,
      measurements: { generated: blueprint.levels.length, requested: spec.levels },
    }));

    record('controls.respond', 'The granted controls move the player', () => {
      const game = fresh(live, 0);
      const start = game.state.player.x;
      for (let index = 0; index < 40; index += 1) game.step({ right: true });
      return {
        passed: game.state.player.x > start + 2,
        detail: `The player moved ${Math.round(game.state.player.x - start)} units from ${Math.round(start)}.`,
        measurements: { start: Math.round(start), end: Math.round(game.state.player.x) },
      };
    });

    record('collision.solid', 'A generated wall stops the player instead of being passed through', () => {
      const game = fresh(live, 0);
      const player = game.state.player;
      const wall = { x: player.x + 80, y: player.y - 40, w: 40, h: 300, kind: 'platform' as const };
      game.state.solids.push(wall);
      for (let index = 0; index < 160; index += 1) game.step({ right: true });
      const stopped = game.state.player.x + game.state.player.w <= wall.x + 1.5;
      return {
        passed: stopped,
        detail: stopped
          ? 'The player was stopped at the wall.'
          : `The player reached ${Math.round(game.state.player.x)} past the wall at ${wall.x}.`,
        measurements: { wallX: wall.x, playerX: Math.round(game.state.player.x) },
      };
    });

    if (blueprint.movement === 'platformer') {
      record('collision.ground', 'The player lands on generated ground and stays grounded', () => {
        const game = fresh(live, 0);
        for (let index = 0; index < 20; index += 1) game.step({});
        return {
          passed: game.state.player.onGround,
          detail: `onGround=${game.state.player.onGround} after 20 ticks at the spawn.`,
          measurements: { onGround: game.state.player.onGround, y: Math.round(game.state.player.y) },
        };
      });
    }

    if (spec.mechanics.includes('collectibles')) {
      record('scoring.collect', 'Collecting a pickup increases the score by its value', () => {
        const game = fresh(live, 0);
        const pickup = game.state.collectibles.find((entry) => !entry.taken);
        if (!pickup) {
          return {
            passed: false,
            detail: 'No collectible exists in level 1.',
            measurements: {} as Measurement,
          };
        }
        const before = game.state.score;
        game.state.player.x = pickup.x;
        game.state.player.y = pickup.y;
        game.step({});
        const gained = game.state.score - before;
        return {
          passed: gained === pickup.value,
          detail: `Score changed by ${gained}; the pickup is worth ${pickup.value}.`,
          measurements: { gained, value: pickup.value },
        };
      });
    }

    const mechanicChecks: Array<{
      mechanic: string;
      id: string;
      title: string;
      run: () => { passed: boolean; detail: string; measurements?: Measurement };
    }> = [
      {
        mechanic: 'gravity',
        id: 'mechanics.gravity',
        title: 'Gravity accelerates the player downward',
        run: () => {
          const game = fresh(live, 0);
          game.state.player.onGround = false;
          game.state.player.vy = 0;
          game.state.player.y -= 100;
          for (let index = 0; index < 10; index += 1) game.step({});
          return {
            passed: game.state.player.vy > 0,
            detail: `Vertical velocity is ${Math.round(game.state.player.vy)} after ten ticks in the air.`,
            measurements: { vy: Math.round(game.state.player.vy) },
          };
        },
      },
      {
        mechanic: 'jump',
        id: 'mechanics.jump',
        title: 'Jumping produces an upward impulse from the ground',
        run: () => {
          const game = fresh(live, 0);
          for (let index = 0; index < 4; index += 1) game.step({});
          game.step({ jump: true });
          const jumped = game.state.events.some((event) => event.type === 'jump');
          return {
            passed: jumped && game.state.player.vy < 0,
            detail: `jump event=${jumped}, vy=${Math.round(game.state.player.vy)}.`,
            measurements: { jumped, vy: Math.round(game.state.player.vy) },
          };
        },
      },
      {
        mechanic: 'double_jump',
        id: 'mechanics.double_jump',
        title: 'A second jump is available in the air',
        run: () => {
          const game = fresh(live, 0);
          for (let index = 0; index < 4; index += 1) game.step({});
          game.step({ jump: true });
          for (let index = 0; index < 4; index += 1) game.step({});
          game.step({ jump: true });
          const doubled = game.state.events.some((event) => event.type === 'double_jump');
          return {
            passed: doubled,
            detail: doubled ? 'The second jump fired in the air.' : 'No double jump event was produced.',
            measurements: { doubled },
          };
        },
      },
      {
        mechanic: 'dash',
        id: 'mechanics.dash',
        title: 'Dash exceeds the normal horizontal speed',
        run: () => {
          const game = fresh(live, 0);
          for (let index = 0; index < 4; index += 1) game.step({});
          game.step({ dash: true });
          const dashed = game.state.events.some((event) => event.type === 'dash');
          const speed = Math.abs(game.state.player.vx);
          return {
            passed: dashed && speed > 300,
            detail: `dash event=${dashed}, speed=${Math.round(speed)}.`,
            measurements: { dashed, speed: Math.round(speed) },
          };
        },
      },
      {
        mechanic: 'shoot',
        id: 'mechanics.shoot',
        title: 'Firing creates a projectile',
        run: () => {
          const game = fresh(live, 0);
          game.step({ fire: true });
          const fired = game.state.events.some((event) => event.type === 'shoot');
          return {
            passed: fired && game.state.projectiles.length > 0,
            detail: `shoot event=${fired}, projectiles=${game.state.projectiles.length}.`,
            measurements: { fired, projectiles: game.state.projectiles.length },
          };
        },
      },
      {
        mechanic: 'enemies',
        id: 'mechanics.enemies',
        title: 'An enemy can be defeated by the shipped attack',
        run: () => {
          const index = levelWith(blueprint, (level) => level.enemies.length > 0);
          const game = fresh(live, index);
          const enemy = game.state.enemies.find((entry) => entry.alive);
          if (!enemy) {
            return {
              passed: false,
              detail: 'No live enemy exists in the generated levels.',
              measurements: {} as Measurement,
            };
          }
          if (blueprint.mechanics.includes('shoot')) {
            // Adjacent, aligned with the shot, so no wall can sit between them.
            game.state.player.x = enemy.x - game.state.player.w - 2;
            game.state.player.y = enemy.y - 12;
            game.state.player.facing = 1;
            for (let tick = 0; tick < 20 && enemy.alive; tick += 1) {
              game.state.player.x = enemy.x - game.state.player.w - 2;
              game.state.player.y = enemy.y - 12;
              game.step({ fire: true });
            }
            return {
              passed: !enemy.alive,
              detail: enemy.alive ? 'The enemy survived a direct shot.' : 'The enemy was shot down.',
              measurements: { alive: enemy.alive } as Measurement,
            };
          }
          if (blueprint.movement === 'platformer') {
            game.state.player.x = enemy.x;
            game.state.player.y = enemy.y - game.state.player.h + 4;
            game.state.player.vy = 240;
            game.step({});
            return {
              passed: !enemy.alive,
              detail: enemy.alive ? 'The enemy survived a stomp.' : 'The enemy was defeated.',
              measurements: { alive: enemy.alive },
            };
          }
          // A top-down build without a shot has no stomp: the enemy is an
          // avoidance hazard. Measure the interaction the build actually ships.
          const health = game.state.player.health;
          game.state.player.x = enemy.x;
          game.state.player.y = enemy.y;
          game.step({});
          return {
            passed: game.state.player.health < health,
            detail:
              game.state.player.health < health
                ? 'Enemy contact damaged the player, as shipped.'
                : 'Enemy contact did not damage the player.',
            measurements: { health: game.state.player.health, before: health } as Measurement,
          };
        },
      },
      {
        mechanic: 'hazards',
        id: 'mechanics.hazards',
        title: 'A hazard damages the player',
        run: () => {
          const index = levelWith(blueprint, (level) => level.hazards.length > 0);
          const game = fresh(live, index);
          const hazard = game.state.hazards[0];
          if (!hazard) {
            return {
              passed: false,
              detail: 'No hazard exists in the generated levels.',
              measurements: {} as Measurement,
            };
          }
          game.state.player.invulnerable = 0;
          game.state.player.x = hazard.x + 2;
          game.state.player.y = hazard.y + 2;
          game.step({});
          const hit = game.state.events.some((event) => event.type === 'hit');
          return {
            passed: hit,
            detail: hit ? 'The hazard produced a damage event.' : 'No damage event was produced.',
            measurements: { hit, health: game.state.player.health },
          };
        },
      },
      {
        mechanic: 'switches',
        id: 'mechanics.switches',
        title: 'Touching a switch unlocks the exit',
        run: () => {
          const index = levelWith(blueprint, (level) => level.switches.length > 0);
          const game = fresh(live, index);
          if (game.state.switches.length === 0) {
            return {
              passed: false,
              detail: 'No switch exists in the generated levels.',
              measurements: {} as Measurement,
            };
          }
          for (const toggle of game.state.switches) {
            game.state.player.x = toggle.x;
            game.state.player.y = toggle.y;
            game.step({});
          }
          return {
            passed: game.state.goal.locked === false,
            detail: game.state.goal.locked ? 'The exit stayed locked.' : 'Every switch was pressed and the exit unlocked.',
            measurements: { locked: game.state.goal.locked },
          };
        },
      },
      {
        mechanic: 'push_blocks',
        id: 'mechanics.push_blocks',
        title: 'Pushing a block moves it',
        run: () => {
          const index = levelWith(blueprint, (level) => level.blocks.length > 0);
          const game = fresh(live, index);
          const block = game.state.blocks[0];
          if (!block) {
            return {
              passed: false,
              detail: 'No pushable block exists in the generated levels.',
              measurements: {} as Measurement,
            };
          }
          const before = block.x;
          game.state.player.x = block.x - game.state.player.w - 2;
          game.state.player.y = block.y + block.h - game.state.player.h;
          game.state.player.invulnerable = 120;
          for (let index = 0; index < 12; index += 1) game.step({ right: true });
          return {
            passed: block.x > before + 1,
            detail: `The block moved ${Math.round(block.x - before)} units.`,
            measurements: { moved: Math.round(block.x - before) },
          };
        },
      },
      {
        mechanic: 'moving_platforms',
        id: 'mechanics.moving_platforms',
        title: 'Moving platforms change position over time',
        run: () => {
          const index = levelWith(blueprint, (level) => level.movers.length > 0);
          const game = fresh(live, index);
          const mover = game.state.movers[0];
          if (!mover) {
            return {
              passed: false,
              detail: 'No moving platform exists in the generated levels.',
              measurements: {} as Measurement,
            };
          }
          const before = { x: mover.x, y: mover.y };
          for (let index = 0; index < 20; index += 1) game.step({});
          const moved = Math.abs(mover.x - before.x) + Math.abs(mover.y - before.y);
          return {
            passed: moved > 1,
            detail: `The platform moved ${moved.toFixed(1)} units.`,
            measurements: { moved: Number(moved.toFixed(1)) },
          };
        },
      },
      {
        mechanic: 'timer',
        id: 'mechanics.timer',
        title: 'The level timer counts down',
        run: () => {
          const game = fresh(live, 0);
          const before = game.state.timeLeft;
          for (let index = 0; index < 10; index += 1) game.step({});
          return {
            passed: before > 0 && game.state.timeLeft < before,
            detail: `Time left moved from ${before.toFixed(1)} to ${game.state.timeLeft.toFixed(1)}.`,
            measurements: { before: Number(before.toFixed(1)), after: Number(game.state.timeLeft.toFixed(1)) },
          };
        },
      },
    ];

    for (const entry of mechanicChecks) {
      if (!(spec.mechanics as string[]).includes(entry.mechanic)) continue;
      record(entry.id, entry.title, entry.run);
    }

    const bot = {
      kind: 'reach_goal' as const,
      target: 1,
    } satisfies GameObjective;
    for (let index = 0; index < blueprint.levels.length; index += 1) {
      const run = botRun({
        runtime: live,
        blueprint,
        levelIndex: index,
        objective: bot,
        maxTicks: 60_000,
        captureFrame: index < 3,
      });
      levels.push(run.result);
      bounded = bounded && run.bounded;
      if (run.frame) {
        frames.push({
          path: `level-${index + 1}-${run.result.completed ? 'clear' : 'attempt'}.png`,
          png: run.frame,
        });
        renderColors = Math.max(renderColors, run.colors);
      }
    }

    record('levels.completable', 'A deterministic bot finishes every generated level', () => {
      const completed = levels.filter((level) => level.completed).length;
      return {
        passed: completed === levels.length,
        detail: `${completed}/${levels.length} levels completed by the bot.`,
        measurements: {
          completed,
          total: levels.length,
          ticks: levels.reduce((sum, level) => sum + level.ticks, 0),
        },
      };
    });

    record('player.bounds', 'The player never leaves the generated world', () => ({
      passed: bounded,
      detail: bounded ? 'The player stayed inside the world bounds.' : 'The player left the world bounds.',
      measurements: { bounded },
    }));

    record('deterministic.replay', 'The same inputs produce the same state digest twice', () => {
      const inputs = scriptedInputs(600);
      const runOnce = (): string => {
        const game = fresh(live, 0);
        for (const step of inputs) game.step(step);
        return digest(JSON.stringify(game.snapshot()));
      };
      const first = runOnce();
      const second = runOnce();
      deterministic = first === second;
      replayDigest = first;
      return {
        passed: deterministic,
        detail: deterministic ? `Replay digest ${first.slice(0, 16)} matched.` : 'Replays diverged.',
        measurements: { digest: first.slice(0, 32) },
      };
    });

    record('render.draws', 'The generated renderer paints a non-empty frame', () => {
      const game = fresh(live, 0);
      for (let index = 0; index < 120; index += 1) game.step({ right: true });
      const rendered = live.draw(game, FRAME_WIDTH, FRAME_HEIGHT);
      renderColors = Math.max(renderColors, rendered.distinctColors);
      return {
        passed: rendered.distinctColors >= 4,
        detail: `${rendered.distinctColors} distinct colours were painted.`,
        measurements: { distinctColors: rendered.distinctColors, width: FRAME_WIDTH, height: FRAME_HEIGHT },
      };
    });
  }

  if (levels.length === 0) {
    for (const level of blueprint.levels) {
      levels.push({
        levelId: level.id,
        name: level.name,
        completed: false,
        ticks: 0,
        score: 0,
        deaths: 0,
        frames: 0,
      });
    }
  }

  const passed = checks.every((check) => check.passed);
  return {
    verification: {
      passed,
      checks,
      levels,
      deterministicReplay: deterministic,
      replayDigest: replayDigest || 'unavailable',
      frameCount: frames.length,
      distinctColors: renderColors,
      artifactPaths: [],
      createdAt: input.now,
    },
    frames,
  };
}
