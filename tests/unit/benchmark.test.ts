import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BenchmarkArtifact,
  BenchmarkSuite,
  buildArtifact,
  digestSuite,
  gradeTask,
  loadBenchmarkScores,
  normalizeAnswer,
  scoreOutcomes,
  type BenchmarkTask,
} from '../../src/models/benchmark.js';

const suite = BenchmarkSuite.parse({
  name: 'fixture',
  version: 1,
  tasks: [
    {
      id: 'coding',
      kind: 'numeric',
      category: 'coding',
      prompt: 'Return 42',
      expected: 42,
    },
    {
      id: 'reasoning',
      kind: 'exact',
      category: 'reasoning',
      prompt: 'Return yes',
      expected: 'yes',
    },
    {
      id: 'tool',
      kind: 'tool',
      category: 'reasoning',
      prompt: 'Read it',
      expectedTool: { name: 'read_file', arguments: { path: 'README.md' } },
    },
  ],
});

function task(overrides: Partial<BenchmarkTask>): BenchmarkTask {
  return {
    id: 't',
    kind: 'exact',
    category: 'coding',
    prompt: 'p',
    ...overrides,
  };
}

test('grading is deterministic and does not execute generated code', () => {
  assert.equal(normalizeAnswer('  O(n)  '), 'o(n)');
  assert.equal(gradeTask(task({ expected: 'yes' }), { text: '**Yes**', toolCalls: [] }), true);
  assert.equal(gradeTask(task({ expected: 'yes' }), { text: 'no', toolCalls: [] }), false);
  assert.equal(
    gradeTask(task({ kind: 'numeric', expected: 0.1071, tolerance: 0.001 }), {
      text: '0.1070',
      toolCalls: [],
    }),
    true,
  );
  assert.equal(
    gradeTask(task({ kind: 'contains', contains: ['o(n log n)'] }), {
      text: 'The complexity is O(n log n).',
      toolCalls: [],
    }),
    true,
  );
  assert.equal(
    gradeTask(
      task({
        kind: 'tool',
        expectedTool: { name: 'read_file', arguments: { path: 'README.md' } },
      }),
      { text: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'README.md' } }] },
    ),
    true,
  );
  assert.equal(
    gradeTask(
      task({
        kind: 'tool',
        expectedTool: { name: 'read_file', arguments: { path: 'README.md' } },
      }),
      { text: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'other.md' } }] },
    ),
    false,
  );
});

test('a suite digest is stable and scores retain the exact suite it measured', () => {
  const first = digestSuite(suite);
  const second = digestSuite(BenchmarkSuite.parse(JSON.parse(JSON.stringify(suite))));
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(digestSuite(BenchmarkSuite.parse({ ...suite, version: 2 })), first);
});

test('artifact scores are loaded with suite identity and reject malformed evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'coderax-benchmark-'));
  try {
    const artifact = buildArtifact({
      suite,
      capturedAt: '2026-11-26T12:00:00.000Z',
      results: [
        {
          providerId: 'openrouter',
          modelId: 'free/model',
          samples: 3,
          coding: 1,
          reasoning: 0.5,
          toolCalling: 1,
        },
      ],
    });
    const file = path.join(directory, 'result.json');
    writeFileSync(file, JSON.stringify(artifact), 'utf8');
    const scores = loadBenchmarkScores(file);
    assert.equal(scores[0]?.suite, 'fixture');
    assert.equal(scores[0]?.suiteDigest, digestSuite(suite));
    assert.equal(scores[0]?.measuredAt, '2026-11-26T12:00:00.000Z');
    assert.equal(scores[0]?.coding, 1);

    const broken = { ...artifact, suite: { ...artifact.suite, digest: 'not-a-digest' } };
    writeFileSync(file, JSON.stringify(broken), 'utf8');
    assert.throws(() => loadBenchmarkScores(file), /artifact schema/);
    assert.equal(BenchmarkArtifact.safeParse(artifact).success, true);
    assert.match(readFileSync(file, 'utf8'), /not-a-digest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scores are grouped by task category, not by task id', () => {
  const outcomes = suite.tasks.map((entry, index) => ({
    task: entry,
    passed: index !== 1,
    latencyMs: 1,
  }));
  const score = scoreOutcomes(outcomes);
  assert.equal(score.samples, 3);
  assert.equal(score.coding, 1);
  assert.equal(score.reasoning, 0);
  assert.equal(score.toolCalling, 1);
});
