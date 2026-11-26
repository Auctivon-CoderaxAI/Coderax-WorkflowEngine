import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deterministicPlan,
  parseModelPlan,
  splitObjective,
  validatePlan,
} from '../../src/agents/native/plan.js';
import { planWaves } from '../../src/agents/native/schedule.js';
import { limitsFor, resolveReasoningMode } from '../../src/agents/native/reason.js';
import type { TaskPlan, TaskPlanStep } from '../../src/domain.js';
import type { NativeLimits } from '../../src/agents/native/types.js';

function step(id: string, dependsOn: string[] = []): TaskPlanStep {
  return { id, title: `Step ${id}`, kind: 'reason', dependsOn };
}

function plan(steps: TaskPlanStep[], mode: 'fast' | 'complex' = 'complex'): TaskPlan {
  return { revision: 1, mode, steps };
}

test('complex reasoning decomposes structured objectives while fast stays direct', () => {
  const objective = 'Audit the API surface\nDraft the migration\nVerify the rollout';
  assert.deepEqual(splitObjective(objective), [
    'Audit the API surface',
    'Draft the migration',
    'Verify the rollout',
  ]);

  const fast = deterministicPlan({ objective, mode: 'fast', maxSteps: 8 });
  assert.equal(fast.steps.length, 3);

  const singleFast = deterministicPlan({
    objective: 'Summarize the repository',
    mode: 'fast',
    maxSteps: 8,
  });
  assert.equal(singleFast.steps.length, 1);

  const singleComplex = deterministicPlan({
    objective: 'Summarize the repository',
    mode: 'complex',
    maxSteps: 8,
  });
  assert.equal(singleComplex.steps.length, 2);
  assert.deepEqual(singleComplex.steps[1]?.dependsOn, ['step-1']);
});

test('plan validation refuses cycles, unknown dependencies, escaping reads and duplicates', () => {
  const cyclic = validatePlan({
    plan: plan([step('a', ['b']), step('b', ['a'])]),
    completedSteps: [],
    maxSteps: 4,
  });
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.ok ? '' : cyclic.reason, /cycle/);

  const unknown = validatePlan({
    plan: plan([step('a', ['missing'])]),
    completedSteps: [],
    maxSteps: 4,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.reason, /unknown/);

  const duplicate = validatePlan({
    plan: plan([step('a'), step('a')]),
    completedSteps: [],
    maxSteps: 4,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok ? '' : duplicate.reason, /duplicated/);

  const escaping: TaskPlan = {
    revision: 1,
    mode: 'complex',
    steps: [
      {
        id: 'read',
        title: 'Read a file outside the workspace',
        kind: 'read',
        dependsOn: [],
        resource: '../private/secret.txt',
      },
    ],
  };
  const denied = validatePlan({ plan: escaping, completedSteps: [], maxSteps: 4 });
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? '' : denied.reason, /invalid workspace resource/);

  const forwardReference = validatePlan({
    plan: plan([step('finish', ['start']), step('start')]),
    completedSteps: [],
    maxSteps: 4,
  });
  assert.equal(forwardReference.ok, true);
});

test('parallel waves respect dependencies and the configured concurrency bound', () => {
  const steps = [step('a'), step('b'), step('c', ['a']), step('d', ['c'])];
  const scheduled = planWaves({ steps, completed: new Set(), maxParallel: 2 });
  assert.equal(scheduled.ok, true);
  if (!scheduled.ok) return;
  assert.deepEqual(
    scheduled.waves.map((wave) => wave.map((entry) => entry.id)),
    [['a', 'b'], ['c'], ['d']],
  );

  const sequential = planWaves({ steps, completed: new Set(['a', 'b']), maxParallel: 1 });
  assert.equal(sequential.ok, true);
  if (!sequential.ok) return;
  assert.deepEqual(
    sequential.waves.map((wave) => wave.map((entry) => entry.id)),
    [['c'], ['d']],
  );

  const blocked = planWaves({
    steps: [step('a', ['never'])],
    completed: new Set(),
    maxParallel: 2,
  });
  assert.equal(blocked.ok, false);

  const malformed = planWaves({
    steps: [step('a'), step('b')],
    completed: new Set(),
    maxParallel: Number.NaN,
  });
  assert.equal(malformed.ok, true);
  if (malformed.ok) assert.equal(malformed.waves.length, 2);
});

test('the model plan parser accepts a valid read plan and refuses unsupported actions', () => {
  const valid = parseModelPlan({
    text: JSON.stringify({
      steps: [
        {
          id: 'read-notes',
          title: 'Read the notes',
          kind: 'read',
          dependsOn: [],
          resource: 'notes.txt',
          acceptance: 'Read the file.',
        },
        {
          id: 'answer',
          title: 'Answer from the notes',
          kind: 'reason',
          dependsOn: ['read-notes'],
        },
      ],
    }),
    mode: 'complex',
    maxSteps: 6,
    revision: 1,
    completedSteps: [],
  });
  assert.equal(valid.ok, true);

  const unsupported = parseModelPlan({
    text: JSON.stringify({
      steps: [{ id: 'run', title: 'Run a command', kind: 'command', dependsOn: [] }],
    }),
    mode: 'complex',
    maxSteps: 6,
    revision: 1,
    completedSteps: [],
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.ok ? '' : unsupported.reason, /unsupported/);

  const escaping = parseModelPlan({
    text: JSON.stringify({
      steps: [
        { id: 'read', title: 'Read', kind: 'read', dependsOn: [], resource: '/etc/passwd' },
      ],
    }),
    mode: 'complex',
    maxSteps: 6,
    revision: 1,
    completedSteps: [],
  });
  assert.equal(escaping.ok, false);

  const malformedDependencies = parseModelPlan({
    text: JSON.stringify({
      steps: [{ id: 'answer', title: 'Answer', kind: 'reason', dependsOn: 'read-notes' }],
    }),
    mode: 'complex',
    maxSteps: 6,
    revision: 1,
    completedSteps: [],
  });
  assert.equal(malformedDependencies.ok, false);
  assert.match(
    malformedDependencies.ok ? '' : malformedDependencies.reason,
    /malformed dependency list/,
  );
});

test('auto reasoning is fast for simple objectives and complex for structured ones', () => {
  assert.equal(
    resolveReasoningMode({ requested: 'auto', objective: 'Summarize the repository' }),
    'fast',
  );
  assert.equal(
    resolveReasoningMode({ requested: 'auto', objective: 'Audit the API; then patch it' }),
    'complex',
  );
  assert.equal(
    resolveReasoningMode({ requested: 'fast', objective: 'Audit every subsystem in detail' }),
    'fast',
  );
  assert.equal(
    resolveReasoningMode({ requested: 'complex', objective: 'Summarize the repository' }),
    'complex',
  );
});

test('fast limits cannot grow into an unbounded autonomous loop', () => {
  const base: NativeLimits = {
    maxSteps: 12,
    maxParallelSteps: 4,
    maxReplans: 3,
    maxStepAttempts: 2,
    maxIterations: 32,
  };
  const fast = limitsFor('fast', base);
  assert.equal(fast.maxParallelSteps, 1);
  assert.equal(fast.maxReplans, 0);
  assert.equal(fast.maxIterations, 8);
  assert.equal(fast.maxSteps, 4);

  const complex = limitsFor('complex', base);
  assert.equal(complex.maxParallelSteps, 4);
  assert.equal(complex.maxReplans, 3);
  assert.equal(complex.maxIterations, 32);
});
