import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_GENRES, type GameCamera } from '@coderax/contracts';
import { applyInstruction, interpretPrompt, validateBuildableSpec } from '../../src/games/spec.js';
import { bootGeneratedDocument } from '../../src/games/browser.js';
import { generateGame } from '../../src/games/generate.js';
import { verifyGeneration } from '../../src/games/verify.js';

const PLATFORMER =
  'A side-view platformer about a lamplighter relighting beacons across a quiet town before nightfall.';
const PUZZLE =
  'A calm top-down puzzle about routing power through plant-like circuits without overloading them.';
const STRATEGY =
  'A grid-based board strategy game about defending a seed vault through the winter.';
const RPG = 'An isometric role playing quest about a courier hero rebuilding a mountain village.';
const ARCADE = 'A bright top-down arcade game about clearing waves of drones for a high score.';
const ADVENTURE =
  'A top-down adventure about exploring a flooded dungeon to restore its three switches.';

function build(prompt: string, seedOffset = 0) {
  const base = interpretPrompt(prompt);
  const spec = { ...base, seed: (base.seed + seedOffset) % 2_147_483_647 };
  const generation = generateGame({
    spec,
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  const outcome = verifyGeneration({
    spec,
    blueprint: generation.blueprint,
    files: generation.files,
    now: '2026-01-01T00:00:00.000Z',
  });
  return { spec, generation, outcome, checks: outcome.verification.checks };
}

test('a natural-language specification selects a coherent genre, camera and mechanics', () => {
  const platformer = interpretPrompt(PLATFORMER);
  assert.equal(platformer.genre, 'platformer');
  assert.equal(platformer.camera, 'side_view');
  assert.ok(platformer.mechanics.includes('gravity'));
  assert.ok(platformer.mechanics.includes('jump'));

  const puzzle = interpretPrompt(PUZZLE);
  assert.equal(puzzle.genre, 'puzzle');
  assert.equal(puzzle.camera, 'top_down');
  assert.ok(puzzle.mechanics.includes('switches'));

  assert.equal(interpretPrompt(STRATEGY).camera, 'ui_only');
  assert.equal(interpretPrompt(RPG).camera, 'isometric');
  assert.equal(interpretPrompt(ARCADE).genre, 'arcade');
  assert.equal(interpretPrompt(ARCADE).camera, 'top_down');
  assert.equal(interpretPrompt(ADVENTURE).genre, 'adventure');
  assert.equal(interpretPrompt(ADVENTURE).camera, 'top_down');
});

test('unsupported cameras and two-player specs are refused before generation', () => {
  const spec = interpretPrompt(PLATFORMER);
  const camera = validateBuildableSpec({ ...spec, camera: 'first_person' });
  assert.equal(camera.ok, false);
  if (!camera.ok) assert.equal(camera.code, 'unsupported_camera');

  const players = validateBuildableSpec({ ...spec, players: 2 });
  assert.equal(players.ok, false);
  if (!players.ok) assert.equal(players.code, 'unsupported_players');

  assert.equal(validateBuildableSpec(spec).ok, true);
});

test('generation is deterministic and the seed changes the level geometry', () => {
  const base = interpretPrompt(PLATFORMER);
  const first = generateGame({
    spec: base,
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  const second = generateGame({
    spec: base,
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  assert.equal(first.digest, second.digest);
  assert.deepEqual(
    first.files.map((file) => [file.path, file.digest]),
    second.files.map((file) => [file.path, file.digest]),
  );

  const reseeded = generateGame({
    spec: { ...base, seed: (base.seed + 1) % 2_147_483_647 },
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  assert.notEqual(first.digest, reseeded.digest);
  assert.notDeepEqual(first.blueprint.levels, reseeded.blueprint.levels);
});

test('model-assisted narrative changes the design plan but no generated source byte', () => {
  const spec = interpretPrompt(PLATFORMER);
  const deterministic = generateGame({
    spec,
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  const assisted = generateGame({
    spec,
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: true,
    narrative: { logline: 'A narrative supplied by a route.', pillars: ['light'] },
  });

  // Provenance is on the plan...
  assert.equal(deterministic.plan.modelAssisted, false);
  assert.equal(assisted.plan.modelAssisted, true);
  assert.equal(assisted.plan.logline, 'A narrative supplied by a route.');

  // ...while every emitted file, including the manifest and its digests, is
  // byte-identical. Source, levels and audio are never model output.
  assert.equal(assisted.digest, deterministic.digest);
  assert.deepEqual(
    assisted.files.map((file) => [file.path, file.digest, file.bytes]),
    deterministic.files.map((file) => [file.path, file.digest, file.bytes]),
  );
  assert.deepEqual(assisted.blueprint.levels, deterministic.blueprint.levels);
});

test('every supported camera generates a playable, independently verified build', () => {
  const prompts: Array<[string, GameCamera]> = [
    [PLATFORMER, 'side_view'],
    [PUZZLE, 'top_down'],
    [RPG, 'isometric'],
    [STRATEGY, 'ui_only'],
    [ARCADE, 'top_down'],
    [ADVENTURE, 'top_down'],
  ];
  for (const [prompt, camera] of prompts) {
    const { spec, generation, checks } = build(prompt);
    assert.equal(spec.camera, camera);
    assert.ok(generation.files.length >= 3, `${camera} should ship source files`);
    const failed = checks.filter((check) => !check.passed);
    assert.deepEqual(
      failed.map((check) => `${check.id}: ${check.detail}`),
      [],
      `${camera} build must pass every check`,
    );
    assert.ok(checks.some((check) => check.id === 'levels.completable'));
    assert.ok(checks.some((check) => check.id === 'deterministic.replay'));
    assert.ok(checks.some((check) => check.id === 'render.draws'));
  }
});

test('a build with every mechanic verifies each shipped mechanic, not a template', () => {
  const spec = {
    ...interpretPrompt(PLATFORMER),
    mechanics: [
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
    ] as const,
  };
  const generation = generateGame({
    spec: { ...spec, mechanics: [...spec.mechanics] },
    gameId: 'game_unit',
    buildId: 'game_unit-r1-a1',
    modelAssisted: false,
  });
  const outcome = verifyGeneration({
    spec: { ...spec, mechanics: [...spec.mechanics] },
    blueprint: generation.blueprint,
    files: generation.files,
    now: '2026-01-01T00:00:00.000Z',
  });
  const failed = outcome.verification.checks.filter((check) => !check.passed);
  assert.deepEqual(
    failed.map((check) => `${check.id}: ${check.detail}`),
    [],
    'the composed build must pass every mechanic check',
  );
  // Collectibles are measured by the scoring check; every other mechanic has its
  // own check. Each listed mechanic must be covered by a passing measurement.
  const covered = outcome.verification.checks.filter((check) => check.passed).map((check) => check.id);
  for (const mechanic of generation.blueprint.mechanics) {
    const id = mechanic === 'collectibles' ? 'scoring.collect' : `mechanics.${mechanic}`;
    assert.ok(covered.includes(id), `${mechanic} has no passing check (${id})`);
  }
});

test('the playable entry inlines every script and synthesizes its audio', () => {
  const { generation } = build(ARCADE);
  const html = generation.files.find((file) => file.path === 'index.html');
  assert.ok(html);
  const scriptTags = html.content.match(/<script(?:\s[^>]*)?>/gi) ?? [];
  assert.equal(scriptTags.some((tag) => /\bsrc\s*=/.test(tag)), false, 'no script src');
  assert.ok(scriptTags.length >= 6, 'every generated module is inlined');
  assert.match(html.content, /createOscillator/);
  assert.match(html.content, /script-src[^;]*'unsafe-inline'/);
  assert.ok(generation.files.some((file) => file.path === 'src/audio.js'));
  assert.match(
    generation.files.find((file) => file.path === 'manifest.json')?.content ?? '',
    /"audio": "procedural-webaudio"/,
  );
});

test('the generated runtime is self-contained and has no ambient authority', () => {
  const { generation } = build(PUZZLE);
  const scripts = generation.files.filter((file) => file.kind === 'js');
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.equal(/\brequire\s*\(/.test(script.content), false, 'no require');
    assert.equal(/\bprocess\./.test(script.content), false, 'no process');
    assert.equal(/\bfetch\s*\(/.test(script.content), false, 'no network');
    assert.equal(/\bimport\s*\(/.test(script.content), false, 'no dynamic import');
  }
  const html = generation.files.find((file) => file.kind === 'html');
  assert.ok(html);
  assert.match(html.content, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html.content, /<canvas/);
  assert.ok(generation.files.some((file) => file.kind === 'svg'), 'the theme asset is generated SVG');
});

test('verification evidence is rendered from the shipped renderer, not a placeholder', () => {
  const { outcome } = build(PLATFORMER);
  assert.ok(outcome.verification.passed);
  assert.equal(outcome.frames.length, outcome.verification.levels.length);
  for (const frame of outcome.frames) {
    assert.equal(frame.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(frame.png.length > 100);
  }
  const render = outcome.verification.checks.find((check) => check.id === 'render.draws');
  assert.ok(render);
  const colours = Number(render.measurements.distinctColors ?? 0);
  assert.ok(colours >= 4, 'the rendered frame must contain distinct colours');
});

test('every declared genre generates a verified build with its own palette', () => {
  for (const genre of GAME_GENRES) {
    const spec = { ...interpretPrompt(PLATFORMER), genre };
    const generation = generateGame({
      spec,
      gameId: 'game_unit',
      buildId: `game_unit-${genre}-r1-a1`,
      modelAssisted: false,
    });
    const outcome = verifyGeneration({
      spec,
      blueprint: generation.blueprint,
      files: generation.files,
      now: '2026-01-01T00:00:00.000Z',
    });
    const failed = outcome.verification.checks.filter((check) => !check.passed);
    assert.deepEqual(
      failed.map((check) => `${check.id}: ${check.detail}`),
      [],
      `${genre} must generate a verified build`,
    );
    assert.equal(generation.blueprint.spec.genre, genre);
    assert.equal(generation.blueprint.palette.length, 6);
  }
});

test('a corrupted generated script fails verification instead of becoming playable', () => {
  const { spec, generation } = build(PLATFORMER);
  const corrupted = generation.files.map((file) =>
    file.path === 'src/game.js' ? { ...file, content: 'function (' } : file,
  );
  const outcome = verifyGeneration({
    spec,
    blueprint: generation.blueprint,
    files: corrupted,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(outcome.verification.passed, false);
  const parse = outcome.verification.checks.find((check) => check.id === 'code.parse');
  assert.ok(parse);
  assert.equal(parse.passed, false);
});

test('the canvas bitmap follows its CSS box after the HUD wraps on a narrow viewport', () => {
  const { generation } = build(PLATFORMER);
  const html = generation.files.find((file) => file.path === 'index.html');
  assert.ok(html);
  // The harness boots at 320x180, then shrinks the observed box to emulate a
  // HUD that wrapped to a second line, and uses a device scale of 2.
  const boot = bootGeneratedDocument(html.content, { deviceScaleFactor: 2 });
  assert.equal(boot.passed, true, boot.detail);
  assert.equal(boot.bitmapMatchesLayout, true);
  assert.equal(boot.css.height, 162);
  assert.deepEqual(boot.bitmap, { width: 640, height: 324 });
});

test('an edit changes only the stated fields and stays buildable', () => {
  const spec = interpretPrompt(PLATFORMER);
  const edited = applyInstruction(spec, 'make it isometric');
  assert.ok(edited);
  assert.equal(edited.spec.camera, 'isometric');
  assert.equal(edited.spec.mechanics.includes('gravity'), false);
  assert.equal(edited.spec.mechanics.includes('jump'), false);

  // The edited spec is evaluated on its own: a camera change must rebuild cleanly.
  const generation = generateGame({
    spec: edited.spec,
    gameId: 'game_unit',
    buildId: 'game_unit-r2-a1',
    modelAssisted: false,
  });
  const outcome = verifyGeneration({
    spec: edited.spec,
    blueprint: generation.blueprint,
    files: generation.files,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(outcome.verification.passed);

  assert.equal(applyInstruction(spec, 'paint everything mauve'), null);
  const focused = applyInstruction(spec, 'double jump');
  assert.ok(focused);
  assert.ok(focused.spec.mechanics.includes('double_jump'));
});
