import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readRepoText, repoRoot, report, type Finding, type Report } from './files.js';

/**
 * Gate-coverage manifest.
 *
 * A suite that exists but is not run is worse than no suite: it reports green
 * while proving nothing. The acceptance workflow runs one explicit directory per
 * layer, so a test placed outside those directories would be silently skipped by
 * CI even though the local `verify` glob picks it up. This gate keeps the two
 * lists aligned: every compiled test belongs to exactly one executed layer, and
 * every named `*.check.js` live suite is referenced by a package script.
 */

/** Layers the workflow runs explicitly, as directories under dist/tests. */
const LAYERS = [
  'unit',
  'contract',
  'integration',
  'security',
  'adversarial',
  'architecture',
  'e2e',
] as const;

/** A live check is not `*.test.js` so the default suite cannot silently skip it. */
const LIVE = ['integration/mongo-live.check.js'] as const;

function compiledTests(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.check.js')) {
        found.push(full);
      }
    }
  };
  const tests = path.join(repoRoot(), 'dist', 'tests');
  try {
    walk(tests);
  } catch {
    return [];
  }
  return found.sort();
}

function scripts(): string {
  const manifest = JSON.parse(readRepoText('package.json')) as {
    scripts?: Record<string, string>;
  };
  return Object.values(manifest.scripts ?? {}).join('\n');
}

export function checkCoverage(): Report {
  const findings: Finding[] = [];
  const tests = compiledTests();
  if (tests.length === 0) {
    return report([
      {
        rule: 'coverage-build',
        detail: 'dist/tests is missing or empty; run "npm run build" before the gate',
      },
    ]);
  }

  const byLayer = new Map<string, string[]>();
  for (const file of tests) {
    const relative = path.relative(path.join(repoRoot(), 'dist', 'tests'), file).split(path.sep).join('/');
    if (relative.endsWith('.check.js')) {
      if (!(LIVE as readonly string[]).includes(relative)) {
        findings.push({
          rule: 'coverage-unknown-live-check',
          detail: `${relative} is a live check without a manifest entry; add it to LIVE and to a package script`,
        });
      }
      continue;
    }
    const layer = relative.split('/')[0] ?? '';
    if (!(LAYERS as readonly string[]).includes(layer)) {
      findings.push({
        rule: 'coverage-unassigned-test',
        detail: `${relative} is outside the executed layers (${LAYERS.join(', ')})`,
      });
      continue;
    }
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), relative]);
  }

  for (const layer of LAYERS) {
    if ((byLayer.get(layer) ?? []).length === 0) {
      findings.push({
        rule: 'coverage-empty-layer',
        detail: `no compiled test exists under dist/tests/${layer}; remove the CI step or add the suite`,
      });
    }
  }

  const scriptText = scripts();
  for (const live of LIVE) {
    const name = path.posix.basename(live);
    if (!scriptText.includes(name)) {
      findings.push({
        rule: 'coverage-unreferenced-live-check',
        detail: `${live} is not referenced by any package script`,
      });
    }
  }

  return report(findings);
}
