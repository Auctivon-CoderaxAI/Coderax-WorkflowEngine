import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamRecord } from '../../src/domain.js';
import { parseTestResult, verifyTeam } from '../../src/orchestration/teamverify.js';

function record(overrides: Partial<TeamRecord> = {}): TeamRecord {
  const now = '2026-11-26T12:00:00.000Z';
  return {
    teamId: 'team_1',
    ownerId: 'owner-test',
    tenantId: null,
    conversationId: 'conv_1',
    mode: 'cloud',
    objective: 'Produce a verified report',
    reasoning: 'complex',
    state: 'running',
    generation: 1,
    runToken: 'run_1',
    members: [
      {
        memberId: 'research',
        agent: 'coderax',
        objective: 'Collect the facts',
        dependsOn: [],
        resources: [],
        state: 'completed',
        attempts: 1,
        evidence: 'VERDICT: PASS',
      },
    ],
    plan: {
      revision: 1,
      mode: 'complex',
      steps: [{ id: 'research', title: 'Collect the facts', dependsOn: [], kind: 'reason' }],
    },
    checks: [],
    limits: { maxMembers: 4, maxParallel: 2, maxDurationMs: 10_000, maxStepsPerMember: 2 },
    checkpoint: {
      completedMembers: ['research'],
      outputs: { research: 'VERDICT: PASS' },
      artifacts: [],
      evidence: [
        {
          stepId: 'research',
          title: 'Collect the facts',
          output: 'VERDICT: PASS',
          citation: 'member:research',
          attempts: 1,
        },
      ],
    },
    verification: null,
    failure: null,
    cancelRequested: false,
    budget: null,
    usage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    heartbeatAt: now,
    ...overrides,
  };
}

test('a model VERDICT: PASS without an artifact is not completion', async () => {
  const result = await verifyTeam({
    record: record({
      checks: [{ kind: 'artifact', path: 'reports/result.md' }],
    }),
    maxArtifactBytes: 1_000_000,
    read: async () => null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((entry) => entry.checkId === 'artifact:reports/result.md')?.passed, false);
  assert.doesNotMatch(result.reason, /VERDICT/);
});

test('a real artifact is hashed by the engine and satisfies an artifact check', async () => {
  const bytes = Buffer.from('measured output');
  const result = await verifyTeam({
    record: record({
      checks: [{ kind: 'artifact', path: 'reports/result.md' }],
    }),
    maxArtifactBytes: 1_000_000,
    read: async () => ({ bytes: bytes.byteLength, sha256: 'a'.repeat(64), text: bytes.toString() }),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.artifacts, [
    { path: 'reports/result.md', bytes: bytes.byteLength, sha256: 'a'.repeat(64) },
  ]);
});

test('the declared artifact digest and minimum size are enforced', async () => {
  const read = async () => ({ bytes: 10, sha256: 'b'.repeat(64), text: 'x' });
  const wrongDigest = await verifyTeam({
    record: record({
      checks: [{ kind: 'artifact', path: 'a.txt', sha256: 'c'.repeat(64) }],
    }),
    maxArtifactBytes: 1_000_000,
    read,
  });
  assert.equal(wrongDigest.passed, false);

  const tooSmall = await verifyTeam({
    record: record({
      checks: [{ kind: 'artifact', path: 'a.txt', minBytes: 11 }],
    }),
    maxArtifactBytes: 1_000_000,
    read,
  });
  assert.equal(tooSmall.passed, false);

  const oversized = await verifyTeam({
    record: record({ checks: [{ kind: 'artifact', path: 'a.txt' }] }),
    maxArtifactBytes: 5,
    read,
  });
  assert.equal(oversized.passed, false);
});

test('a test check reads actual results and requires zero failures', async () => {
  const passing = await verifyTeam({
    record: record({ checks: [{ kind: 'test', path: 'test-results.json' }] }),
    maxArtifactBytes: 1_000_000,
    read: async () => ({
      bytes: 30,
      sha256: 'd'.repeat(64),
      text: JSON.stringify({ total: 4, passed: 4, failed: 0 }),
    }),
  });
  assert.equal(passing.passed, true);

  const failing = await verifyTeam({
    record: record({ checks: [{ kind: 'test', path: 'test-results.json' }] }),
    maxArtifactBytes: 1_000_000,
    read: async () => ({
      bytes: 30,
      sha256: 'd'.repeat(64),
      text: JSON.stringify({ total: 4, passed: 3, failed: 1 }),
    }),
  });
  assert.equal(failing.passed, false);
});

test('an evidence check needs a completed member with persisted evidence', async () => {
  const missing = await verifyTeam({
    record: record({
      members: [],
      checkpoint: { completedMembers: [], outputs: {}, artifacts: [], evidence: [] },
      checks: [{ kind: 'evidence', memberId: 'research' }],
    }),
    maxArtifactBytes: 1_000_000,
    read: async () => null,
  });
  assert.equal(missing.passed, false);

  const present = await verifyTeam({
    record: record({ checks: [{ kind: 'evidence', memberId: 'research' }] }),
    maxArtifactBytes: 1_000_000,
    read: async () => null,
  });
  assert.equal(present.passed, true);
});

test('the test result parser rejects empty, failing and malformed results', () => {
  assert.deepEqual(parseTestResult(JSON.stringify({ total: 2, passed: 2, failed: 0 })), {
    ok: true,
    total: 2,
    passed: 2,
  });
  assert.equal(parseTestResult('not json').ok, false);
  assert.equal(parseTestResult(JSON.stringify({ total: 0, passed: 0, failed: 0 })).ok, false);
  assert.equal(parseTestResult(JSON.stringify({ total: 2, passed: 1, failed: 1 })).ok, false);
  assert.equal(parseTestResult(JSON.stringify({ passed: 2 })).ok, false);
});
