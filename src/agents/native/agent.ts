import type { Availability, EngineCapabilities } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';
import type { ModelGateway, Planner } from './types.js';
import { createDeterministicPlanner } from './planner.js';
import { buildStepPrompt } from './prompt.js';

/**
 * Coderax Native is the default and the only engine with no external dependency.
 *
 * It plans deterministically, calls a zero-cost model gateway through the engine's
 * model routing, reports step and text events, and never reaches for another
 * agent. When no gateway is configured it reports `not_configured` instead of
 * pretending to work or falling through to an external agent.
 */
export function createNativeAgent(input: {
  enabled: boolean;
  gateway: ModelGateway | null;
  planner?: Planner;
  unavailableDetail?: string;
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

      for (const step of steps) {
        if (request.signal.aborted) {
          return { ok: false, code: 'cancelled', detail: 'The run was cancelled.', retryable: false };
        }
        report({ type: 'step.started', stepId: step.id, title: step.title });
        try {
          const completion = await gateway.complete({
            model: request.model,
            system:
              'You are Coderax Native, the owner’s private execution agent. Answer with the concrete result for the requested step only.',
            prompt: buildStepPrompt({
              objective: request.objective,
              step,
              completed,
              history,
            }),
            signal: request.signal,
            ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
          });
          if (completion.usage?.inputTokens !== undefined) {
            usageIn = (usageIn ?? 0) + completion.usage.inputTokens;
          }
          if (completion.usage?.outputTokens !== undefined) {
            usageOut = (usageOut ?? 0) + completion.usage.outputTokens;
          }
          sections.push(completion.text);
          report({ type: 'text.delta', text: completion.text });
          report({ type: 'step.completed', stepId: step.id, title: step.title });
          completed.push(step.id);
        } catch {
          if (request.signal.aborted) {
            return {
              ok: false,
              code: 'cancelled',
              detail: 'The run was cancelled.',
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

      return {
        ok: true,
        summary: sections.join('\n\n'),
        ...(usageIn !== undefined || usageOut !== undefined
          ? {
              usage: {
                ...(usageIn !== undefined ? { inputTokens: usageIn } : {}),
                ...(usageOut !== undefined ? { outputTokens: usageOut } : {}),
              },
            }
          : {}),
      };
    },
  };
}
