import type { Planner, PlanStep } from './types.js';
import { buildPlanPrompt } from './prompt.js';

/**
 * A deterministic planner derives ordered steps from the objective's own
 * structure. It is always available, so Native can plan without a model and a
 * persisted plan is reproducible for verification.
 */
function createDeterministicPlanner(): Planner {
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

      return titles.slice(0, maxSteps).map((title, index) => ({
        id: `step-${index + 1}`,
        // Bounded so a pasted document cannot become an unbounded plan title.
        title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
      }));
    },
  };
}

/** Parses a model plan without trusting its shape or length. */
export function parsePlan(text: string, maxSteps: number): PlanStep[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const titles = parsed
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (typeof entry === 'object' && entry !== null) {
          const title = (entry as { title?: unknown }).title;
          if (typeof title === 'string') return title.trim();
        }
        return '';
      })
      .filter((title) => title.length > 0)
      .slice(0, maxSteps);
    if (titles.length === 0) return null;
    return titles.map((title, index) => ({
      id: `step-${index + 1}`,
      title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
    }));
  } catch {
    return null;
  }
}

/**
 * Model-assisted planning with a deterministic floor. A model plan is used only
 * when it parses and yields at least one step; otherwise the deterministic plan
 * is used, so a provider outage or a malformed answer never blocks a run.
 */
export function createNativePlanner(input?: { complete?: boolean }): Planner {
  const fallback = createDeterministicPlanner();
  return {
    plan: async ({ objective, maxSteps, history, complete, signal }) => {
      if (input?.complete !== false && complete && maxSteps > 1) {
        try {
          const text = await complete(
            buildPlanPrompt({ objective, maxSteps, ...(history ? { history } : {}) }),
            signal ?? new AbortController().signal,
          );
          const parsed = parsePlan(text, maxSteps);
          if (parsed) return parsed;
        } catch {
          // Fall through to the deterministic plan.
        }
      }
      return fallback.plan({ objective, maxSteps });
    },
  };
}
