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
 * Coderax Native is the default and the only engine with no external dependency.
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
    if (!input.gateway) {
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
      const gateway = input.gateway;
      if (!gateway) {
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
      function budgetExhausted(prompt: string, maxOutput: number | undefined): boolean {
        if (!request.budget) return false;
        const inputLeft = request.budget.maxInputTokens - (totals.input ?? 0);
        const outputLeft = request.budget.maxOutputTokens - (totals.output ?? 0);
        return (
          inputLeft <= 0 ||
          outputLeft <= 0 ||
          estimateTokens([NATIVE_ACTION_SYSTEM, prompt]) + (maxOutput ?? 0) > inputLeft + outputLeft
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

          const action = parseAction(text);
          if (action.kind === 'final') {
            stepText = action.text.trim();
            break;
          }

          if (action.kind === 'invalid') {
            // A model that answers in prose instead of the action protocol has
            // still answered. Accept that once, but only when it did not attempt
            // a malformed JSON object; a broken tool call is repaired, not
            // silently treated as the result.
            if (invalidAnswers === 0 && !text.includes('{')) {
              const prose = text.trim();
              if (prose.length > 0) {
                stepText = prose;
                break;
              }
            }
            invalidAnswers += 1;
            if (invalidAnswers >= 2) {
              return {
                ok: false,
                code: 'protocol_error',
                detail: 'The model did not return a valid action after a repair attempt.',
                retryable: false,
              };
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
    },
  };
}
