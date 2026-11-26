import { DeliverableRequest, type Availability, type EngineCapabilities } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';
import type { DeliverableTool, ModelGateway, Planner } from './types.js';
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
  /** Supplied by the composition root; null reports the tool as unavailable. */
  deliverable?: DeliverableTool | null;
  unavailableDetail?: string;
}): AgentAdapter {
  const planner = input.planner ?? createDeterministicPlanner();

  const capabilities: EngineCapabilities = {
    streaming: true,
    tools: input.deliverable !== undefined && input.deliverable !== null,
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
      const gateway = input.gateway;
      if (!gateway) {
        return {
          ok: false,
          code: 'not_configured',
          detail: status.detail,
          retryable: false,
        };
      }

      // Chat stays side-effect free: only a durable Work task may write artifacts.
      const directive = request.taskId
        ? readDeliverableDirective(request.objective)
        : ({ present: false } as const);
      const objective = directive.present
        ? stripDeliverableDirective(request.objective)
        : request.objective;
      const steps = planner.plan({ objective, maxSteps: request.maxSteps });
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
              objective,
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

      let deliverableSummary = '';
      if (directive.present) {
        if (directive.error) {
          return { ok: false, code: 'protocol_error', detail: directive.error, retryable: false };
        }
        if (!input.deliverable) {
          return {
            ok: false,
            code: 'not_configured',
            detail: 'This engine has no deliverable generator configured for Coderax Native.',
            retryable: false,
          };
        }
        const parsed = DeliverableRequest.safeParse(directive.value);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'deliverable';
          return {
            ok: false,
            code: 'protocol_error',
            detail: `The deliverable directive is invalid at ${where}: ${issue?.message ?? 'invalid request'}.`,
            retryable: false,
          };
        }
        const callId = `deliverable-${steps.length + 1}`;
        report({
          type: 'tool.call',
          callId,
          tool: 'deliverable.produce',
          input: { kind: parsed.data.kind },
        });
        const delivered = await input.deliverable({
          request: parsed.data,
          ownerId: request.ownerId,
          ...(request.taskId ? { taskId: request.taskId } : {}),
          conversationId: request.conversationId,
          signal: request.signal,
        });
        if (!delivered.ok) {
          report({
            type: 'tool.result',
            callId,
            tool: 'deliverable.produce',
            ok: false,
            output: delivered.detail.slice(0, 500),
          });
          return { ok: false, code: delivered.code, detail: delivered.detail, retryable: false };
        }
        deliverableSummary = delivered.summary;
        report({
          type: 'tool.result',
          callId,
          tool: 'deliverable.produce',
          ok: true,
          output: delivered.descriptors
            .map((descriptor) => `${descriptor.filename} v${descriptor.version} ${descriptor.sha256.slice(0, 12)}`)
            .join(', ')
            .slice(0, 500),
        });
      }

      return {
        ok: true,
        summary: [sections.join('\n\n'), deliverableSummary]
          .filter((part) => part.length > 0)
          .join('\n\n'),
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

/**
 * A Work objective may declare one deliverable in a fenced block. The directive
 * is data: it is parsed against the published contract, removed from the text the
 * model sees, and produced by the same use case the API uses.
 */
export type DirectiveRead =
  | { present: false }
  | { present: true; value: unknown; error?: string };

export function readDeliverableDirective(objective: string): DirectiveRead {
  const match = /```deliverable\s*\n([\s\S]*?)```/.exec(objective);
  if (!match) return { present: false };
  try {
    return { present: true, value: JSON.parse(match[1] ?? '') as unknown };
  } catch {
    return { present: true, value: null, error: 'The deliverable directive is not valid JSON.' };
  }
}

export function stripDeliverableDirective(objective: string): string {
  const stripped = objective.replace(/```deliverable\s*\n[\s\S]*?```/g, '').trim();
  return stripped.length > 0 ? stripped : 'Produce the requested deliverable.';
}
