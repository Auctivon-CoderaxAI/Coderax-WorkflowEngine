import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamMemberSpec } from '@coderax/contracts';
import { planWaves } from '../../src/agents/native/schedule.js';
import { structuralAssessment } from '../../src/agents/native/verify.js';
import { teamPlan, validateChecks } from '../../src/orchestration/teamplan.js';
import type { TaskEvidence, TaskPlanStep } from '../../src/domain.js';

function member(overrides: Partial<TeamMemberSpec> & { memberId: string }): TeamMemberSpec {
  return {
    agent: 'coderax',
    objective: `Do ${overrides.memberId}`,
    dependsOn: [],
    resources: [],
    ...overrides,
  } as TeamMemberSpec;
}

const step = (id: string, dependsOn: string[] = []): TaskPlanStep => ({
  id,
  title: id,
  dependsOn,
  kind: 'reason',
});

test('a valid member graph becomes a plan', () => {
  const result = teamPlan({
    mode: 'complex',
    members: [
      member({ memberId: 'research' }),
      member({ memberId: 'write', dependsOn: ['research'], resources: ['docs/a.txt'] }),
    ],
    maxMembers: 4,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan.steps.map((entry) => entry.id), ['research', 'write']);
  assert.deepEqual(result.plan.steps[1]?.dependsOn, ['research']);
});

test('a cycle, unknown dependency or duplicate id is refused', () => {
  const cycle = teamPlan({
    mode: 'complex',
    members: [
      member({ memberId: 'a', dependsOn: ['b'] }),
      member({ memberId: 'b', dependsOn: ['a'] }),
    ],
    maxMembers: 4,
  });
  assert.equal(cycle.ok, false);

  const unknown = teamPlan({
    mode: 'complex',
    members: [member({ memberId: 'a', dependsOn: ['missing'] })],
    maxMembers: 4,
  });
  assert.equal(unknown.ok, false);

  const duplicate = teamPlan({
    mode: 'complex',
    members: [member({ memberId: 'a' }), member({ memberId: 'a' })],
    maxMembers: 4,
  });
  assert.equal(duplicate.ok, false);
});

test('the member bound and resource confinement are enforced at submission', () => {
  const tooMany = teamPlan({
    mode: 'complex',
    members: [member({ memberId: 'a' }), member({ memberId: 'b' }), member({ memberId: 'c' })],
    maxMembers: 2,
  });
  assert.equal(tooMany.ok, false);

  const escape = teamPlan({
    mode: 'complex',
    members: [member({ memberId: 'a', resources: ['../private/secret.txt'] })],
    maxMembers: 4,
  });
  assert.equal(escape.ok, false);

  const absolute = teamPlan({
    mode: 'complex',
    members: [member({ memberId: 'a', resources: ['/etc/passwd'] })],
    maxMembers: 4,
  });
  assert.equal(absolute.ok, false);
});

test('checks must name real members, confined paths and unique subjects', () => {
  const members = [member({ memberId: 'a' })];
  assert.equal(
    validateChecks({
      checks: [{ kind: 'evidence', memberId: 'missing' }],
      members,
    }).ok,
    false,
  );
  assert.equal(
    validateChecks({
      checks: [{ kind: 'artifact', path: '../outside.txt' }],
      members,
    }).ok,
    false,
  );
  assert.equal(
    validateChecks({
      checks: [
        { kind: 'artifact', path: 'reports/result.json' },
        { kind: 'artifact', path: 'reports/result.json' },
      ],
      members,
    }).ok,
    false,
  );
  assert.equal(
    validateChecks({
      checks: [{ kind: 'evidence', memberId: 'a' }],
      members,
    }).ok,
    true,
  );
});

test('waves respect dependencies and the parallel bound', () => {
  const schedule = planWaves({
    steps: [step('a'), step('b'), step('c'), step('d', ['a'])],
    completed: new Set(),
    maxParallel: 2,
  });
  assert.equal(schedule.ok, true);
  if (!schedule.ok) return;
  assert.deepEqual(schedule.waves.map((wave) => wave.map((entry) => entry.id)), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('a wave never places a dependent step beside its dependency', () => {
  const schedule = planWaves({
    steps: [step('a'), step('b', ['a'])],
    completed: new Set(),
    maxParallel: 4,
  });
  assert.equal(schedule.ok, true);
  if (!schedule.ok) return;
  assert.deepEqual(schedule.waves.map((wave) => wave.map((entry) => entry.id)), [['a'], ['b']]);
});

test('construction refuses a plan with no ready step', () => {
  const schedule = planWaves({
    steps: [step('a', ['b']), step('b', ['a'])],
    completed: new Set(),
    maxParallel: 2,
  });
  assert.equal(schedule.ok, false);
});

test('structural verification rejects a completed member without evidence', () => {
  const plan = { revision: 1, mode: 'complex' as const, steps: [step('a'), step('b')] };
  const evidence: TaskEvidence[] = [
    { stepId: 'a', title: 'a', output: 'real output', citation: 'member:a', attempts: 1 },
  ];
  const missing = structuralAssessment({ plan, completed: new Set(['a']), evidence });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /Not every planned step completed/);

  const empty = structuralAssessment({
    plan,
    completed: new Set(['a', 'b']),
    evidence: [...evidence, { stepId: 'b', title: 'b', output: '', citation: '', attempts: 1 }],
  });
  assert.equal(empty.passed, false);
  assert.match(empty.reason, /without evidence/);
});
