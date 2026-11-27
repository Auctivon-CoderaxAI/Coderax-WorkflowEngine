import vm from 'node:vm';
import type { GameInput } from '@coderax/contracts';
import type { LevelData } from './types.js';
import { createRaster, encodePng } from './frame.js';

/**
 * The isolated game runtime.
 *
 * A verified build is plain JavaScript executed in a fresh V8 context with no
 * `require`, no `process`, no network, no filesystem and no code generation from
 * strings. The engine is cloud-hosted, so this is the in-engine isolation
 * boundary; it is not a container, and the capability report says exactly that.
 * Only the studio's own generated sources are ever loaded, and a build's digest
 * must match the stored verified build before a session may start.
 */

export type RuntimeBox = { x: number; y: number; w: number; h: number };

export type RuntimeEvent = { type: string; [key: string]: unknown };

export type RuntimeState = {
  levelIndex: number;
  levelCount: number;
  tick: number;
  status: 'playing' | 'won' | 'lost';
  player: {
    x: number;
    y: number;
    w: number;
    h: number;
    vx: number;
    vy: number;
    onGround: boolean;
    health: number;
    facing: number;
    invulnerable: number;
    jumpsLeft: number;
    jumpHeld: boolean;
    dashFrames: number;
    dashCooldown: number;
    fireCooldown: number;
  };
  solids: Array<RuntimeBox & { kind?: string }>;
  movers: Array<RuntimeBox & { baseX: number; baseY: number }>;
  blocks: RuntimeBox[];
  hazards: RuntimeBox[];
  collectibles: Array<RuntimeBox & { taken: boolean; value: number }>;
  enemies: Array<RuntimeBox & { alive: boolean; minX: number; maxX: number; speed: number }>;
  switches: Array<RuntimeBox & { on: boolean }>;
  projectiles: Array<RuntimeBox & { vx: number; life: number }>;
  goal: RuntimeBox & { locked: boolean };
  score: number;
  collected: number;
  enemiesDefeated: number;
  deaths: number;
  timeLeft: number;
  events: RuntimeEvent[];
};

export type RuntimeGame = {
  state: RuntimeState;
  level: LevelData;
  levelIndex: number;
  levelCount: number;
  step: (input: Partial<GameInput>) => void;
  snapshot: () => RuntimeState;
};

export type RuntimeFiles = Array<{ path: string; content: string }>;

export type LoadedRuntime = {
  createGame: (index: number) => RuntimeGame;
  draw: (game: RuntimeGame, width: number, height: number) => { png: Buffer; distinctColors: number };
  isolated: { require: boolean; process: boolean; fetch: boolean; xhr: boolean };
};

export class RuntimeLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLoadError';
  }
}

const FORBIDDEN_SOURCE = [
  /(^|[^.\w])require\s*\(/,
  /\bprocess\s*\./,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bMath\s*\.\s*random\b/,
  /\bDate\s*\.\s*now\b/,
  /\bperformance\s*\./,
];

/** Static guard: generated rules must be time-free, network-free and pure. */
export function scanGeneratedSource(files: RuntimeFiles): string[] {
  const findings: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.js')) continue;
    for (const pattern of FORBIDDEN_SOURCE) {
      if (pattern.test(file.content)) {
        findings.push(`${file.path} matches ${pattern.source}`);
      }
    }
  }
  return findings;
}

function sourceFor(files: RuntimeFiles, path: string): string {
  const file = files.find((entry) => entry.path === path);
  if (!file) throw new RuntimeLoadError(`the build is missing ${path}`);
  return file.content;
}

export function loadRuntime(files: RuntimeFiles): LoadedRuntime {
  const context = vm.createContext(Object.create(null), {
    name: 'coderax-game-runtime',
    codeGeneration: { strings: false, wasm: false },
  }) as vm.Context;

  const run = (source: string, name: string): void => {
    try {
      vm.runInContext(source, context, { filename: name, timeout: 2_000 });
    } catch (error) {
      throw new RuntimeLoadError(
        `${name} did not load: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  };

  run(sourceFor(files, 'src/config.js'), 'config.js');
  run(sourceFor(files, 'src/levels.js'), 'levels.js');
  run(sourceFor(files, 'src/game.js'), 'game.js');
  run(sourceFor(files, 'src/render.js'), 'render.js');

  const factory = vm.runInContext(
    '(function (index) { return globalThis.CoderaxGame.createGame(index); })',
    context,
    { filename: 'factory.js' },
  ) as (index: number) => RuntimeGame;

  const renderer = vm.runInContext(
    '(function (game, ctx, width, height) { return globalThis.CoderaxRender.draw(ctx, game, width, height); })',
    context,
    { filename: 'renderer.js' },
  ) as (game: RuntimeGame, ctx: unknown, width: number, height: number) => void;

  const isolatedProbe = vm.runInContext(
    '({ require: typeof require, process: typeof process, fetch: typeof fetch, xhr: typeof XMLHttpRequest })',
    context,
    { filename: 'probe.js' },
  ) as {
    require: string;
    process: string;
    fetch: string;
    xhr: string;
  };

  return {
    createGame: (index) => factory(index),
    draw: (game, width, height) => {
      const raster = createRaster({ width, height });
      renderer(game, raster.context, width, height);
      return {
        png: encodePng({ width, height, pixels: raster.pixels }),
        distinctColors: raster.distinctColors(),
      };
    },
    isolated: {
      require: isolatedProbe.require === 'undefined',
      process: isolatedProbe.process === 'undefined',
      fetch: isolatedProbe.fetch === 'undefined',
      xhr: isolatedProbe.xhr === 'undefined',
    },
  };
}

export function parseCounts(state: RuntimeState): {
  collectibles: number;
  enemiesAlive: number;
} {
  return {
    collectibles: state.collectibles.length,
    enemiesAlive: state.enemies.filter((enemy) => enemy.alive).length,
  };
}
