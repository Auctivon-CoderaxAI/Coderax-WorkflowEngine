import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseReleaseManifest } from './manifest.js';
import { collectFacts } from './collect.js';
import { evaluateRelease, renderTable } from './evaluate.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const root = path.resolve(option('--root') ?? process.cwd());
  const online = process.argv.includes('--online');
  const manifest = parseReleaseManifest(readFileSync(path.join(root, 'release', 'train.json'), 'utf8'));
  const facts = await collectFacts({ root, manifest, online });
  const evaluation = evaluateRelease(manifest, facts);
  process.stdout.write(renderTable(evaluation));

  const jsonPath = option('--json');
  if (jsonPath) {
    writeFileSync(
      path.resolve(root, jsonPath),
      `${JSON.stringify(
        {
          schema: 'coderax.release-verification/1',
          train: evaluation.train,
          verdict: evaluation.verdict,
          rows: evaluation.rows,
          blockers: evaluation.blockers,
          facts: evaluation.facts,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (evaluation.verdict !== 'ready') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`release verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
