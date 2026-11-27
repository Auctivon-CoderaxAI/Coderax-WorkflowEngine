import type { ReasoningMode } from '../../domain.js';
import { splitObjective } from './plan.js';
import type { NativeLimits } from './types.js';

/**
 * Fast mode keeps a single reasoning path and one verification. Complex mode
 * decomposes, parallelises independent steps, verifies the objective and may
 * revise the plan within the configured bounds. `auto` chooses from the
 * objective's own structure; it never upgrades silently at execution time.
 */
export function resolveReasoningMode(input: {
  requested?: 'auto' | 'fast' | 'complex';
  objective: string;
}): ReasoningMode {
  if (input.requested === 'fast' || input.requested === 'complex') return input.requested;

  const clauses = splitObjective(input.objective);
  const words = input.objective.trim().split(/\s+/).filter(Boolean).length;
  const structured =
    clauses.length > 1 ||
    /\r?\n/.test(input.objective) ||
    /;\s/.test(input.objective) ||
    /(^|\n)\s*(?:\d+[.)]|[-*])\s/.test(input.objective) ||
    /\band then\b/i.test(input.objective);

  return structured || words > 60 || input.objective.length > 400 ? 'complex' : 'fast';
}

/**
 * Bounds are part of the mode. Fast may not grow into an unbounded autonomous
 * loop, and complex may not exceed the configured attempt, replan or iteration
 * budget.
 */
export function limitsFor(mode: ReasoningMode, base: NativeLimits): NativeLimits {
  if (mode === 'fast') {
    return {
      maxSteps: Math.min(base.maxSteps, 4),
      maxParallelSteps: 1,
      maxReplans: 0,
      maxStepAttempts: base.maxStepAttempts,
      maxIterations: Math.min(base.maxIterations, 8),
    };
  }
  return { ...base };
}
