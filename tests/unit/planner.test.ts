import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDeterministicPlanner,
  normalizePlan,
  parsePlan,
  planGraphIssue,
} from '../../src/agents/native/planner.js';

test('a model plan becomes an ordered dependency graph', () => {
  const plan = parsePlan(
    '```json\n[{"title":"Read","dependsOn":[]},{"title":"Write","dependsOn":[1],"successCriteria":"file exists"}]\n```',
    8,
  );
  assert.ok(plan);
  assert.deepEqual(plan?.map((step) => step.id), ['step-1', 'step-2']);
  assert.deepEqual(plan?.[1]?.dependsOn, ['step-1']);
  assert.equal(plan?.[1]?.successCriteria, 'file exists');
});

test('cyclic, duplicate and unknown-dependency plans are refused whole', () => {
  assert.equal(
    parsePlan('[{"title":"a","dependsOn":[2]},{"title":"b","dependsOn":[1]}]', 8),
    null,
  );
  assert.equal(parsePlan('[{"title":"a","dependsOn":[9]},{"title":"b"}]', 8), null);
  // Titles may repeat; ids are engine-assigned, so a model cannot collide them.
  assert.equal(parsePlan('["a","a"]', 8)?.length, 2);
  assert.equal(parsePlan('not a plan', 8), null);
  assert.equal(parsePlan('[]', 8), null);

  assert.equal(
    planGraphIssue([
      { id: 'step-1', title: 'a', dependsOn: ['step-2'] },
      { id: 'step-2', title: 'b', dependsOn: ['step-1'] },
    ]),
    'The plan contains a dependency cycle.',
  );
});

test('a self-reference or a title-shaped dependency rejects the plan instead of being dropped', () => {
  assert.equal(parsePlan('[{"title":"a","dependsOn":[1]}]', 8), null);
  assert.equal(parsePlan('[{"title":"a","dependsOn":["Read the input"]}]', 8), null);
  const valid = parsePlan('[{"title":"a"},{"title":"b","dependsOn":[1]}]', 8);
  assert.deepEqual(valid?.[1]?.dependsOn, ['step-1']);
});

test('an older persisted plan is normalized without inventing dependencies', () => {
  const normalized = normalizePlan([
    { id: 'step-1', title: 'Read', dependsOn: ['unknown', 3 as unknown as string] },
    { id: '', title: 'Write' },
  ]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0]?.dependsOn, ['unknown']);
  assert.equal(normalized[1]?.id, 'step-2');
});

test('the deterministic planner builds sequential dependencies and honours the ceiling', async () => {
  const planner = createDeterministicPlanner();
  const plan = await planner.plan({
    objective: 'Read the input\nWrite the output\nVerify it\nShip it',
    maxSteps: 3,
  });
  assert.deepEqual(plan.map((step) => step.title), ['Read the input', 'Write the output', 'Verify it']);
  assert.deepEqual(plan.map((step) => step.dependsOn), [[], ['step-1'], ['step-2']]);
});
