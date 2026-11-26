import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReachability } from '../../scripts/gate/reachability.js';
import {
  checkStructure,
  findBoundaryViolations,
  findDuplicateAuthorities,
  findForbiddenLiterals,
  findOwnershipViolations,
} from '../../scripts/gate/structure.js';

test('no boundary, ownership, authority, literal, secret or cycle violation', () => {
  const result = checkStructure();
  assert.deepEqual(result.findings, []);
});

test('no unreachable module or unused runtime export', () => {
  const result = checkReachability();
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings, []);
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
    { path: 'src/models/rogue.ts', text: 'createModelRouter({ providers: [] });' },
    { path: 'src/execution/rogue.ts', text: 'createExecutionSupervisor({ executions });' },
    { path: 'src/agents/rogue.ts', text: 'createTaskScheduler({ maxConcurrent: 1 });' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'single-route-table'));
  assert.ok(findings.some((finding) => finding.rule === 'single-run-starter'));
  assert.ok(findings.some((finding) => finding.rule === 'single-model-router'));
  assert.ok(findings.some((finding) => finding.rule === 'single-supervisor'));
  assert.ok(findings.some((finding) => finding.rule === 'single-scheduler'));
});

test('the authority rule rejects competing model routers', () => {
  const findings = findDuplicateAuthorities([
    {
      path: 'src/models/router.ts',
      text: 'export function createModelRouter(input: Options): Router { return input as never; }',
    },
    {
      path: 'src/models/legacy.ts',
      text: 'export function createRouter(input: Options): Router { return input as never; }',
    },
  ]);
  assert.equal(findings.filter((finding) => finding.rule === 'single-model-authority').length, 1);
});

test('the authority rule rejects a second supervisor, planner and scheduler', () => {
  const findings = findDuplicateAuthorities([
    { path: 'src/execution/supervisor.ts', text: 'export function createExecutionSupervisor(deps) { return deps; }' },
    { path: 'src/execution/legacy-supervisor.ts', text: 'export function createRunSupervisor(deps) { return deps; }' },
    { path: 'src/agents/native/plan.ts', text: 'export function createNativePlanner(input) { return input; }' },
    { path: 'src/agents/native/planner.ts', text: 'export function createDeterministicPlanner() { return {}; }' },
    { path: 'src/scheduling/scheduler.ts', text: 'export function createTaskScheduler(input) { return input; }' },
    { path: 'src/scheduling/queue.ts', text: 'export function createTaskScheduler(input) { return input; }' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'single-supervisor'));
  assert.ok(findings.some((finding) => finding.rule === 'single-planner'));
  assert.ok(findings.some((finding) => finding.rule === 'single-scheduler'));
});

test('the authority rule rejects duplicate persistence for one domain', () => {
  const findings = findDuplicateAuthorities([
    { path: 'src/persistence/mongo-tables.ts', text: 'export function createMongoTaskRepository(collection) { return collection; }' },
    { path: 'src/persistence/mongo-tasks.ts', text: 'export function createMongoTaskStore(collection) { return collection; }' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'duplicate-persistence'));
});

test('the literal rule detects a hand-written API path', () => {
  const findings = findForbiddenLiterals([
    { path: 'src/api/rogue.ts', text: "const path = '/v1/rogue';" },
  ]);
  assert.ok(
    findings.some((finding) => finding.rule === 'catalogue-is-the-only-route-source'),
  );
});

test('the egress rule allows the provider layer and rejects every other path', () => {
  const allowed = findForbiddenLiterals([
    { path: 'src/models/providers/http.ts', text: 'await fetch(url, init);' },
  ]);
  assert.equal(allowed.some((finding) => finding.rule === 'single-egress'), false);
  const denied = findForbiddenLiterals([
    { path: 'src/agents/native/rogue.ts', text: 'await fetch(url);' },
    { path: 'src/orchestration/rogue.ts', text: "import OpenAI from 'openai';" },
  ]);
  assert.ok(denied.some((finding) => finding.rule === 'single-egress'));
  assert.ok(denied.some((finding) => finding.rule === 'single-inference-egress'));
});

test('the zero-cost literal cannot be enabled anywhere', () => {
  const findings = findOwnershipViolations([
    { path: 'src/models/rogue.ts', text: 'const config = { allowPaid: true };' },
  ]);
  assert.ok(findings.some((finding) => finding.rule === 'zero-cost-literal'));
});
