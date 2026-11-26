import type { Availability, EngineCapabilities, ModelRef, Usage } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';
import type { ModelGateway, Planner } from './types.js';
import { createDeterministicPlanner } from './planner.js';
import { buildStepPrompt } from './prompt.js';
import { routingFailure } from '../../models/types.js';

/**
 * Coderax Native is the default and the only engine with no external dependency.
 *
 * It plans deterministically, calls the single model router through the gateway
 * port, reports step and text events, and never reaches for another agent. The
 * router may replace a failed automatic route within its bounded fallback; an
 * explicitly requested model is pinned. When no verified zero-cost model is
 * routable, Native reports `not_configured` instead of pretending to work.
 */
export function createNativeAgent(input: {
  enabled: boolean;
  gateway: ModelGateway | null;
  planner?: Planner;
  unavailableDetail?: string;
  /** Live route admission; a gateway may exist while every endpoint is excluded. */
  modelsAvailable?: () => boolean;
}): AgentAdapter {
  const planner = input.planner ?? createDeterministicPlanner();

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
                ? 'provider_error'
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

      const steps = planner.plan({ objective: request.objective, maxSteps: request.maxSteps });
      const history = request.history ?? [];
      const completed: string[] = [];
      const sections: string[] = [];
      let usageIn: number | undefined;
      let usageOut: number | undefined;
      let actualModel: ModelRef | undefined;

      for (const step of steps) {
        if (request.signal.aborted) {
          return { ok: false, code: 'cancelled', detail: 'The run was cancelled.', retryable: false };
        }
        if (request.budget) {
          const inputLeft = request.budget.maxInputTokens - (usageIn ?? 0);
          const outputLeft = request.budget.maxOutputTokens - (usageOut ?? 0);
          if (inputLeft <= 0 || outputLeft <= 0) {
            return {
              ok: false,
              code: 'budget_exhausted',
              detail: 'The task token budget is exhausted; no further step was sent.',
              retryable: false,
            };
          }
        }
        const maxOutputTokens = request.budget
          ? Math.max(
              1,
              Math.min(
                request.budget.maxOutputTokens - (usageOut ?? 0),
                request.budget.maxOutputTokens,
              ),
            )
          : undefined;

        report({ type: 'step.started', stepId: step.id, title: step.title });
        const images = request.images ?? [];
        const stepPrompt = buildStepPrompt({
          objective: request.objective,
          step,
          completed,
          history,
        });
        try {
          let stepText = '';
          if (gateway.stream) {
            for await (const event of gateway.stream({
              ownerId: request.ownerId,
              model: request.model,
              mode: request.mode,
              routing: request.routing,
              allowFallback: request.allowFallback,
              system:
                'You are Coderax Native, the owner’s private execution agent. Answer with the concrete result for the requested step only.',
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
              routing: request.routing,
              allowFallback: request.allowFallback,
              system:
                'You are Coderax Native, the owner’s private execution agent. Answer with the concrete result for the requested step only.',
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
            if (completion.usage?.outputTokens !== undefined) {
              usageOut = (usageOut ?? 0) + completion.usage.outputTokens;
            }
            report({ type: 'text.delta', text: completion.text });
          }
          sections.push(stepText);
          report({ type: 'step.completed', stepId: step.id, title: step.title });
          completed.push(step.id);
        } catch (error) {
          if (request.signal.aborted) {
            return {
              ok: false,
              code: 'cancelled',
              detail: 'The run was cancelled.',
              retryable: false,
            };
          }
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
                      : 'provider_error',
              detail: failure.detail,
              // A partial step is never safe to replay blindly.
              retryable: false,
            };
          }
          return {
            ok: false,
            code: 'provider_error',
            detail: 'The inference endpoint failed while executing this step.',
            // A provider failure after a step started is not safe to replay.
            retryable: false,
          };
        }
      }

      const usage: Usage | undefined =
        usageIn !== undefined || usageOut !== undefined
          ? {
              ...(usageIn !== undefined ? { inputTokens: usageIn } : {}),
              ...(usageOut !== undefined ? { outputTokens: usageOut } : {}),
            }
          : undefined;
      return {
        ok: true,
        summary: sections.join('\n\n'),
        ...(usage ? { usage } : {}),
        ...(actualModel ? { model: actualModel } : {}),
      };
    },
  };
}
