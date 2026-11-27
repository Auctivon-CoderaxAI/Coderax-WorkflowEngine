import type { GameDesignPlan, GameSpec } from '@coderax/contracts';
import { digest } from './random.js';
import { controlsFor, buildDesignPlan } from './plan.js';
import { generateLevels } from './level.js';
import { paletteFor } from './spec.js';
import {
  AUDIO_SOURCE,
  configSource,
  GAME_SOURCE,
  htmlSource,
  levelsSource,
  MAIN_SOURCE,
  readmeSource,
  RENDER_SOURCE,
  themeSvg,
  type GeneratedSourceFile,
} from './templates.js';
import { DEFAULT_TUNING, movementForCamera, type GameBlueprint } from './types.js';

/**
 * Turns a spec into an original, playable, browser-ready project.
 *
 * The output is composed from the spec (palette, mechanics, level geometry,
 * tuning) and the levels themselves. There is no fixed gallery of canvas
 * templates: two movement models, four verified cameras, twelve composable
 * mechanics and a seeded geometry generator produce a distinct project per spec.
 */

export const GENERATOR_VERSION = '1.0.0';

export type GeneratedFile = {
  path: string;
  kind: GeneratedSourceFile['kind'];
  content: string;
  digest: string;
  bytes: number;
};

export type Generation = {
  blueprint: GameBlueprint;
  plan: GameDesignPlan;
  files: GeneratedFile[];
  digest: string;
  entry: string;
  specDigest: string;
};

export function generateGame(input: {
  spec: GameSpec;
  gameId: string;
  buildId: string;
  modelAssisted: boolean;
  narrative?: { logline?: string; pillars?: string[] };
}): Generation {
  const movement = movementForCamera(input.spec.camera);
  if (!movement) {
    throw new Error(`camera ${input.spec.camera} has no movement model`);
  }
  const palette = paletteFor(input.spec.genre, input.spec.seed);
  const levels = generateLevels(input.spec);
  const controls = controlsFor(input.spec);

  const blueprint: GameBlueprint = {
    spec: input.spec,
    movement,
    camera: input.spec.camera,
    mechanics: [...input.spec.mechanics],
    tuning: { ...DEFAULT_TUNING },
    palette,
    levels,
    controls,
  };

  const plan = buildDesignPlan({
    spec: input.spec,
    blueprint,
    modelAssisted: input.modelAssisted,
    ...(input.narrative ? { narrative: input.narrative } : {}),
  });

  const config = configSource(blueprint);
  const levelsJs = levelsSource(blueprint);
  const entry = htmlSource(blueprint, input.spec, {
    config,
    levels: levelsJs,
    game: GAME_SOURCE,
    render: RENDER_SOURCE,
    audio: AUDIO_SOURCE,
    main: MAIN_SOURCE,
  });

  const sources: GeneratedSourceFile[] = [
    { path: 'index.html', kind: 'html', content: entry },
    { path: 'src/config.js', kind: 'js', content: config },
    { path: 'src/levels.js', kind: 'js', content: levelsJs },
    { path: 'src/game.js', kind: 'js', content: GAME_SOURCE },
    { path: 'src/render.js', kind: 'js', content: RENDER_SOURCE },
    { path: 'src/audio.js', kind: 'js', content: AUDIO_SOURCE },
    { path: 'src/main.js', kind: 'js', content: MAIN_SOURCE },
    { path: 'assets/theme.svg', kind: 'svg', content: themeSvg(blueprint) },
    { path: 'README.md', kind: 'md', content: readmeSource(blueprint, input.spec, input.buildId) },
  ];

  const described = sources.map((file) => ({
    path: file.path,
    kind: file.kind,
    bytes: Buffer.byteLength(file.content),
    digest: digest(file.content),
  }));

  const manifest = {
    tool: 'coderax-native-game-studio',
    generatorVersion: GENERATOR_VERSION,
    buildId: input.buildId,
    specDigest: digest(JSON.stringify(input.spec)),
    camera: input.spec.camera,
    movement,
    mechanics: blueprint.mechanics,
    levels: blueprint.levels.length,
    entry: 'index.html',
    previewPath: `/v1/games/${input.gameId}/preview`,
    license: 'generated-original',
    audio: 'procedural-webaudio',
    thirdPartyAssets: [] as string[],
    files: described,
  };
  sources.push({
    path: 'manifest.json',
    kind: 'json',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  const files: GeneratedFile[] = sources.map((file) => ({
    path: file.path,
    kind: file.kind,
    content: file.content,
    digest: digest(file.content),
    bytes: Buffer.byteLength(file.content),
  }));

  const buildDigest = digest(
    files
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.path}:${file.digest}`)
      .join('\n'),
  );

  return {
    blueprint,
    plan,
    files,
    digest: buildDigest,
    entry: 'index.html',
    specDigest: manifest.specDigest,
  };
}
