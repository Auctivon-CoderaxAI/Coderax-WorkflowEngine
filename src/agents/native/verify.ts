import type { Usage } from '@coderax/contracts';
import type { TaskPlan, TaskVerification } from '../../domain.js';
import type {
  BasicModelGateway,
  ReasoningMode,
  StepEvidence,
  TaskPlanStep,
} from './types.js';
import {
  buildVerificationPrompt,
  renderEvidence,
  VERIFY_SYSTEM,
} from './prompt.js';

/**
 * Completion is a claim about evidence, not about a model's confidence.
 *
 * A deterministic assessment runs first: every planned step must be complete,
 * every step must have produced evidence, and the evidence must be non-empty.
 * Only then is a model asked whether that evidence proves the objective, and its
 * answer is accepted only when it cites real evidence ids. A malformed answer or
 * an uncited "passed" is a failed verification, never a success.
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
  evidence: StepEvidence[];
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
    if (!entry || entry.citation.trim().length === 0) {
      withoutEvidence.push(step);
    }
  }

  const citations = input.plan.steps
    .map((step) => byId.get(step.id))
    .filter(
      (entry): entry is StepEvidence =>
        entry !== undefined && entry.citation.trim().length > 0,
    )
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

function citedEvidence(
  cited: string[],
  evidence: StepEvidence[],
): string[] {
  const byId = new Map(evidence.map((entry) => [entry.stepId, entry]));
  return cited
    .map((id) => byId.get(id))
    .filter((entry): entry is StepEvidence => Boolean(entry))
    .map((entry) => clamp(`${entry.stepId}: ${entry.citation}`, MAX_EVIDENCE_CHARS))
    .slice(0, MAX_EVIDENCE);
}

export type VerificationResult = {
  verification: TaskVerification;
  usage?: Usage;
};

export async function verifyObjective(input: {
  gateway: BasicModelGateway;
  model: Parameters<BasicModelGateway['complete']>[0]['model'];
  signal: AbortSignal;
  objective: string;
  mode: ReasoningMode;
  maxOutputTokens?: number;
  plan: TaskPlan;
  completed: ReadonlySet<string>;
  evidence: StepEvidence[];
}): Promise<VerificationResult> {
  const structural = structuralAssessment({
    plan: input.plan,
    completed: input.completed,
    evidence: input.evidence,
  });
  if (!structural.passed) return { verification: structural };

  // A blank citation cannot support a verdict. Keep it out of the prompt, the
  // citable set and the returned evidence alike.
  const usable = input.evidence.filter((entry) => entry.citation.trim().length > 0);

  try {
    const completion = await input.gateway.complete({
      model: input.model,
      system: VERIFY_SYSTEM,
      prompt: buildVerificationPrompt({
        objective: input.objective,
        mode: input.mode,
        plan: input.plan,
        completed: input.completed,
        evidence: usable,
        structuralReason: structural.reason,
      }),
      signal: input.signal,
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    });
    const parsed = parseVerification(
      completion.text,
      new Set(usable.map((entry) => entry.stepId)),
    );
    if (!parsed) {
      return {
        verification: {
          passed: false,
          reason: 'The verifier did not return a valid evidence-based assessment.',
          evidence: structural.evidence,
        },
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    }
    if (!parsed.passed) {
      return {
        verification: {
          passed: false,
          reason: clamp(parsed.reason, 1000),
          evidence: structural.evidence,
        },
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    }
    if (parsed.cited.length === 0) {
      return {
        verification: {
          passed: false,
          reason: 'The verifier passed the objective without citing any evidence.',
          evidence: structural.evidence,
        },
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    }
    return {
      verification: {
        passed: true,
        reason: clamp(parsed.reason, 1000),
        evidence: citedEvidence(parsed.cited, usable),
      },
      ...(completion.usage ? { usage: completion.usage } : {}),
    };
  } catch {
    return {
      verification: {
        passed: false,
        reason: 'The verification call failed, so completion could not be assessed.',
        evidence: structural.evidence,
      },
    };
  }
}

export function verificationSummaryText(verification: TaskVerification): string {
  return `Verification: ${verification.passed ? 'passed' : 'failed'} — ${verification.reason}`;
}

export function evidenceForPrompt(evidence: StepEvidence[]): string {
  return renderEvidence(evidence);
}
