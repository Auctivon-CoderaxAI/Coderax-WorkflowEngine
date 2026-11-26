import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReachability } from '../../scripts/gate/reachability.js';
import {
  checkStructure,
  findBoundaryViolations,
  findForbiddenLiterals,
  findOwnershipViolations,
} from '../../scripts/gate/structure.js';

test('no boundary, ownership, literal, secret or cycle violation', () => {
  const result = checkStructure();
  assert.deepEqual(result.findings, []);
});

test('no unreachable module or unused runtime export', () => {
  const result = checkReachability();
  assert.deepEqual(result.findings, []);
});

test('known parity scaffolding is reported as a warning, never hidden', () => {
  const result = checkReachability();
  assert.ok(
    result.warnings.some((warning) => warning.detail.includes('src/execution/retry.ts')),
    'the unwired retry module must stay visible as debt',
  );
  assert.ok(
    result.warnings.some((warning) => warning.detail.includes('adaptMongoWorkRunMethods')),
    'the migration adapter must stay visible as debt',
  );
});

test('the boundary rule detects an agent reaching persistence', () => {
  const findings = findBoundaryViolations([
    {
      path: 'src/agents/native/agent.ts',
      text: "import { createTaskRepository } from '../../persistence/tasks.js';",
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, 'agent-boundary');
});

test('the ownership rule detects a second route table and a second run starter', () => {
  const findings = findOwnershipViolations([
    { path: 'src/agents/rogue.ts', text: "registry.register('getHealth', handler);" },
    { path: 'src/agents/rogue.ts', text: 'await deps.runner.run(input);' },
    { path: 'src/models/rogue.ts', text: 'createModelCatalog({ descriptors: [] });' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'single-route-table'));
  assert.ok(findings.some((finding) => finding.rule === 'single-run-starter'));
  assert.ok(findings.some((finding) => finding.rule === 'single-model-router'));
});

test('the literal rule detects a hand-written API path', () => {
  const findings = findForbiddenLiterals([
    { path: 'src/api/rogue.ts', text: "const path = '/v1/rogue';" },
  ]);
  assert.ok(
    findings.some((finding) => finding.rule === 'catalogue-is-the-only-route-source'),
  );
});

test('the zero-cost literal cannot be enabled anywhere', () => {
  const findings = findOwnershipViolations([
    { path: 'src/models/rogue.ts', text: 'const config = { allowPaid: true };' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'zero-cost-literal'));
});
