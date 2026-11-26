import type { Availability, EngineCapabilities, PermissionScope, Usage } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';
import type {
  ReasoningMode,
  TaskPlan,
  TaskPlanStep,
  TaskVerification,
} from '../../domain.js';
import type {
  ActionAuthorizer,
  ActionExecutor,
  ModelGateway,
  NativeLimits,
  Planner,
  StepActionFailure,
  StepEvidence,
} from './types.js';
import { createNativePlanner, validatePlan } from './plan.js';
import { createNativeExecutor } from './actions.js';
import { planWaves } from './schedule.js';
import { resolveReasoningMode, limitsFor } from './reason.js';
import { decideCorrection, pause, toFailureCode } from './errors.js';
import {
  structuralAssessment,
  verificationSummaryText,
  verifyObjective,
} from './verify.js';

/**
 * Coderax Native's independent reasoning loop.
 *
 * Planning is a separate port that returns data. Execution is a separate port
 * that performs one action. Every action is authorized before the executor sees
 * it, and a scoped action cannot run on Native's own authority. Verification is
 * structural first and model-assisted second; a run reports `completed` only
 * when the evidence proves the objective, and a run that needs an owner decision
 * stops at `approval_required` instead of inventing the grant.
 */

const DEFAULT_LIMITS: NativeLimits = {
  maxSteps: 12,
  maxParallelSteps: 3,
  maxReplans: 2,
  maxStepAttempts: 2,
  maxIterations: 32,
};

const MAX_OUTPUT_CONTEXT = 4_000;
const REASONING_PAUSE_MS = 50;

class IterationLimitError extends Error {
  constructor(readonly limit: number) {
    super(`iteration bound ${limit} exhausted`);
    this.name = 'IterationLimitError';
  }
}

function normalizeLimits(partial?: Partial<NativeLimits>): NativeLimits {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const resolved = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, resolved));
  };
  return {
    maxSteps: clamp(partial?.maxSteps, DEFAULT_LIMITS.maxSteps, 1, 64),
    maxParallelSteps: clamp(partial?.maxParallelSteps, DEFAULT_LIMITS.maxParallelSteps, 1, 8),
    maxReplans: clamp(partial?.maxReplans, DEFAULT_LIMITS.maxReplans, 0, 5),
    maxStepAttempts: clamp(partial?.maxStepAttempts, DEFAULT_LIMITS.maxStepAttempts, 1, 3),
    maxIterations: clamp(partial?.maxIterations, DEFAULT_LIMITS.maxIterations, 1, 128),
  };
}

/** Without a permission authority, Native can reason but cannot grant a scope. */
const denyScoped: ActionAuthorizer = {
  authorize: async ({ scope }) =>
    scope === null ? { decision: 'allowed' } : { decision: 'denied' },
};

type StepRunResult =
  | { kind: 'completed' }
  | { kind: 'failed'; failure: StepActionFailure }
  | { kind: 'approval'; requestId: string }
  | { kind: 'cancelled' };

function mergeReplannedPlan(input: {
  current: TaskPlan;
  revised: TaskPlan;
  completed: ReadonlySet<string>;
}): TaskPlan {
  const completedSteps = input.current.steps.filter((step) => input.completed.has(step.id));
  const completedIds = new Set(completedSteps.map((step) => step.id));
  const additions = input.revised.steps.filter(
    (step) => !completedIds.has(step.id) && !input.completed.has(step.id),
  );
  return {
    revision: input.current.revision + 1,
    mode: input.current.mode,
    steps: [...completedSteps, ...additions],
    ...(input.revised.note ? { note: input.revised.note } : {}),
  };
}

export function createNativeAgent(input: {
  enabled: boolean;
  gateway: ModelGateway | null;
  planner?: Planner;
  executor?: ActionExecutor;
  authorizer?: ActionAuthorizer;
  limits?: Partial<NativeLimits>;
  unavailableDetail?: string;
}): AgentAdapter {
  const limits = normalizeLimits(input.limits);
  const gateway = input.gateway;
  const planner =
    input.planner ??
    (gateway ? createNativePlanner({ gateway, maxSteps: limits.maxSteps }) : null);
  const executor = input.executor ?? (gateway ? createNativeExecutor(gateway) : null);
  const authorizer = input.authorizer ?? denyScoped;

  const capabilities: EngineCapabilities = {
    streaming: true,
    tools: false,
    cancellation: true,
    resume: true,
    modelSelection: true,
    durable: true,
  };

  function availability(): Availability {
    if (!input.enabled) {
      return { available: false, reason: 'disabled', detail: 'Coderax Native is disabled.' };
    }
    if (!gateway || !planner || !executor) {
      return {
        available: false,
        reason: 'not_configured',
        detail:
          input.unavailableDetail ??
          'No zero-cost inference endpoint is configured for Coderax Native.',
      };
    }
    return { available: true, reason: 'ready', detail: 'Coderax Native is ready.' };
  }

  return {
    agent: 'coderax',
    engine: 'native',
    capabilities,
    isolation: {
      workspace: 'isolated',
      memory: 'granted',
      credentials: 'none',
      conversations: 'granted',
    },
    availability,
    probe: async () => {
      // Native's readiness is its configuration: there is no remote endpoint to
      // ask, and calling the model to prove it works would spend the budget on
      // every health check.
      const status = availability();
      return { ok: status.available, detail: status.detail };
    },

    run: async (request: AgentRunRequest, report: AgentReport): Promise<AgentRunOutcome> => {
      const status = availability();
      if (!status.available) {
        return {
          ok: false,
          code: status.reason === 'disabled' ? 'disabled' : 'not_configured',
          detail: status.detail,
          retryable: false,
        };
      }
      if (!gateway || !planner || !executor) {
        return {
          ok: false,
          code: 'not_configured',
          detail: status.detail,
          retryable: false,
        };
      }

      const cancelled = (): AgentRunOutcome => ({
        ok: false,
        code: 'cancelled',
        detail: 'The run was cancelled.',
        retryable: false,
      });

      /**
       * Chat is one answer, not a Work objective: it goes through the permission
       * and execution layers once and is not planned or verification-assessed.
       * Work is the path that carries a durable plan, evidence and completion.
       */
      if (!request.taskId) {
        const chatStep: TaskPlanStep = {
          id: 'chat',
          title: 'Answer the owner',
          dependsOn: [],
          kind: 'reason',
        };
        const decision = await authorizer.authorize({
          taskId: '',
          ownerId: request.ownerId,
          agent: 'coderax',
          scope: null,
          resource: 'chat',
          description: 'Answer this Chat turn.',
        });
        if (decision.decision !== 'allowed' && decision.decision !== 'approved') {
          return {
            ok: false,
            code: 'workspace_denied',
            detail: 'This Chat turn is not authorized.',
            retryable: false,
          };
        }
        if (request.signal.aborted) return cancelled();
        const execution = await executor.execute({
          step: chatStep,
          objective: request.objective,
          mode: 'fast',
          history: request.history ?? [],
          evidence: [],
          workspaceRoot: request.workspaceRoot,
          model: request.model,
          signal: request.signal,
        });
        if (!execution.ok) {
          return {
            ok: false,
            code: toFailureCode(execution.failure),
            detail: execution.failure.detail,
            retryable: execution.failure.retryable,
          };
        }
        return {
          ok: true,
          summary: execution.text,
          ...(execution.usage ? { usage: execution.usage } : {}),
        };
      }

      const mode: ReasoningMode =
        request.plan?.mode ??
        resolveReasoningMode({ requested: request.reasoning, objective: request.objective });
      const activeLimits = limitsFor(mode, limits);
      const maxSteps = Math.max(1, Math.min(request.maxSteps, activeLimits.maxSteps));
      const evidence = new Map<string, StepEvidence>(
        (request.evidence ?? []).map((entry) => [entry.stepId, entry]),
      );
      // A completed step without persisted evidence cannot be verified or used as
      // context, so it is re-executed rather than trusted. Both Native actions
      // are idempotent, so this is safe.
      const completed = new Set<string>(
        (request.completedSteps ?? []).filter((id) => evidence.has(id)),
      );
      let emittedSections = 0;

      let plan: TaskPlan | null = request.plan ?? null;
      if (plan) {
        const validation = validatePlan({
          plan,
          completedSteps: [...completed],
          maxSteps,
        });
        if (!validation.ok) {
          return {
            ok: false,
            code: 'protocol_error',
            detail: `The persisted plan cannot be resumed safely: ${validation.reason}`,
            retryable: false,
          };
        }
      }

      let iterations = 0;
      let replans = 0;
      let usageIn: number | undefined;
      let usageOut: number | undefined;

      const spend = (): void => {
        iterations += 1;
        if (iterations > activeLimits.maxIterations) {
          throw new IterationLimitError(activeLimits.maxIterations);
        }
      };
      const accumulate = (usage: Usage | undefined): void => {
        if (usage?.inputTokens !== undefined) usageIn = (usageIn ?? 0) + usage.inputTokens;
        if (usage?.outputTokens !== undefined) usageOut = (usageOut ?? 0) + usage.outputTokens;
      };
      const usage = (): Usage | undefined =>
        usageIn !== undefined || usageOut !== undefined
          ? {
              ...(usageIn !== undefined ? { inputTokens: usageIn } : {}),
              ...(usageOut !== undefined ? { outputTokens: usageOut } : {}),
            }
          : undefined;

      const executeStep = async (step: TaskPlanStep): Promise<StepRunResult> => {
        if (completed.has(step.id)) return { kind: 'completed' };

        const scope: PermissionScope | null = step.kind === 'read' ? 'workspace.read' : null;
        const resource =
          step.kind === 'read' ? step.resource ?? '' : `step:${step.id}`;
        const description =
          step.kind === 'read'
            ? `Read "${resource}" from the ${request.mode} workspace to ground this step.`
            : `Execute planned reasoning step "${step.title}".`;

        // Every action, including a plain reasoning step, passes the permission
        // layer. A null scope is allowed only because the owner already
        // authorized this Native run; a scoped action needs a stored grant.
        const authorization = await authorizer.authorize({
          taskId: request.taskId ?? '',
          ownerId: request.ownerId,
          agent: 'coderax',
          scope,
          resource,
          description,
        });
        if (authorization.decision === 'requested' || authorization.decision === 'pending') {
          if (scope) {
            report({
              type: 'approval.required',
              requestId: authorization.requestId,
              tool: scope,
              description,
            });
          }
          return { kind: 'approval', requestId: authorization.requestId };
        }
        if (authorization.decision === 'denied') {
          return {
            kind: 'failed',
            failure: {
              code: 'workspace_denied',
              detail:
                scope === 'workspace.read'
                  ? 'The owner did not authorize that workspace read.'
                  : 'The owner did not authorize this planned action.',
              retryable: false,
            },
          };
        }

        report({ type: 'step.started', stepId: step.id, title: step.title });
        let attempts = 0;
        let feedback: string | undefined;

        for (;;) {
          if (request.signal.aborted) return { kind: 'cancelled' };
          attempts += 1;
          spend();
          const execution = await executor.execute({
            step,
            objective: request.objective,
            mode,
            history: request.history ?? [],
            evidence: [...evidence.values()],
            workspaceRoot: request.workspaceRoot,
            model: request.model,
            signal: request.signal,
            ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
            ...(feedback ? { feedback } : {}),
          });

          if (execution.ok) {
            accumulate(execution.usage);
            const entry: StepEvidence = {
              stepId: step.id,
              title: step.title,
              output: execution.text.slice(0, MAX_OUTPUT_CONTEXT),
              citation: (execution.citation ?? execution.text).slice(0, 500),
              attempts,
            };
            evidence.set(step.id, entry);
            completed.add(step.id);
            // The engine's transcript and live stream are built from real step
            // output only; a step that did not execute never contributes text.
            report({
              type: 'text.delta',
              text: `${emittedSections === 0 ? '' : '\n\n'}${entry.output}`,
            });
            emittedSections += 1;
            report({
              type: 'step.completed',
              stepId: step.id,
              title: step.title,
              attempts,
              evidence: entry,
            });
            return { kind: 'completed' };
          }

          if (request.signal.aborted) return { kind: 'cancelled' };
          const correction = decideCorrection({
            failure: execution.failure,
            attempts,
            maxAttempts: activeLimits.maxStepAttempts,
          });
          if (correction === 'fail') {
            report({
              type: 'step.failed',
              stepId: step.id,
              title: step.title,
              detail: execution.failure.detail,
            });
            return { kind: 'failed', failure: execution.failure };
          }
          if (correction === 'correct') feedback = execution.failure.detail;
          await pause(REASONING_PAUSE_MS, request.signal);
        }
      };

      try {
        if (!plan) {
          spend();
          const planned = await planner.plan({
            objective: request.objective,
            history: request.history ?? [],
            model: request.model,
            mode,
            completedSteps: [...completed],
            maxSteps,
            signal: request.signal,
          });
          accumulate(planned.usage);
          const validation = validatePlan({
            plan: planned.plan,
            completedSteps: [...completed],
            maxSteps,
          });
          if (!validation.ok) {
            return {
              ok: false,
              code: 'protocol_error',
              detail: `The planner produced an invalid plan: ${validation.reason}`,
              retryable: false,
            };
          }
          plan = planned.plan;
          report({ type: 'plan.ready', plan });
        }

        // `activePlan` is the single plan this run executes; replanning replaces
        // it and reports the revision before any new step starts.
        let activePlan: TaskPlan = plan;
        let verification: TaskVerification | null = null;

        for (;;) {
          if (request.signal.aborted) return cancelled();
          const schedule = planWaves({
            steps: activePlan.steps,
            completed,
            maxParallel: activeLimits.maxParallelSteps,
          });
          if (!schedule.ok) {
            return {
              ok: false,
              code: 'protocol_error',
              detail: schedule.reason,
              retryable: false,
            };
          }

          const wave = schedule.waves[0] ?? [];
          if (wave.length === 0) {
            spend();
            const assessed = await verifyObjective({
              gateway,
              model: request.model,
              signal: request.signal,
              objective: request.objective,
              mode,
              ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
              plan: activePlan,
              completed,
              evidence: [...evidence.values()],
            });
            accumulate(assessed.usage);
            verification = assessed.verification;

            if (verification.passed) break;

            if (mode === 'complex' && replans < activeLimits.maxReplans) {
              replans += 1;
              spend();
              const revised = await planner.replan({
                objective: request.objective,
                history: request.history ?? [],
                model: request.model,
                mode,
                plan: activePlan,
                completedSteps: [...completed],
                evidence: [...evidence.values()],
                failure: {
                  reason: 'verification_failed',
                  detail: verification.reason,
                },
                maxSteps,
                signal: request.signal,
              });
              accumulate(revised.usage);
              const merged = mergeReplannedPlan({ current: activePlan, revised: revised.plan, completed });
              const validation = validatePlan({
                plan: merged,
                completedSteps: [...completed],
                maxSteps,
              });
              if (!validation.ok || merged.steps.every((step) => completed.has(step.id))) {
                return {
                  ok: false,
                  code: 'verification_failed',
                  detail: verification.reason,
                  retryable: false,
                  ...(usage() ? { usage: usage() } : {}),
                };
              }
              activePlan = merged;
              report({ type: 'plan.ready', plan: activePlan });
              continue;
            }

            return {
              ok: false,
              code: 'verification_failed',
              detail: verification.reason,
              retryable: false,
              ...(usage() ? { usage: usage() } : {}),
            };
          }

          const results = await Promise.all(wave.map((step) => executeStep(step)));
          const approval = results.find((result) => result.kind === 'approval');
          if (approval) {
            return {
              ok: false,
              code: 'approval_required',
              detail: 'Owner approval is required before the plan can continue.',
              retryable: false,
              ...(usage() ? { usage: usage() } : {}),
            };
          }
          if (results.some((result) => result.kind === 'cancelled')) {
            return cancelled();
          }

          const failed = results.find(
            (result): result is Extract<StepRunResult, { kind: 'failed' }> =>
              result.kind === 'failed',
          );
          if (failed) {
            const correctable =
              failed.failure.code === 'provider_error' || failed.failure.code === 'invalid_output';
            if (mode === 'complex' && correctable && replans < activeLimits.maxReplans) {
              replans += 1;
              spend();
              const revised = await planner.replan({
                objective: request.objective,
                history: request.history ?? [],
                model: request.model,
                mode,
                plan: activePlan,
                completedSteps: [...completed],
                evidence: [...evidence.values()],
                failure: {
                  reason: 'step_failed',
                  detail: failed.failure.detail,
                  ...(wave.length === 1 && wave[0] ? { stepId: wave[0].id } : {}),
                },
                maxSteps,
                signal: request.signal,
              });
              accumulate(revised.usage);
              const merged = mergeReplannedPlan({ current: activePlan, revised: revised.plan, completed });
              const validation = validatePlan({
                plan: merged,
                completedSteps: [...completed],
                maxSteps,
              });
              if (!validation.ok || merged.steps.every((step) => completed.has(step.id))) {
                return {
                  ok: false,
                  code: toFailureCode(failed.failure),
                  detail: failed.failure.detail,
                  retryable: false,
                  ...(usage() ? { usage: usage() } : {}),
                };
              }
              activePlan = merged;
              report({ type: 'plan.ready', plan: activePlan });
              continue;
            }
            return {
              ok: false,
              code: toFailureCode(failed.failure),
              detail: failed.failure.detail,
              retryable: false,
              ...(usage() ? { usage: usage() } : {}),
            };
          }
        }

        if (!verification) {
          // Unreachable by construction: the loop breaks only after assigning it.
          const structural = structuralAssessment({
            plan: activePlan,
            completed,
            evidence: [...evidence.values()],
          });
          verification = structural;
        }
        if (!verification.passed) {
          return {
            ok: false,
            code: 'verification_failed',
            detail: verification.reason,
            retryable: false,
            ...(usage() ? { usage: usage() } : {}),
          };
        }

        const sections = activePlan.steps
          .map((step) => evidence.get(step.id)?.output)
          .filter((text): text is string => typeof text === 'string' && text.length > 0);
        const verificationText = verificationSummaryText(verification);
        sections.push(verificationText);
        report({ type: 'text.delta', text: `\n\n${verificationText}` });

        return {
          ok: true,
          summary: sections.join('\n\n'),
          ...(usage() ? { usage: usage() } : {}),
          verification,
        };
      } catch (error) {
        if (request.signal.aborted) return cancelled();
        if (error instanceof IterationLimitError) {
          return {
            ok: false,
            code: 'iteration_exhausted',
            detail: `The run exhausted its bounded autonomy budget of ${error.limit} iterations.`,
            retryable: false,
            ...(usage() ? { usage: usage() } : {}),
          };
        }
        return {
          ok: false,
          code: 'provider_error',
          detail: 'The Native plan could not be executed safely.',
          retryable: false,
          ...(usage() ? { usage: usage() } : {}),
        };
      }
    },
  };
}
