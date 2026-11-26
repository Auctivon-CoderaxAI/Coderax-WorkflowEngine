import type { TaskEvidence, TaskPlan, TaskPlanStep, TaskVerification } from '../../domain.js';

/**
 * Completion is a claim about evidence, not about a model's confidence.
 *
 * The deterministic assessment runs first: every planned step must be complete
 * and must have produced non-empty evidence. A model may then assess whether the
 * evidence proves the objective, but its answer is accepted only when it cites
 * real evidence ids. An uncited pass is a failed verification. Teams use the
 * structural half only and never ask a model for a verdict.
 */

const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_CHARS = 500;

export function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

export function structuralAssessment(input: {
  plan: TaskPlan;
  completed: ReadonlySet<string>;
  evidence: TaskEvidence[];
}): TaskVerification {
  const byId = new Map(input.evidence.map((entry) => [entry.stepId, entry]));
  const missing: TaskPlanStep[] = [];
  const withoutEvidence: TaskPlanStep[] = [];

  for (const step of input.plan.steps) {
    if (!input.completed.has(step.id)) {
      missing.push(step);
      continue;
    }
    const entry = byId.get(step.id);
    if (!entry || entry.citation.trim().length === 0 || entry.output.trim().length === 0) {
      withoutEvidence.push(step);
    }
  }

  const citations = input.plan.steps
    .map((step) => byId.get(step.id))
    .filter((entry): entry is TaskEvidence => Boolean(entry))
    .map((entry) => clamp(`${entry.stepId}: ${entry.citation}`, MAX_EVIDENCE_CHARS))
    .slice(0, MAX_EVIDENCE);

  if (missing.length > 0) {
    return {
      passed: false,
      reason: clamp(
        `Not every planned step completed: ${missing.map((step) => step.id).join(', ')}.`,
        1000,
      ),
      evidence: citations,
    };
  }
  if (withoutEvidence.length > 0) {
    return {
      passed: false,
      reason: clamp(
        `These steps completed without evidence: ${withoutEvidence
          .map((step) => step.id)
          .join(', ')}.`,
        1000,
      ),
      evidence: citations,
    };
  }
  if (input.plan.steps.length === 0) {
    return { passed: false, reason: 'The plan has no steps to verify.', evidence: [] };
  }
  return {
    passed: true,
    reason: 'Every planned step completed and produced evidence.',
    evidence: citations,
  };
}

export type ParsedVerification = {
  passed: boolean;
  reason: string;
  cited: string[];
};

function extractJson(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

/**
 * A pass is accepted only with a bounded reason and citations of evidence that
 * actually exists. `VERDICT: PASS` in prose has no path through this parser.
 */
export function parseVerification(
  text: string,
  knownSteps: ReadonlySet<string>,
): ParsedVerification | null {
  const json = extractJson(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { passed?: unknown; reason?: unknown; cited?: unknown };
  if (typeof record.passed !== 'boolean') return null;
  if (typeof record.reason !== 'string') return null;
  const reason = record.reason.trim();
  if (reason.length === 0 || reason.length > 1000) return null;
  const cited = Array.isArray(record.cited)
    ? record.cited.filter((value): value is string => typeof value === 'string')
    : [];
  if (Array.isArray(record.cited) && cited.length !== record.cited.length) return null;
  if (cited.some((id) => !knownSteps.has(id))) return null;
  return { passed: record.passed, reason, cited: [...new Set(cited)] };
}
