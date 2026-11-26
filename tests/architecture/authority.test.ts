import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import {
  CAPABILITIES,
  checkAuthorities,
  inspectCapabilities,
} from '../../scripts/gate/authority.js';

/**
 * The semantic capability gate must be able to fail.
 *
 * The first test proves the repository has one authority per capability. The
 * remaining tests build deliberately broken trees and prove the checker catches
 * a duplicate regardless of factory name, while not mistaking a provider adapter
 * for a router. A gate that cannot fail is not a gate.
 */

test('the repository names at most one authority per capability', () => {
  assert.deepEqual(checkAuthorities().findings, []);
});

test('the gate declares the contracts the stacked branches introduce', () => {
  const capabilities = new Set(CAPABILITIES.map((spec) => spec.capability));
  for (const expected of [
    'model_router',
    'quota_ledger',
    'task_runner',
    'scheduler',
    'event_bus',
    'application_service',
    'http_router',
    'route_registry',
    'planner',
    'execution_supervisor',
  ]) {
    assert.ok(capabilities.has(expected), `${expected} must be a declared capability`);
  }
});

type Fixture = Record<string, string>;

function analyze(files: Fixture): { findings: { rule: string; detail: string }[]; owners: unknown[] } {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-authority-'));
  try {
    const rootNames: string[] = [];
    for (const [relative, text] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
      rootNames.push(absolute);
    }
    const program = ts.createProgram({
      rootNames,
      options: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
    });
    return inspectCapabilities(program, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('two values satisfying one capability are rejected even when factories are renamed', () => {
  const { findings } = analyze({
    'src/models/first.ts': [
      'export interface ModelCatalog { route(): string }',
      "export function createFirst(): ModelCatalog { return { route: () => 'first' } }",
    ].join('\n'),
    'src/models/second.ts': [
      'export interface ModelCatalog { route(): string }',
      "export function createSecond(): ModelCatalog { return { route: () => 'second' } }",
    ].join('\n'),
  });
  const duplicate = findings.find((finding) => finding.rule === 'duplicate_model_router');
  assert.ok(duplicate, JSON.stringify(findings));
  assert.match(duplicate.detail, /createFirst/);
  assert.match(duplicate.detail, /createSecond/);
});

test('a provider adapter is not mistaken for a model router', () => {
  const { findings, owners } = analyze({
    'src/models/catalog.ts': [
      'export interface ModelCatalog { route(): string }',
      "export function createCatalog(): ModelCatalog { return { route: () => 'ok' } }",
    ].join('\n'),
    'src/models/adapter.ts': [
      'export interface ProviderAdapter { complete(): string }',
      "export function createAdapter(): ProviderAdapter { return { complete: () => 'ok' } }",
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
  assert.equal(
    (owners as { capability: string }[]).filter((owner) => owner.capability === 'model_router')
      .length,
    1,
  );
});

test('a catalogue that projects the single router is complementary, not a second authority', () => {
  const { findings, owners } = analyze({
    'src/models/router.ts': [
      'export interface Router { list(): string[]; select(): string }',
      "export function createRouter(): Router { return { list: () => [], select: () => 'a' } }",
    ].join('\n'),
    'src/models/catalog.ts': [
      "import type { Router } from './router.js';",
      'export interface ModelCatalog { list(): string[]; route(): string[] }',
      'export function createCatalog(router: Router): ModelCatalog {',
      '  return { list: () => router.list(), route: () => [router.select()] };',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
  assert.equal(
    (owners as { capability: string }[]).filter((owner) => owner.capability === 'model_router')
      .length,
    2,
  );
});

test('two routing decisions are rejected even under different contract names', () => {
  const { findings } = analyze({
    'src/models/legacy.ts': [
      'export interface Router { select(): string }',
      "export function createRouter(): Router { return { select: () => 'a' } }",
    ].join('\n'),
    'src/models/authoritative.ts': [
      'export interface ModelRouter { select(): string }',
      "export function createModelRouter(): ModelRouter { return { select: () => 'b' } }",
    ].join('\n'),
  });
  const duplicate = findings.find((finding) => finding.rule === 'duplicate_model_router');
  assert.ok(duplicate, JSON.stringify(findings));
  assert.match(duplicate.detail, /createRouter/);
  assert.match(duplicate.detail, /createModelRouter/);
});

test('a second execution supervisor is rejected', () => {
  const { findings } = analyze({
    'src/execution/first.ts': [
      'export interface ExecutionSupervisor { supervise(): string }',
      "export function createPrimary(): ExecutionSupervisor { return { supervise: () => 'a' } }",
    ].join('\n'),
    'src/execution/second.ts': [
      'export interface ExecutionSupervisor { supervise(): string }',
      "export function createSecondary(): ExecutionSupervisor { return { supervise: () => 'b' } }",
    ].join('\n'),
  });
  const duplicate = findings.find(
    (finding) => finding.rule === 'duplicate_execution_supervisor',
  );
  assert.ok(duplicate, JSON.stringify(findings));
});
