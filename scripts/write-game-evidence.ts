import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { interpretPrompt } from '../src/games/spec.js';
import { generateGame } from '../src/games/generate.js';
import { verifyGeneration } from '../src/games/verify.js';

/**
 * Writes the static playability evidence used by the docs and the PR.
 *
 * The PNGs are rendered by the generated game's own renderer through the
 * verification harness, and the checks are the same measurements the API
 * reports. Nothing here is drawn by hand or copied from a template.
 */

const outDir = path.join(process.cwd(), 'docs', 'evidence', 'game-studio');
mkdirSync(outDir, { recursive: true });

const cases = [
  {
    id: 'platformer',
    title: 'Lamplighter',
    prompt:
      'A side-view platformer about a lamplighter relighting beacons across a quiet town before nightfall.',
  },
  {
    id: 'puzzle',
    title: 'Circuits',
    prompt:
      'A calm top-down puzzle about routing power through plant-like circuits without overloading them.',
  },
] as const;

const summary: Array<Record<string, unknown>> = [];

for (const entry of cases) {
  const spec = interpretPrompt(entry.prompt);
  const gameId = `game_evidence_${entry.id}`;
  const generation = generateGame({
    spec,
    gameId,
    buildId: `${gameId}-r1-a1`,
    modelAssisted: false,
  });
  const outcome = verifyGeneration({
    spec,
    blueprint: generation.blueprint,
    files: generation.files,
    now: new Date().toISOString(),
  });

  const frames = outcome.frames.map((frame, index) => {
    const filename = `${entry.id}-level${index + 1}.png`;
    writeFileSync(path.join(outDir, filename), frame.png);
    return filename;
  });

  summary.push({
    id: entry.id,
    title: entry.title,
    prompt: entry.prompt,
    genre: spec.genre,
    camera: spec.camera,
    movement: generation.blueprint.movement,
    mechanics: generation.blueprint.mechanics,
    levels: generation.blueprint.levels.length,
    buildDigest: generation.digest,
    verified: outcome.verification.passed,
    checks: outcome.verification.checks.map((check) => ({
      id: check.id,
      passed: check.passed,
      detail: check.detail,
      measurements: check.measurements,
    })),
    levelResults: outcome.verification.levels,
    frames,
  });

  process.stdout.write(
    `${entry.id}: verified=${outcome.verification.passed} checks=${outcome.verification.checks.length} frames=${frames.join(',')}\n`,
  );
}

writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
