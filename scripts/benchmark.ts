import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/configuration/load.js';
import { composeApplication } from '../src/bootstrap/compose.js';
import {
  BenchmarkSuite,
  buildArtifact,
  digestSuite,
  gradeTask,
  scoreOutcomes,
  type TaskOutcome,
} from '../src/models/benchmark.js';
import type { ToolCall } from '../src/models/types.js';

/**
 * Runs the fixed quality suite against every verified-free, currently routable
 * model and writes a reproducible artifact. It is intentionally not part of
 * `npm run verify`: it needs live provider credentials and would spend free-tier
 * quota. Temperature is fixed at 0 by the router.
 *
 *   npm run benchmark -- --suite benchmarks/suite.json --out benchmarks/results/<name>.json
 */
function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function loadSuite(filePath: string): BenchmarkSuite {
  const parsed = BenchmarkSuite.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
  if (!parsed.success) {
    throw new Error(`benchmark suite ${filePath} does not match the suite schema`);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const suitePath = argument('--suite', 'benchmarks/suite.json');
  const outputPath = argument(
    '--out',
    path.join(
      'benchmarks',
      'results',
      `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    ),
  );
  const suite = loadSuite(suitePath);
  const config = loadConfig({
    ...(process.env.CODERAX_ENGINE_CONFIG ? { filePath: process.env.CODERAX_ENGINE_CONFIG } : {}),
  });
  const app = await composeApplication({ config });
  try {
    if (!app.modelRouter.hasVerifiedFreeRoute()) {
      throw new Error('no verified zero-cost model is routable; benchmark not run');
    }
    const models = app.modelRouter
      .list()
      .models.filter((model) => model.costClass === 'free' && model.availability.available);
    if (models.length === 0) throw new Error('no verified zero-cost model is routable');

    const results: Array<{
      providerId: string;
      modelId: string;
      samples: number;
      coding: number;
      reasoning: number;
      toolCalling?: number;
      latencyMs?: number;
    }> = [];

    for (const model of models) {
      const outcomes: TaskOutcome[] = [];
      for (const task of suite.tasks) {
        const permission = app.providerPolicy.evaluate({
          providerId: model.ref.providerId,
          operation: 'native_reasoning',
          mode: 'cloud',
          at: app.dependencies.clock.now(),
        });
        if (!permission.allowed) {
          process.stdout.write(
            `${model.ref.providerId}/${model.ref.modelId}: skipping model: ${permission.detail}\n`,
          );
          break;
        }
        const started = performance.now();
        try {
          const completion = await app.modelRouter.complete({
            ownerId: config.auth.ownerId,
            model: model.ref,
            mode: 'cloud',
            operation: 'native_reasoning',
            routing: 'auto',
            allowFallback: false,
            system:
              'Answer the benchmark task exactly. For tool tasks, call the named tool with the requested arguments.',
            prompt: task.prompt,
            ...(task.kind === 'tool' && task.expectedTool
              ? {
                  tools: [
                    {
                      name: task.expectedTool.name,
                      description: 'The benchmark tool.',
                      parameters: { type: 'object', additionalProperties: true },
                    },
                  ],
                }
              : {}),
            maxOutputTokens: 512,
            signal: AbortSignal.timeout(90_000),
          });
          outcomes.push({
            task,
            passed: gradeTask(task, {
              text: completion.text,
              toolCalls: completion.toolCalls as ToolCall[],
            }),
            latencyMs: performance.now() - started,
          });
        } catch (error) {
          outcomes.push({
            task,
            passed: false,
            latencyMs: performance.now() - started,
            ...(error instanceof Error ? { note: error.message } : {}),
          } as TaskOutcome);
        }
      }
      if (outcomes.length !== suite.tasks.length) continue;
      const score = scoreOutcomes(outcomes);
      const latency =
        outcomes.reduce((total, outcome) => total + outcome.latencyMs, 0) / outcomes.length;
      results.push({
        providerId: model.ref.providerId,
        modelId: model.ref.modelId,
        samples: score.samples,
        coding: score.coding,
        reasoning: score.reasoning,
        ...(score.toolCalling === undefined ? {} : { toolCalling: score.toolCalling }),
        latencyMs: Math.round(latency),
      });
      process.stdout.write(
        `${model.ref.providerId}/${model.ref.modelId}: coding=${score.coding.toFixed(2)} reasoning=${score.reasoning.toFixed(2)}${score.toolCalling === undefined ? '' : ` tools=${score.toolCalling.toFixed(2)}`}\n`,
      );
    }

    if (results.length === 0) {
      process.stdout.write('No model completed the suite under the current policy; no artifact was written.\n');
      return;
    }

    const artifact = buildArtifact({
      suite,
      capturedAt: new Date().toISOString(),
      results,
    });
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stdout.write(`suite=${suite.name} digest=${digestSuite(suite)} results=${outputPath}\n`);
  } finally {
    await app.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});

