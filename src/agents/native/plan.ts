import type { ReasoningMode, TaskPlan, TaskPlanStep } from '../../domain.js';

/**
 * Plan validation is the gate every plan passes before anything executes.
 *
 * It is pure: it reads a graph and returns a verdict. A missing dependency, a
 * duplicate id, a cycle or a resource outside the workspace is refused, never
 * repaired silently. The team planner builds a TaskPlan from its members and
 * calls this function, so the same rules guard a single-agent plan and a team.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TITLE = 200;
const MAX_ACCEPTANCE = 300;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

/** Splits an objective on explicit structure only; never invents sub-objectives. */
export function splitObjective(objective: string): string[] {
  return objective
    .split(/\r?\n|;\s*/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

export function deterministicPlan(input: {
  objective: string;
  mode: ReasoningMode;
  maxSteps: number;
  revision?: number;
  note?: string;
}): TaskPlan {
  const clauses = splitObjective(input.objective);
  const titles =
    clauses.length > 1
      ? clauses.slice(0, input.maxSteps)
      : input.mode === 'fast'
        ? ['Produce the requested result']
        : ['Analyze the objective and its constraints', 'Produce the requested result'];

  const bounded = titles.slice(0, input.maxSteps);
  const steps: TaskPlanStep[] = bounded.map((title, index) => ({
    id: `step-${index + 1}`,
    title: truncate(title, MAX_TITLE),
    dependsOn: index === 0 ? [] : [`step-${index}`],
    kind: 'reason',
    acceptance:
      index === bounded.length - 1
        ? 'Address the objective directly and state the result.'
        : 'Produce the intermediate result this step exists for.',
  }));

  return {
    revision: input.revision ?? 1,
    mode: input.mode,
    steps,
    ...(input.note ? { note: truncate(input.note, 500) } : {}),
  };
}

function hasCycle(steps: TaskPlanStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const step = byId.get(id);
    if (!step) return false;
    visiting.add(id);
    for (const dependency of step.dependsOn) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return steps.some((step) => visit(step.id));
}

export function resourceIsConfined(resource: string): boolean {
  if (resource.length === 0 || resource.length > 512) return false;
  if (resource.startsWith('/') || resource.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(resource)) return false;
  const segments = resource.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Validates a plan before anything executes. A malformed dependency list is a
 * refusal, not "no dependencies": reading it as empty would run a dependent step
 * before the work it needs.
 */
export function validatePlan(input: {
  plan: TaskPlan;
  completedSteps: string[];
  maxSteps: number;
}): { ok: true } | { ok: false; reason: string } {
  const { plan } = input;
  if (!Number.isInteger(plan.revision) || plan.revision < 1) {
    return { ok: false, reason: 'plan revision must be a positive integer' };
  }
  if (plan.mode !== 'fast' && plan.mode !== 'complex') {
    return { ok: false, reason: 'plan mode is not a reasoning mode' };
  }
  if (plan.steps.length === 0) {
    return { ok: false, reason: 'plan has no steps' };
  }
  if (plan.steps.length > input.maxSteps) {
    return { ok: false, reason: `plan has more than ${input.maxSteps} steps` };
  }

  const completed = new Set(input.completedSteps);
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!ID_PATTERN.test(step.id)) {
      return { ok: false, reason: `step id "${step.id}" is not a stable identifier` };
    }
    if (ids.has(step.id)) {
      return { ok: false, reason: `step id "${step.id}" is duplicated` };
    }
    ids.add(step.id);
    if (step.title.trim().length === 0 || step.title.length > MAX_TITLE) {
      return { ok: false, reason: `step "${step.id}" has an invalid title` };
    }
    if (step.acceptance !== undefined && step.acceptance.length > MAX_ACCEPTANCE) {
      return { ok: false, reason: `step "${step.id}" has an oversized acceptance criterion` };
    }
    if (step.kind !== 'reason' && step.kind !== 'read') {
      return { ok: false, reason: `step "${step.id}" has an unsupported action` };
    }
    if (step.kind === 'read') {
      if (!step.resource || !resourceIsConfined(step.resource)) {
        return { ok: false, reason: `read step "${step.id}" has an invalid workspace resource` };
      }
    } else if (step.resource !== undefined) {
      return { ok: false, reason: `reason step "${step.id}" must not name a resource` };
    }
  }
  for (const step of plan.steps) {
    const seenDependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) {
        return { ok: false, reason: `step "${step.id}" depends on itself` };
      }
      if (seenDependencies.has(dependency)) {
        return { ok: false, reason: `step "${step.id}" repeats dependency "${dependency}"` };
      }
      seenDependencies.add(dependency);
      if (!ids.has(dependency) && !completed.has(dependency)) {
        return { ok: false, reason: `step "${step.id}" depends on unknown "${dependency}"` };
      }
    }
  }
  if (hasCycle(plan.steps)) {
    return { ok: false, reason: 'plan dependencies contain a cycle' };
  }
  return { ok: true };
}
