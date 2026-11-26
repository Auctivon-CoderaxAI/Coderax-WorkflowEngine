import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkLiveCoverage } from '../../scripts/live-coverage.js';

function fixture(): string {
  return mkdtempSync(path.join(tmpdir(), 'coderax-live-coverage-'));
}

test('the current tree does not claim a live subsystem it has not integrated', () => {
  assert.deepEqual(checkLiveCoverage(process.cwd()), []);
});

test('a durable subsystem without a live suite is rejected', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src/artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'src/artifacts/service.ts'), 'export const service = true;\n');
    const findings = checkLiveCoverage(root);
    assert.ok(findings.some((finding) => finding.rule === 'missing_live_coverage'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live database suite must name the required test database', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src/artifacts'), { recursive: true });
    mkdirSync(path.join(root, 'tests/live'), { recursive: true });
    writeFileSync(path.join(root, 'src/artifacts/service.ts'), 'export const service = true;\n');
    writeFileSync(
      path.join(root, 'tests/live/artifacts.test.ts'),
      "test('artifact', { skip: true }, () => undefined);\n",
    );
    const findings = checkLiveCoverage(root);
    assert.ok(findings.some((finding) => finding.rule === 'live_database_not_explicit'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live database suite with the required variable is accepted', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src/artifacts'), { recursive: true });
    mkdirSync(path.join(root, 'tests/live'), { recursive: true });
    writeFileSync(path.join(root, 'src/artifacts/service.ts'), 'export const service = true;\n');
    writeFileSync(
      path.join(root, 'tests/live/artifacts.test.ts'),
      "const uri = process.env.CODERAX_TEST_MONGO_URI;\ntest('artifact', () => undefined);\n",
    );
    assert.deepEqual(checkLiveCoverage(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
