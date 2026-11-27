import type { Availability, EngineCapabilities, ModelRef, Usage } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';
import type { ModelGateway, Planner } from './types.js';
import { createNativePlanner } from './planner.js';
import { buildActionPrompt, NATIVE_ACTION_SYSTEM } from './prompt.js';
import { parseAction } from './action.js';
import type { ToolContext } from '../../tools/types.js';
import { routingFailure } from '../../models/types.js';
import { estimateTokens } from '../../models/verify.js';

/**
 * Coderax Native's independent reasoning loop.
 *
 * Its loop is plan → act → observe → reflect, bounded at every level: a step has
 * a fixed action budget, a malformed action gets one repair attempt, and a step
 * that exhausts its tools is summarised from what it actually happened rather
 * than claiming a result it never produced. An action that needs the owner
 * suspends the task with a durable permission request; it does not silently
 * proceed and does not fail permanently.
 *
 * Every model call goes through the single model router gateway. The router —
 * not this agent — decides whether a provider may serve the request, so a
 * private turn can never reach a hosted endpoint the owner has not approved.
 */

const MAX_TOOL_CALLS_PER_STEP = 4;

function accumulate(
  totals: { input: number | undefined; output: number | undefined },
  usage: Usage | undefined,
): void {
  if (!usage) return;
  if (usage.inputTokens !== undefined) totals.input = (totals.input ?? 0) + usage.inputTokens;
  if (usage.outputTokens !== undefined) totals.output = (totals.output ?? 0) + usage.outputTokens;
}

function usageOf(totals: { input: number | undefined; output: number | undefined }): Usage | undefined {
  if (totals.input === undefined && totals.output === undefined) return undefined;
  return {
    ...(totals.input !== undefined ? { inputTokens: totals.input } : {}),
    ...(totals.output !== undefined ? { outputTokens: totals.output } : {}),
  };
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function createNativeAgent(input: {
  enabled: boolean;
  gateway: ModelGateway | null;
  planner?: Planner;
  executor?: ActionExecutor;
  authorizer?: ActionAuthorizer;
  limits?: Partial<NativeLimits>;
  unavailableDetail?: string;
  /** Live route admission; a gateway may exist while every endpoint is excluded. */
  modelsAvailable?: () => boolean;
}): AgentAdapter {
  const planner = input.planner ?? createNativePlanner();

  const capabilities: EngineCapabilities = {
    streaming: true,
    tools: true,
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
    if (input.modelsAvailable && !input.modelsAvailable()) {
      return {
        available: false,
        reason: 'model_missing',
        detail:
          'No verified zero-cost model is currently routable; Native fails closed rather than using a paid endpoint.',
      };
    }
    return { available: true, reason: 'ready', detail: 'Coderax Native is ready.' };
  }

  return {
    agent: 'coderax',
    engine: 'native',
    workload: 'in-process',
    capabilities,
    // Native only produces text in this tree; it exposes no side-effecting tool.
    sideEffects: 'none',
    isolation: {
      workspace: 'isolated',
      memory: 'granted',
      credentials: 'none',
      conversations: 'granted',
    },
    availability,
    probe: async () => {
      // Native's readiness is its configuration and its verified route: there is
      // no remote endpoint to ask, and calling a model would spend the budget.
      const status = availability();
      return { ok: status.available, detail: status.detail };
    },

    run: async (request: AgentRunRequest, report: AgentReport): Promise<AgentRunOutcome> => {
      const status = availability();
      if (!status.available) {
        return {
          ok: false,
          code:
            status.reason === 'disabled'
              ? 'disabled'
              : status.reason === 'model_missing'
                ? 'model_missing'
                : 'not_configured',
          detail: status.detail,
          retryable: false,
        };
      }
      if (!gateway || !planner || !executor || !request.model) {
        return {
          ok: false,
          code: 'not_configured',
          detail: status.detail,
          retryable: false,
        };
      }

      const context = request.context ?? {};
      const tools = context.tools ?? null;
      const totals: { input: number | undefined; output: number | undefined } = {
        input: undefined,
        output: undefined,
      };
      const history = request.history ?? [];
      const cancelled = (): AgentRunOutcome => ({
        ok: false,
        code: 'cancelled',
        detail: 'The run was cancelled.',
        retryable: false,
      });

      if (request.signal.aborted) return cancelled();

      let steps = context.plannedSteps ?? [];
      if (steps.length === 0) {
        steps =
          request.maxSteps <= 1
            ? [{ id: 'step-1', title: 'Respond to the owner' }]
            : await planner.plan({
                objective: request.objective,
                maxSteps: request.maxSteps,
                history,
                signal: request.signal,
                ...(tools
                  ? {
                      complete: async (prompt: string, signalAbort: AbortSignal) => {
                        const completion = await gateway.complete({
                          ownerId: request.ownerId,
                          model: request.model,
                          mode: request.mode,
                          operation: request.operation,
                          routing: 'complex',
                          allowFallback: request.allowFallback,
                          system:
                            'You are Coderax Native. Plan the work. Return only a JSON array of step titles.',
                          prompt,
                          signal: signalAbort,
                        });
                        accumulate(totals, completion.usage);
                        return completion.text;
                      },
                    }
                  : {}),
              });
        if (context.savePlan && !(await context.savePlan(steps))) return cancelled();
      }

      const completed = new Set(context.completedSteps ?? []);
      const sections: string[] = context.priorText ? [context.priorText] : [];
      const outputs = [
        ...(context.priorOutputs ??
          (context.priorText
            ? [{ stepId: [...completed].join(', '), text: context.priorText }]
            : [])),
      ];
      // Resume replaces the visible turn with the durable checkpoint before it
      // streams new work, so earlier text is not duplicated in the transcript.
      if (context.priorText) report({ type: 'text.replace', text: context.priorText });

      // Context is fetched before the loop so every step sees the same durable
      // memory and the same retrieved passages for this objective.
      let memoryLines: string[] = [];
      if (context.memory) {
        try {
          memoryLines = (await context.memory.list()).slice(0, 8).map((line) => bounded(line, 600));
        } catch {
          memoryLines = [];
        }
      }
      let knowledgeLines: string[] = [];
      if (context.knowledge) {
        try {
          const found = await context.knowledge.search(request.objective.slice(0, 1000), 4);
          knowledgeLines = found.hits.map(
            (hit) => `[${bounded(hit.title, 120)}]\n${bounded(hit.text, 1000)}`,
          );
        } catch {
          knowledgeLines = [];
        }
      }

      const toolCatalogue = tools?.runtime.catalogue() ?? '';
      let pending = context.pendingAction;
      let callIndex = 0;
      let actualModel: ModelRef | undefined;

      /** Per-step token ceiling, independent of the router's own reservation. */
      // Reservations, not just actual usage: a provider that omits a token side
      // must not let the next step spend the same headroom again.
      let reservedInput = 0;
      let reservedOutput = 0;
      function budgetExhausted(prompt: string, maxOutput: number | undefined): boolean {
        if (!request.budget) return false;
        // The router already bounded the first dispatch. Cumulative reservations
        // guard every later step, including when usage omitted a token side.
        if (reservedInput === 0 && reservedOutput === 0) return false;
        const inputTokens = estimateTokens([NATIVE_ACTION_SYSTEM, prompt]);
        const outputTokens = maxOutput ?? request.budget.maxOutputTokens;
        return (
          reservedInput + inputTokens > request.budget.maxInputTokens ||
          reservedOutput + outputTokens > request.budget.maxOutputTokens
        );
      }

      for (const step of steps) {
        if (request.signal.aborted) return cancelled();
        if (completed.has(step.id)) continue;

        report({ type: 'step.started', stepId: step.id, title: step.title });
        const saved = pending?.stepId === step.id ? pending : null;
        const observations = [...(saved?.observations ?? [])];
        let stepText = '';
        let invalidAnswers = saved?.invalidAnswers ?? 0;
        let actions = saved?.priorActions ?? 0;

        while (stepText.length === 0 && actions < MAX_TOOL_CALLS_PER_STEP) {
          if (request.signal.aborted) return cancelled();

          const replay = pending?.stepId === step.id ? pending : null;
          const prompt = buildActionPrompt({
            objective: request.objective,
            steps,
            step,
            completed: [...completed],
            outputs,
            history,
            observations,
            memory: memoryLines,
            knowledge: knowledgeLines,
            catalogue: toolCatalogue,
          });
          if (!replay && budgetExhausted(prompt, request.budget?.maxOutputTokens)) {
            return {
              ok: false,
              code: 'budget_exhausted',
              detail: 'The task token budget is exhausted; no further step was sent.',
              retryable: false,
            };
          }
          let text: string;
          try {
            if (replay) {
              text = replay.json;
            } else {
              const completion = await gateway.complete({
                ownerId: request.ownerId,
                model: request.model,
                mode: request.mode,
                operation: request.operation,
                routing: tools ? 'complex' : 'fast',
                allowFallback: request.allowFallback,
                system: NATIVE_ACTION_SYSTEM,
                prompt,
                signal: request.signal,
                ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
              });
              accumulate(totals, completion.usage);
              reservedInput += estimateTokens([NATIVE_ACTION_SYSTEM, prompt]);
              reservedOutput += request.budget?.maxOutputTokens ?? 0;
              actualModel = completion.model;
              text = completion.text;
            }
          } catch (error) {
            if (request.signal.aborted) return cancelled();
            const failure = routingFailure(error);
            if (failure) {
              return {
                ok: false,
                code:
                  failure.code === 'budget_exhausted'
                    ? 'budget_exhausted'
                    : failure.code === 'paid_model_refused'
                      ? 'paid_model_refused'
                      : failure.code === 'cancelled'
                        ? 'cancelled'
                        : failure.code === 'model_missing'
                          ? 'model_missing'
                          : 'provider_error',
                detail: failure.detail,
                // A partial step is never safe to replay blindly.
                retryable: failure.code === 'model_missing',
              };
            }
            return {
              ok: false,
              code: 'provider_error',
              detail: 'The inference endpoint failed while executing this step.',
              // A provider failure may have reached the model, so replaying the
              // whole run is not automatically safe.
              retryable: false,
            };
          }

        report({ type: 'step.started', stepId: step.id, title: step.title });
        const images = request.images ?? [];
        try {
          let stepText = '';
          if (gateway.stream) {
            for await (const event of gateway.stream({
              ownerId: request.ownerId,
              model: request.model,
              mode: request.mode,
              operation: request.operation,
              routing: request.routing,
              allowFallback: request.allowFallback,
              system: NATIVE_SYSTEM,
              prompt: stepPrompt,
              ...(images.length > 0
                ? { messages: [{ role: 'user' as const, text: stepPrompt, images }] }
                : {}),
              signal: request.signal,
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            })) {
              if (event.type === 'text') {
                stepText += event.text;
                report({ type: 'text.delta', text: event.text });
              } else if (event.type === 'usage') {
                if (event.usage.inputTokens !== undefined) {
                  usageIn = (usageIn ?? 0) + event.usage.inputTokens;
                }
                if (event.usage.outputTokens !== undefined) {
                  usageOut = (usageOut ?? 0) + event.usage.outputTokens;
                }
              } else if (event.type === 'model') {
                actualModel = event.model;
              }
            }
          } else {
            const completion = await gateway.complete({
              ownerId: request.ownerId,
              model: request.model,
              mode: request.mode,
              operation: request.operation,
              routing: request.routing,
              allowFallback: request.allowFallback,
              system: NATIVE_SYSTEM,
              prompt: stepPrompt,
              ...(images.length > 0
                ? { messages: [{ role: 'user' as const, text: stepPrompt, images }] }
                : {}),
              signal: request.signal,
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            });
            stepText = completion.text;
            actualModel = completion.model;
            if (completion.usage?.inputTokens !== undefined) {
              usageIn = (usageIn ?? 0) + completion.usage.inputTokens;
            }
            observations.push(
              `Your previous answer was rejected: ${action.reason} Return exactly one JSON object with a tool call or a final answer.`,
            );
            continue;
          }

          if (!tools) {
            observations.push('No tools are available on this run. Return a final answer.');
            actions += 1;
            continue;
          }

          actions += 1;
          callIndex += 1;
          const callId = `${step.id}-call-${callIndex}`;
          report({ type: 'tool.call', callId, tool: action.tool, input: action.input });

          const toolContext: ToolContext = {
            ownerId: request.ownerId,
            taskId: context.taskId ?? null,
            agent: 'coderax',
            mode: request.mode,
            workspaceRoot: request.workspaceRoot,
            signal: request.signal,
            callId,
            ...(context.tools?.guard ? { guard: context.tools.guard } : {}),
          };
          if (replay) {
            if (context.savePendingAction && !(await context.savePendingAction(null))) return cancelled();
            pending = null;
          }
          const outcome = await tools.runtime.call({
            name: action.tool,
            arguments: action.input,
            context: toolContext,
            gate: tools.gate,
          });

          report({
            type: 'tool.result',
            callId,
            tool: action.tool,
            ok: outcome.result.ok,
            output: bounded(outcome.result.ok ? outcome.result.output : outcome.result.detail, 4000),
          });

          if (outcome.approval === 'pending') {
            if (context.savePendingAction && !(await context.savePendingAction({
              observations, priorActions: actions - 1, invalidAnswers,
              stepId: step.id, json: JSON.stringify({ tool: action.tool, input: action.input }),
            }))) return cancelled();
            report({
              type: 'approval.required',
              requestId: outcome.requestId ?? callId,
              tool: action.tool,
              description: bounded(
                `Approval is required for ${action.tool}.`,
                2000,
              ),
            });
            // Persist what was produced so far, then suspend: the owner decides,
            // and resume continues this task from its checkpoint.
            if (sections.length > 0) report({ type: 'text.replace', text: sections.join('\n\n') });
            return {
              ok: false,
              code: 'approval_required',
              detail: outcome.result.ok
                ? 'Owner approval is required to continue this run.'
                : outcome.result.detail,
              retryable: true,
            };
          }

          if (outcome.result.ok) {
            observations.push(`Tool ${action.tool} succeeded:\n${bounded(outcome.result.output, 4000)}`);
          } else {
            observations.push(
              `Tool ${action.tool} failed (${outcome.result.code}): ${bounded(outcome.result.detail, 1000)}`,
            );
          }
        }

        if (stepText.length === 0) {
          // Recovery: report what the step actually established instead of
          // inventing an answer the tools never produced.
          stepText =
            observations.length > 0
              ? `Step "${step.title}" reached its action limit. Recorded observations:\n${observations
                  .slice(-3)
                  .join('\n')}`
              : `Step "${step.title}" produced no result.`;
        }

        sections.push(stepText);
        outputs.push({ stepId: step.id, text: stepText });
        report({ type: 'text.delta', text: stepText });
        report({ type: 'step.completed', stepId: step.id, title: step.title, output: stepText });
        completed.add(step.id);
      }

      const summary = sections.join('\n\n').trim();
      const usage = usageOf(totals);
      return {
        ok: true,
        summary: summary.length > 0 ? summary : 'The objective produced no content.',
        ...(usage ? { usage } : {}),
        ...(actualModel ? { model: actualModel } : {}),
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

      const executeStep = async (
        step: TaskPlanStep,
        signal: AbortSignal,
      ): Promise<StepRunResult> => {
        if (signal.aborted) return { kind: 'cancelled' };
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

        let attempts = 0;
        let started = false;
        let feedback: string | undefined;

        for (;;) {
          if (signal.aborted) return { kind: 'cancelled' };
          attempts += 1;
          spend();
          if (!started) {
            report({ type: 'step.started', stepId: step.id, title: step.title, iterations });
            started = true;
          }
          const execution = await executor.execute({
            step,
            objective: request.objective,
            mode,
            history: request.history ?? [],
            evidence: [...evidence.values()],
            workspaceRoot: request.workspaceRoot,
            model,
            signal,
            ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
            ...(feedback ? { feedback } : {}),
          });

          if (execution.ok) {
            accumulate(execution.usage);
            const entry: StepEvidence = {
              stepId: step.id,
              title: step.title,
              output: execution.text.slice(0, MAX_STEP_RESULT),
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
              iterations,
            });
            return { kind: 'completed' };
          }

          if (signal.aborted) return { kind: 'cancelled' };
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
              iterations,
            });
            return { kind: 'failed', failure: execution.failure };
          }
          if (correction === 'correct') feedback = execution.failure.detail;
          await pause(REASONING_PAUSE_MS, signal);
        }
      };

      try {
        if (!plan) {
          spend();
          const planned = await planner.plan({
            objective: request.objective,
            history: request.history ?? [],
            model,
            mode,
            completedSteps: [...completed],
            maxSteps,
            ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
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
          report({ type: 'plan.ready', plan, iterations });
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
              model,
              signal: request.signal,
              objective: request.objective,
              mode,
              ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
              plan: activePlan,
              completed,
              evidence: [...evidence.values()],
            });
            if (request.signal.aborted) return cancelled();
            accumulate(assessed.usage);
            verification = assessed.verification;

            if (verification.passed) break;

            const remainingCapacity = Math.max(0, maxSteps - completed.size);
            if (mode === 'complex' && replans < activeLimits.maxReplans && remainingCapacity > 0) {
              replans += 1;
              spend();
              const revised = await planner.replan({
                objective: request.objective,
                history: request.history ?? [],
                model,
                mode,
                plan: activePlan,
                completedSteps: [...completed],
                evidence: [...evidence.values()],
                failure: {
                  reason: 'verification_failed',
                  detail: verification.reason,
                },
                maxSteps: remainingCapacity,
                ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
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
              report({ type: 'plan.ready', plan: activePlan, iterations });
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

          // A wave must not outlive the run that owns it. If one step throws
          // (for example, the iteration bound is exhausted), abort its siblings
          // and wait for them to settle before returning; otherwise an action
          // could still be running after the engine releases the task's lease.
          const waveController = new AbortController();
          const waveSignal = AbortSignal.any([request.signal, waveController.signal]);
          const settled = await Promise.allSettled(
            wave.map(async (step) => {
              try {
                return await executeStep(step, waveSignal);
              } catch (error) {
                waveController.abort();
                throw error;
              }
            }),
          );
          const results: StepRunResult[] = [];
          for (const result of settled) {
            if (result.status === 'rejected') throw result.reason;
            results.push(result.value);
          }
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
            const remainingCapacity = Math.max(0, maxSteps - completed.size);
            if (
              mode === 'complex' &&
              correctable &&
              replans < activeLimits.maxReplans &&
              remainingCapacity > 0
            ) {
              replans += 1;
              spend();
              const revised = await planner.replan({
                objective: request.objective,
                history: request.history ?? [],
                model,
                mode,
                plan: activePlan,
                completedSteps: [...completed],
                evidence: [...evidence.values()],
                failure: {
                  reason: 'step_failed',
                  detail: failed.failure.detail,
                  ...(wave.length === 1 && wave[0] ? { stepId: wave[0].id } : {}),
                },
                maxSteps: remainingCapacity,
                ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
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
              report({ type: 'plan.ready', plan: activePlan, iterations });
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
        const summary = sections.join('\n\n');
        report({ type: 'text.delta', text: `\n\n${verificationText}` });
        // A resumed generation may have skipped already-completed steps. Replace
        // the live text with the full evidence-backed summary so the final
        // transcript is self-contained instead of only the verification line.
        report({ type: 'text.replace', text: summary });

        return {
          ok: true,
          summary,
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
