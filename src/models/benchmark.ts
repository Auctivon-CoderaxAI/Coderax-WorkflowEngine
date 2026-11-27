import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { BenchmarkScore, ToolCall } from './types.js';

/**
 * Reproducible quality evidence.
 *
 * A score is produced by running a fixed, versioned task suite at temperature 0
 * and grading deterministic outputs locally. Provider benchmark marketing is not
 * an input. The artifact records the suite digest, so a score can be tied to the
 * exact questions it measured.
 */
export const BenchmarkTask = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(['exact', 'numeric', 'contains', 'tool']),
    category: z.enum(['coding', 'reasoning']),
    prompt: z.string().min(1).max(20_000),
    expected: z.union([z.string(), z.number()]).optional(),
    tolerance: z.number().nonnegative().max(1).optional(),
    contains: z.array(z.string().min(1)).optional(),
    expectedTool: z
      .object({
        name: z.string().min(1).max(80),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BenchmarkTask = z.infer<typeof BenchmarkTask>;

export const BenchmarkSuite = z
  .object({
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    tasks: z.array(BenchmarkTask).min(1).max(200),
  })
  .strict();
export type BenchmarkSuite = z.infer<typeof BenchmarkSuite>;

const Result = z
  .object({
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(160),
    samples: z.number().int().positive(),
    coding: z.number().min(0).max(1),
    reasoning: z.number().min(0).max(1),
    toolCalling: z.number().min(0).max(1).optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();

export const BenchmarkArtifact = z
  .object({
    suite: z
      .object({
        name: z.string().min(1).max(120),
        version: z.number().int().positive(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict(),
    capturedAt: z.string().datetime({ offset: true }),
    results: z.array(Result).min(1).max(500),
  })
  .strict();
export type BenchmarkArtifact = z.infer<typeof BenchmarkArtifact>;

export class BenchmarkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkFileError';
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestSuite(suite: BenchmarkSuite): string {
  return `sha256:${createHash('sha256').update(canonical(suite)).digest('hex')}`;
}

export function loadBenchmarkScores(filePath: string): BenchmarkScore[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new BenchmarkFileError(`benchmark results file ${filePath} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BenchmarkFileError(`benchmark results file ${filePath} is not valid JSON`);
  }
  const artifact = BenchmarkArtifact.safeParse(parsed);
  if (!artifact.success) {
    throw new BenchmarkFileError(
      `benchmark results file ${filePath} does not match the artifact schema`,
    );
  }
  return artifact.data.results.map((result) => ({
    ...result,
    suite: artifact.data.suite.name,
    suiteDigest: artifact.data.suite.digest,
    measuredAt: artifact.data.capturedAt,
  }));
}

export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/```[a-z]*\n?/g, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function numbersIn(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number).filter(Number.isFinite);
}

function argumentsContain(actual: unknown, expected: Record<string, unknown>): boolean {
  if (actual === null || typeof actual !== 'object') return false;
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    const candidate = record[key];
    if (typeof value === 'number' && typeof candidate === 'number') {
      if (Math.abs(value - candidate) > 1e-9) return false;
    } else if (canonical(candidate) !== canonical(value)) {
      return false;
    }
  }
  return true;
}

/** Deterministic grading: no model judges another model. */
export function gradeTask(task: BenchmarkTask, output: { text: string; toolCalls: ToolCall[] }): boolean {
  if (task.kind === 'tool') {
    if (!task.expectedTool) return false;
    return output.toolCalls.some(
      (call) =>
        call.name === task.expectedTool?.name &&
        (task.expectedTool.arguments === undefined ||
          argumentsContain(call.arguments, task.expectedTool.arguments)),
    );
  }

  if (task.kind === 'exact') {
    if (typeof task.expected !== 'string') return false;
    // Exact means equal after normalization; substring matching would pass `122`
    // for an expected `22` and promote a wrong answer in production ranking.
    return normalizeAnswer(output.text) === normalizeAnswer(task.expected);
  }

  if (task.kind === 'contains') {
    if (!task.contains || task.contains.length === 0) return false;
    const normalized = normalizeAnswer(output.text);
    return task.contains.every((needle) => normalized.includes(normalizeAnswer(needle)));
  }

  if (typeof task.expected !== 'number') return false;
  const expected = task.expected;
  const tolerance = task.tolerance ?? 0;
  return numbersIn(output.text).some((value) => Math.abs(value - expected) <= tolerance);
}

export type TaskOutcome = { task: BenchmarkTask; passed: boolean; latencyMs: number };

export function scoreOutcomes(outcomes: readonly TaskOutcome[]): {
  samples: number;
  coding: number;
  reasoning: number;
  toolCalling?: number;
} {
  const rate = (items: TaskOutcome[]): number =>
    items.length === 0 ? 0 : items.filter((item) => item.passed).length / items.length;
  const tool = outcomes.filter((outcome) => outcome.task.kind === 'tool');
  return {
    samples: outcomes.length,
    coding: rate(
      outcomes.filter(
        (outcome) => outcome.task.category === 'coding' && outcome.task.kind !== 'tool',
      ),
    ),
    reasoning: rate(
      outcomes.filter(
        (outcome) => outcome.task.category === 'reasoning' && outcome.task.kind !== 'tool',
      ),
    ),
    ...(tool.length > 0 ? { toolCalling: rate(tool) } : {}),
  };
}

export function buildArtifact(input: {
  suite: BenchmarkSuite;
  capturedAt: string;
  results: Array<{
    providerId: string;
    modelId: string;
    samples: number;
    coding: number;
    reasoning: number;
    toolCalling?: number;
    latencyMs?: number;
  }>;
}): BenchmarkArtifact {
  return BenchmarkArtifact.parse({
    suite: {
      name: input.suite.name,
      version: input.suite.version,
      digest: digestSuite(input.suite),
    },
    capturedAt: input.capturedAt,
    results: input.results,
  });
}
