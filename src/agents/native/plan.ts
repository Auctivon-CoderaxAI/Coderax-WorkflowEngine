import type { Usage } from '@coderax/contracts';
import type {
  ReasoningMode,
  TaskPlan,
  TaskPlanStep,
} from '../../domain.js';
import type {
  BasicModelGateway,
  PlanInput,
  PlanOutcome,
  ReasoningPlanner,
  ReplanInput,
} from './types.js';
import {
  buildPlanPrompt,
  buildReplanPrompt,
  PLAN_SYSTEM,
  REPLAN_SYSTEM,
} from './prompt.js';

/**
 * The planner is pure with respect to execution: it returns a dependency graph,
 * never a provider call, file read or side effect. The deterministic planner is
 * always available, so Native can plan without an inference endpoint; the
 * model-assisted path is used only for complex reasoning and falls back with a
 * recorded note rather than pretending a model produced the plan.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_TITLE = 200;
const MAX_ACCEPTANCE = 300;
const MAX_TOOL_INPUT_BYTES = 20_000;
const MAX_TOOL_INPUT_KEYS = 24;

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
 * Validates a plan before anything executes. A missing dependency, a duplicate
 * id, a cycle or a read outside the workspace is refused, not repaired silently:
 * a plan that cannot be executed must not be shown as if it could.
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
  const readResources = new Set<string>();
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
    if (step.kind !== 'reason' && step.kind !== 'read' && step.kind !== 'tool') {
      return { ok: false, reason: `step "${step.id}" has an unsupported action` };
    }
    if (step.kind === 'read') {
      if (!step.resource || !resourceIsConfined(step.resource)) {
        return { ok: false, reason: `read step "${step.id}" has an invalid workspace resource` };
      }
      if (readResources.has(step.resource)) {
        return { ok: false, reason: `read resource "${step.resource}" is planned more than once` };
      }
      readResources.add(step.resource);
    } else if (step.kind === 'tool') {
      if (!step.resource || !TOOL_NAME_PATTERN.test(step.resource)) {
        return { ok: false, reason: `tool step "${step.id}" has an invalid tool name` };
      }
      if (step.input !== undefined) {
        const keys = Object.keys(step.input);
        if (keys.length > MAX_TOOL_INPUT_KEYS) {
          return { ok: false, reason: `tool step "${step.id}" has too many arguments` };
        }
        let serialized: string;
        try {
          serialized = JSON.stringify(step.input);
        } catch {
          return { ok: false, reason: `tool step "${step.id}" has unserializable arguments` };
        }
        if (serialized.length > MAX_TOOL_INPUT_BYTES) {
          return { ok: false, reason: `tool step "${step.id}" has oversized arguments` };
        }
      }
    } else {
      if (step.resource !== undefined) {
        return { ok: false, reason: `reason step "${step.id}" must not name a resource` };
      }
      if (step.input !== undefined) {
        return { ok: false, reason: `reason step "${step.id}" must not carry tool arguments` };
      }
    }
  }
  // Dependencies may appear in any array order; only the graph must be acyclic.
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

function extractJson(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function readString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Parses a model plan and validates it. A parse failure is not repaired with
 * invented steps; the caller falls back to the deterministic planner and records
 * why, or fails the run.
 */
export function parseModelPlan(input: {
  text: string;
  mode: ReasoningMode;
  maxSteps: number;
  revision: number;
  completedSteps: string[];
}): { ok: true; plan: TaskPlan } | { ok: false; reason: string } {
  const json = extractJson(input.text);
  if (!json) return { ok: false, reason: 'the model did not return a JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'the model plan was not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'the model plan was not an object' };
  }
  const record = parsed as { steps?: unknown; note?: unknown };
  if (!Array.isArray(record.steps)) {
    return { ok: false, reason: 'the model plan had no steps array' };
  }
  if (record.steps.length === 0 || record.steps.length > input.maxSteps) {
    return { ok: false, reason: `the model plan had ${record.steps.length} steps` };
  }

  const steps: TaskPlanStep[] = [];
  for (const [index, raw] of record.steps.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, reason: `step ${index + 1} was not an object` };
    }
    const entry = raw as Record<string, unknown>;
    const id = readString(entry.id, 80) ?? `step-${index + 1}`;
    const title = readString(entry.title, MAX_TITLE);
    if (!title) return { ok: false, reason: `step ${id} had no bounded title` };
    const kind =
      entry.kind === 'read'
        ? 'read'
        : entry.kind === 'reason'
          ? 'reason'
          : entry.kind === 'tool'
            ? 'tool'
            : null;
    if (!kind) return { ok: false, reason: `step ${id} had an unsupported kind` };
    if (entry.dependsOn !== undefined && !Array.isArray(entry.dependsOn)) {
      return { ok: false, reason: `step ${id} had a malformed dependency list` };
    }
    const dependsOn = Array.isArray(entry.dependsOn)
      ? entry.dependsOn.filter((value): value is string => typeof value === 'string')
      : [];
    if (Array.isArray(entry.dependsOn) && dependsOn.length !== entry.dependsOn.length) {
      return { ok: false, reason: `step ${id} had a non-string dependency` };
    }
    const acceptance = readString(entry.acceptance, MAX_ACCEPTANCE);
    const resource = readString(entry.resource, 512);
    let toolInput: Record<string, unknown> | undefined;
    if (kind === 'tool' && entry.input !== undefined) {
      if (typeof entry.input !== 'object' || entry.input === null || Array.isArray(entry.input)) {
        return { ok: false, reason: `step ${id} had malformed tool arguments` };
      }
      toolInput = entry.input as Record<string, unknown>;
    }
    steps.push({
      id,
      title,
      dependsOn,
      kind,
      ...(kind === 'read' && resource ? { resource } : {}),
      ...(kind === 'tool' && resource ? { resource } : {}),
      ...(kind === 'tool' && toolInput ? { input: toolInput } : {}),
      ...(acceptance ? { acceptance } : {}),
    });
  }

  const note = readString(record.note, 500);
  const plan: TaskPlan = {
    revision: input.revision,
    mode: input.mode,
    steps,
    ...(note ? { note } : {}),
  };
  const validation = validatePlan({
    plan,
    completedSteps: input.completedSteps,
    maxSteps: input.maxSteps,
  });
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, plan };
}

export function correctivePlan(input: {
  mode: ReasoningMode;
  revision: number;
  completedSteps: string[];
  failure: ReplanInput['failure'];
}): TaskPlan {
  const dependsOn = [...new Set(input.completedSteps)];
  const title =
    input.failure.reason === 'verification_failed'
      ? `Close the verification gap: ${truncate(input.failure.detail, 120)}`
      : `Correct the failed step: ${truncate(input.failure.detail, 120)}`;
  return {
    revision: input.revision,
    mode: input.mode,
    steps: [
      {
        id: `revision-${input.revision}-1`,
        title: truncate(title, MAX_TITLE),
        dependsOn,
        kind: 'reason',
        acceptance: 'Produce evidence that closes the reported gap without repeating a failure.',
      },
    ],
    note: 'Deterministic corrective plan; the model revision was unavailable or invalid.',
  };
}

async function modelPlan(input: {
  gateway: BasicModelGateway;
  planInput: PlanInput;
  system: string;
  prompt: string;
}): Promise<{ plan: TaskPlan; usage?: Usage; note?: string }> {
  try {
    const completion = await input.gateway.complete({
      model: input.planInput.model,
      system: input.system,
      prompt: input.prompt,
      ...(input.planInput.maxOutputTokens
        ? { maxOutputTokens: input.planInput.maxOutputTokens }
        : {}),
      signal: input.planInput.signal,
    });
    const parsed = parseModelPlan({
      text: completion.text,
      mode: input.planInput.mode,
      maxSteps: input.planInput.maxSteps,
      revision: 1,
      completedSteps: input.planInput.completedSteps,
    });
    if (!parsed.ok) {
      return {
        plan: deterministicPlan({
          objective: input.planInput.objective,
          mode: input.planInput.mode,
          maxSteps: input.planInput.maxSteps,
          note: `Model decomposition was rejected (${parsed.reason}); deterministic decomposition used.`,
        }),
        usage: completion.usage,
      };
    }
    return { plan: parsed.plan, usage: completion.usage };
  } catch {
    if (input.planInput.signal.aborted) throw new Error('cancelled');
    return {
      plan: deterministicPlan({
        objective: input.planInput.objective,
        mode: input.planInput.mode,
        maxSteps: input.planInput.maxSteps,
        note: 'Model decomposition was unavailable; deterministic decomposition used.',
      }),
    };
  }
}

export function createNativePlanner(input: {
  gateway: BasicModelGateway;
  maxSteps: number;
  /** A rendered tool catalogue; absent means Native has no tools to plan. */
  tools?: string;
}): ReasoningPlanner {
  return {
    plan: async (planInput): Promise<PlanOutcome> => {
      const maxSteps = Math.min(planInput.maxSteps, input.maxSteps);
      if (planInput.mode === 'fast') {
        return { plan: deterministicPlan({ objective: planInput.objective, mode: 'fast', maxSteps }) };
      }
      const attempt = await modelPlan({
        gateway: input.gateway,
        planInput: { ...planInput, maxSteps },
        system: PLAN_SYSTEM,
        prompt: buildPlanPrompt({
          objective: planInput.objective,
          history: planInput.history,
          maxSteps,
          ...(input.tools ? { tools: input.tools } : {}),
        }),
      });
      return {
        plan: attempt.plan,
        ...(attempt.usage ? { usage: attempt.usage } : {}),
      };
    },

    replan: async (replanInput): Promise<PlanOutcome> => {
      const maxSteps = Math.min(replanInput.maxSteps, input.maxSteps);
      const revision = replanInput.plan.revision + 1;
      let usage: Usage | undefined;
      let plan: TaskPlan;
      if (replanInput.mode === 'fast') {
        plan = correctivePlan({
          mode: 'fast',
          revision,
          completedSteps: replanInput.completedSteps,
          failure: replanInput.failure,
        });
      } else {
        let text: string;
        try {
          const completion = await input.gateway.complete({
            model: replanInput.model,
            system: REPLAN_SYSTEM,
            prompt: buildReplanPrompt({
              objective: replanInput.objective,
              history: replanInput.history,
              plan: replanInput.plan,
              completedSteps: replanInput.completedSteps,
              evidence: replanInput.evidence,
              failure: replanInput.failure,
              maxSteps,
              ...(input.tools ? { tools: input.tools } : {}),
            }),
            ...(replanInput.maxOutputTokens
              ? { maxOutputTokens: replanInput.maxOutputTokens }
              : {}),
            signal: replanInput.signal,
          });
          text = completion.text;
          usage = completion.usage;
        } catch {
          if (replanInput.signal.aborted) throw new Error('cancelled');
          plan = correctivePlan({
            mode: 'complex',
            revision,
            completedSteps: replanInput.completedSteps,
            failure: replanInput.failure,
          });
          return { plan };
        }
        const parsed = parseModelPlan({
          text,
          mode: 'complex',
          maxSteps,
          revision,
          completedSteps: replanInput.completedSteps,
        });
        plan = parsed.ok
          ? parsed.plan
          : correctivePlan({
              mode: 'complex',
              revision,
              completedSteps: replanInput.completedSteps,
              failure: replanInput.failure,
            });
      }

      // A revision may only add work that is not already complete.
      const completed = new Set(replanInput.completedSteps);
      const remaining = plan.steps.filter((step) => !completed.has(step.id));
      if (remaining.length === 0) {
        return {
          plan: correctivePlan({
            mode: replanInput.mode,
            revision,
            completedSteps: replanInput.completedSteps,
            failure: replanInput.failure,
          }),
          ...(usage ? { usage } : {}),
        };
      }
      return {
        plan: { ...plan, revision, steps: remaining },
        ...(usage ? { usage } : {}),
      };
    },
  };
}
