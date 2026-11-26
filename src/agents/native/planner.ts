import type { Planner, PlanStep } from './types.js';
import { buildPlanPrompt } from './prompt.js';

/**
 * A deterministic planner derives ordered steps from the objective's own
 * structure. It is always available, so Native can plan without a model and a
 * persisted plan is reproducible for verification. Its dependencies are the
 * earlier steps, which is a valid DAG and the conservative default.
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

      return titles.slice(0, maxSteps).map((title, index) => ({
        id: `step-${index + 1}`,
        // Bounded so a pasted document cannot become an unbounded plan title.
        title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
        dependsOn: index === 0 ? [] : [`step-${index}`],
      }));
    },
  };
}

function normalizeDependency(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    // Preserve the reference even when it is out of range or self-referential.
    // The graph check then rejects the whole plan instead of silently dropping
    // an ordering constraint the model asked for.
    return `step-${raw}`;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}

/**
 * Parses a model plan without trusting its shape or length. Dependencies are
 * normalized to step ids; a self-reference or a forward-only cycle is dropped
 * here and the whole graph is rejected by `planGraphIssue` before execution.
 */
export function parsePlan(text: string, maxSteps: number): PlanStep[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const entries = parsed
      .map((entry) => {
        if (typeof entry === 'string') return { title: entry.trim(), dependsOn: [] as unknown[], criteria: undefined };
        if (typeof entry === 'object' && entry !== null) {
          const typed = entry as { title?: unknown; dependsOn?: unknown; successCriteria?: unknown };
          if (typeof typed.title !== 'string') return null;
          return {
            title: typed.title.trim(),
            dependsOn: Array.isArray(typed.dependsOn) ? typed.dependsOn : [],
            criteria: typeof typed.successCriteria === 'string' ? typed.successCriteria : undefined,
          };
        }
        return null;
      })
      .filter((entry): entry is { title: string; dependsOn: unknown[]; criteria: string | undefined } =>
        entry !== null && entry.title.length > 0,
      )
      .slice(0, maxSteps);
    if (entries.length === 0) return null;

    const steps: PlanStep[] = entries.map((entry, index) => {
      const dependsOn = [...new Set(
        entry.dependsOn
          .map((dependency) => normalizeDependency(dependency))
          .filter((dependency): dependency is string => dependency !== null),
      )];
      return {
        id: `step-${index + 1}`,
        title: entry.title.length > 200 ? `${entry.title.slice(0, 197)}...` : entry.title,
        dependsOn,
        ...(entry.criteria ? { successCriteria: entry.criteria.slice(0, 300) } : {}),
      };
    });
    return planGraphIssue(steps) === null ? steps : null;
  } catch {
    return null;
  }
}

/**
 * Rejects a plan that cannot be executed as a DAG: unknown dependencies,
 * duplicates, and cycles. Returning a message instead of throwing keeps this
 * usable from both the planner and the resume path, which must refuse a plan
 * written by an older run rather than execute it out of order.
 */
export function planGraphIssue(steps: PlanStep[]): string | null {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) return `The plan repeats step ${step.id}.`;
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) return `Step ${step.id} depends on unknown step ${dependency}.`;
      if (dependency === step.id) return `Step ${step.id} depends on itself.`;
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 'done') return false;
    if (current === 'visiting') return true;
    state.set(id, 'visiting');
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const step of steps) {
    if (visit(step.id)) return 'The plan contains a dependency cycle.';
  }
  return null;
}

/** Fills in the fields a persisted older plan may not carry. */
export function normalizePlan(steps: Array<{ id: string; title: string; dependsOn?: string[]; successCriteria?: string }>): PlanStep[] {
  return steps.slice(0, 64).map((step, index) => ({
    id: step.id.slice(0, 80) || `step-${index + 1}`,
    title: step.title.slice(0, 200),
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((entry) => typeof entry === 'string').slice(0, 16) : [],
    ...(step.successCriteria ? { successCriteria: step.successCriteria.slice(0, 300) } : {}),
  }));
}

/**
 * Model-assisted planning with a deterministic floor. A model plan is used only
 * when it parses and yields an executable graph; otherwise the deterministic
 * plan is used, so a provider outage or a malformed answer never blocks a run.
 */
export function createNativePlanner(input?: { complete?: boolean }): Planner {
  const fallback = createDeterministicPlanner();
  return {
    plan: async ({ objective, maxSteps, history, complete, signal }) => {
      if (input?.complete !== false && complete && maxSteps > 1) {
        try {
          const text = await complete(
            buildPlanPrompt({ objective, maxSteps, ...(history ? { history: [...history] } : {}) }),
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
