import type { Planner, PlanStep } from './types.js';

/**
 * A deterministic planner: it derives ordered steps from the objective's own
 * structure. It is intentionally not a model call, so Native always has a usable
 * plan even when no inference endpoint is configured, and a persisted plan is
 * reproducible for verification. A model-assisted planner can replace it behind
 * the same port.
 */
export function createDeterministicPlanner(): Planner {
  return {
    plan: ({ objective, maxSteps }) => {
      const explicit = objective
        .split(/\r?\n|;\s*/)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter((line) => line.length > 0);

      const titles =
        explicit.length > 1
          ? explicit.slice(0, maxSteps)
          : ['Interpret the objective', 'Execute the work', 'Verify the result'];

      const steps: PlanStep[] = titles.map((title, index) => ({
        id: `step-${index + 1}`,
        // Bounded so a pasted document cannot become an unbounded plan title.
        title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
      }));
      return steps.slice(0, maxSteps);
    },
  };
}
