import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkCapabilities,
  inspectCapabilities,
  createProgram,
} from '../../scripts/capabilities.js';
import { capabilityReport } from '../../scripts/capabilities.js';

/**
 * The ownership gate is type-based, so these fixtures deliberately use
 * different factory names and no file-name convention. A second value that
 * satisfies ModelCatalog is a competing router even when it is called `beta`
 * and registered indirectly; a ProviderAdapter is not a router.
 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-capability-'));
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

test('the checked-in repository has one authority per capability', () => {
  assert.deepEqual(checkCapabilities(process.cwd()), []);
});

test('two differently named values satisfying one capability are rejected', () => {
  const root = fixture({
    'src/models/types.ts': `
      export type ModelCatalog = { list: () => string[] };
      export type ProviderAdapter = { discover: () => Promise<string[]> };
    `,
    'src/models/alpha.ts': `
      import type { ModelCatalog } from './types.js';
      export function alpha(): ModelCatalog { return { list: () => [] }; }
    `,
    'src/models/beta.ts': `
      import type { ModelCatalog } from './types.js';
      export const beta = { list: () => [] } satisfies ModelCatalog;
    `,
    'src/models/provider.ts': `
      import type { ProviderAdapter } from './types.js';
      export function makeProvider(): ProviderAdapter {
        return { discover: async () => [] };
      }
    `,
  });
  try {
    const result = inspectCapabilities(createProgram(root), root);
    assert.ok(
      result.findings.some((finding) => finding.rule === 'duplicate_model_router'),
      JSON.stringify(result.findings),
    );
    assert.ok(result.owners.some((owner) => owner.exportName === 'alpha'));
    assert.ok(result.owners.some((owner) => owner.exportName === 'beta'));
    assert.ok(
      !result.owners.some((owner) => owner.exportName === 'makeProvider'),
      'a provider adapter is not a model router',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two different type names for one capability still count as competitors', () => {
  const root = fixture({
    'src/models/types.ts': `
      export type ModelCatalog = { list: () => string[] };
      export type Router = { route: () => string[] };
    `,
    'src/models/catalog.ts': `
      import type { ModelCatalog } from './types.js';
      export function createModelCatalog(): ModelCatalog { return { list: () => [] }; }
    `,
    'src/models/router.ts': `
      import type { Router } from './types.js';
      export function createRouter(): Router { return { route: () => [] }; }
    `,
  });
  try {
    const findings = checkCapabilities(root);
    assert.ok(
      findings.some((finding) => finding.rule === 'duplicate_model_router'),
      JSON.stringify(findings),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one implementation is accepted and reported as the only owner', () => {
  const root = fixture({
    'src/models/types.ts': 'export type ModelCatalog = { list: () => string[] };',
    'src/models/only.ts': `
      import type { ModelCatalog } from './types.js';
      export function renamedButAuthoritative(): ModelCatalog { return { list: () => [] }; }
    `,
  });
  try {
    const result = inspectCapabilities(createProgram(root), root);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(
      result.owners.filter((owner) => owner.capability === 'model_router').map((owner) => owner.exportName),
      ['renamedButAuthoritative'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the report names the actual type rather than relying on a file name', () => {
  const root = fixture({
    'src/scheduling/types.ts': 'export type TaskScheduler = { enqueue: () => void };',
    'src/scheduling/other.ts': `
      import type { TaskScheduler } from './types.js';
      export const queue = { enqueue: () => undefined } satisfies TaskScheduler;
    `,
  });
  try {
    const report = capabilityReport(root);
    assert.match(report, /scheduler: src\/scheduling\/other\.ts:queue/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
