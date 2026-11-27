import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The permanent quality-gate manifest.
 *
 * Every compiled test file must belong to exactly one gate (the `coverage`
 * check enforces it), so adding a suite without assigning it to the gate cannot
 * silently leave it unrun. Command gates cover the checks that are not tests:
 * OpenAPI drift and the dependency audit.
 */

export type Gate = {
  id: string;
  title: string;
  directory?: string;
  command?: string;
  /** A real external dependency is required; never satisfied by a fake. */
  live?: boolean;
};

export const GATES: readonly Gate[] = Object.freeze([
  { id: 'unit', title: 'Unit tests', directory: 'dist/tests/unit' },
  { id: 'contract', title: 'Route, SDK and OpenAPI contract tests', directory: 'dist/tests/contract', live: true },
  { id: 'integration', title: 'Integration tests (real MongoDB where durable)', directory: 'dist/tests/integration', live: true },
  { id: 'security', title: 'Security regression tests', directory: 'dist/tests/security' },
  { id: 'e2e', title: 'End-to-end API-to-engine tests', directory: 'dist/tests/e2e' },
  { id: 'openapi', title: 'OpenAPI drift detection', command: 'dist/scripts/check-openapi.js' },
  { id: 'audit', title: 'Dependency vulnerability scan', command: 'dist/scripts/check-audit.js' },
]);

export function discoverTests(root: string): string[] {
  const found: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (entry.endsWith('.test.js')) found.push(absolute);
    }
  }
  const tests = path.join(root, 'dist', 'tests');
  try {
    walk(tests);
  } catch {
    throw new Error('dist/tests is missing; run "npm run build" before the gate');
  }
  return found.sort();
}

export type GatePlan = {
  gate: Gate;
  tests: string[];
  command?: string;
};

export function planGates(root: string): { plans: GatePlan[]; unclaimed: string[] } {
  const tests = discoverTests(root);
  const claimed = new Set<string>();
  const plans: GatePlan[] = [];

  for (const gate of GATES) {
    const gateTests = gate.directory
      ? tests.filter((file) => file.startsWith(path.join(root, gate.directory as string) + path.sep))
      : [];
    if (gate.directory) {
      for (const file of gateTests) {
        if (claimed.has(file)) {
          throw new Error(`${path.relative(root, file)} is claimed by more than one gate`);
        }
        claimed.add(file);
      }
      if (gateTests.length === 0) {
        throw new Error(`gate ${gate.id} has no compiled tests under ${gate.directory}`);
      }
    }
    const command = gate.command ? path.join(root, gate.command) : undefined;
    if (command) {
      try {
        statSync(command);
      } catch {
        throw new Error(`gate ${gate.id} command is missing: ${gate.command}`);
      }
    }
    plans.push({ gate, tests: gateTests, ...(command ? { command } : {}) });
  }

  return {
    plans,
    unclaimed: tests.filter((file) => !claimed.has(file)).map((file) => path.relative(root, file)),
  };
}
