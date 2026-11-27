import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const workflows = path.join(root, '.github', 'workflows');

test('there is one authoritative verification workflow', () => {
  // Security scanning lives in its own workflows; verification must not be duplicated.
  assert.deepEqual(readdirSync(workflows).filter((file) => file.endsWith('.yml')).sort(), [
    'codeql.yml',
    'secret-scan.yml',
    'verify.yml',
  ]);
});

test('the verification workflow cannot swallow a required failure', () => {
  const text = readFileSync(path.join(workflows, 'verify.yml'), 'utf8');
  assert.ok(!text.includes('continue-on-error'), 'a required check may not continue on error');
  assert.ok(!text.includes('|| true'), 'a required command may not mask its exit status');
  assert.ok(!text.includes('if: false'), 'a required job may not be disabled');
  for (const step of [
    'node dist/scripts/run-gates.js unit',
    'node dist/scripts/run-gates.js architecture',
    'node dist/scripts/run-gates.js audit',
    'node dist/scripts/run-gates.js openapi',
    'node dist/scripts/run-gates.js mongo-live',
  ]) {
    assert.ok(text.includes(step), `missing required step: ${step}`);
  }
});

test('actions are pinned and install scripts cannot run in the required job', () => {
  const text = readFileSync(path.join(workflows, 'verify.yml'), 'utf8');
  assert.match(text, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(text, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(text, /persist-credentials:\s*false/);
  assert.match(text, /npm ci --ignore-scripts/);
});

test('a gate-branch push produces exact-head hosted evidence', () => {
  const text = readFileSync(path.join(workflows, 'verify.yml'), 'utf8');
  assert.match(text, /branches:\s*\[main,\s*'ci\/\*\*'\]/);
});

test('the live lane uses a pinned MongoDB service and fails without it', () => {
  const text = readFileSync(path.join(workflows, 'verify.yml'), 'utf8');
  assert.match(text, /image:\s*mongo:7\.0\.14/);
  assert.match(text, /CODERAX_REQUIRE_MONGO:\s*['"]1['"]/);
  assert.match(text, /CODERAX_TEST_MONGO_URI:\s*mongodb:\/\/127\.0\.0\.1:27017\//);
});
