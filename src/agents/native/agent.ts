import { createHash } from 'node:crypto';
import type { Availability, EngineCapabilities, Usage } from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentExecutionState,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
  ExecutedToolAction,
  StepResult,
} from '../types.js';
import type { ModelGateway, ModelToolDefinition, Planner, PlanStep } from './types.js';
import { createNativePlanner, normalizePlan, planGraphIssue } from './planner.js';
import { buildActionPrompt, NATIVE_ACTION_SYSTEM } from './prompt.js';
import { actionFromToolCall, parseAction } from './action.js';
import type { ToolContext } from '../../tools/types.js';
import { isBudgetExhausted, isRouterExhausted } from '../../models/routed.js';
import { ToolCallingUnsupportedError } from './gateway.js';

/**
 * Coderax Native is the default and the only engine with no external dependency.
 *
 * Its loop is plan → act → observe → reflect, bounded at every level: a step has
 * a fixed action budget, a malformed action gets one repair attempt, a repeated
 * action is refused instead of looping, an empty final is a protocol error, and
 * the whole run has an action and wall-clock ceiling. A step that exhausts its
 * tools is summarised from what actually happened rather than claiming a result
 * it never produced.
 *
 * Durability is part of the loop. The full plan is written before its first
 * step; each dispatched call is recorded before the effect and completed after
 * it; the pending approval action stays durable until it is settled. A resume
 * therefore reuses what was learned, never re-runs a call whose effect is
 * unknown, and refuses to report completion when a planned step was skipped.
 */

const MAX_TOOL_CALLS_PER_STEP = 4;
const MAX_INVALID_ANSWERS = 2;
const MAX_REPEATS = 1;
const DEFAULT_MAX_ACTIONS = 24;
const DEFAULT_MAX_RUN_MS = 10 * 60_000;
const MAX_COMPLETED_RESULTS = 8;

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

function digestOf(tool: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([tool, input])).digest('hex').slice(0, 32);
}

function cloneState(state: AgentExecutionState): AgentExecutionState {
  return {
    observations: Object.fromEntries(Object.entries(state.observations).map(([key, lines]) => [key, [...lines]])),
    executed: state.executed.map((entry) => ({ ...entry })),
  };
}

export function createNativeAgent(input: {
  enabled: boolean;
  gateway: ModelGateway | null;
  planner?: Planner;
  unavailableDetail?: string;
  /** Hard ceilings from the composition root; the defaults keep a bare agent bounded. */
  maxActionsPerRun?: number;
  maxRunMs?: number;
}): AgentAdapter {
  const planner = input.planner ?? createNativePlanner();
  const maxActionsPerRun = input.maxActionsPerRun ?? DEFAULT_MAX_ACTIONS;
  const maxRunMs = input.maxRunMs ?? DEFAULT_MAX_RUN_MS;

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
        return { ok: false, code: 'not_configured', detail: status.detail, retryable: false };
      }

      const context = request.context ?? {};
      const tools = context.tools ?? null;
      const history = request.history ?? [];
      const startedAt = Date.now();
      const deadline = startedAt + (context.maxRunMs ?? maxRunMs);
      const actionCeiling = context.maxActionsPerRun ?? maxActionsPerRun;
      const totals: { input: number | undefined; output: number | undefined } = {
        input: undefined,
        output: undefined,
      };
      let modelRequests = 0;
      /** A per-task ceiling independent of the owner's durable daily budget. */
      const budgetSpent = (): boolean => {
        const budget = request.budget;
        if (!budget) return false;
        if (modelRequests >= budget.maxRequests) return true;
        if ((totals.input ?? 0) > budget.maxInputTokens) return true;
        if ((totals.output ?? 0) > budget.maxOutputTokens) return true;
        return false;
      };
      const budgetFailure = (): AgentRunOutcome => ({
        ok: false,
        code: 'budget_exhausted',
        detail: 'This task reached its execution budget; it stopped without exceeding it.',
        retryable: false,
        requests: modelRequests,
      });
      const cancelled = (): AgentRunOutcome => ({
        ok: false,
        code: 'cancelled',
        detail: 'The run was cancelled.',
        retryable: false,
      });
      const state: AgentExecutionState = {
        observations: Object.fromEntries(
          Object.entries(context.executionState?.observations ?? {}).map(([key, lines]) => [key, [...lines]]),
        ),
        executed: (context.executionState?.executed ?? []).map((entry) => ({ ...entry })),
      };
      const persistState = async (): Promise<boolean> => {
        if (!context.saveExecutionState) return true;
        return await context.saveExecutionState(cloneState(state));
      };

      if (request.signal.aborted) return cancelled();

      let steps: PlanStep[] = normalizePlan(context.plannedSteps ?? []);
      // Only a genuinely new plan is written. Re-saving a resumed plan would
      // reset already completed steps to `queued` in the task record.
      const plannedNow = steps.length === 0;
      if (plannedNow) {
        steps = normalizePlan(
          await planner.plan({
            objective: request.objective,
            maxSteps: request.maxSteps,
            history,
            signal: request.signal,
            ...(tools
              ? {
                  complete: async (prompt: string, signalAbort: AbortSignal) => {
                    if (budgetSpent()) throw new Error('budget_exhausted');
                    const completion = await gateway.complete({
                      model: request.model,
                      ownerId: request.ownerId,
                      system:
                        'You are Coderax Native. Plan the work. Return only a JSON array of steps.',
                      prompt,
                      signal: signalAbort,
                      routingMode: 'complex',
                    });
                    modelRequests += 1;
                    accumulate(totals, completion.usage);
                    return completion.text;
                  },
                }
              : {}),
          }) as PlanStep[],
        );
      }

      const graphIssue = planGraphIssue(steps);
      if (graphIssue) {
        return { ok: false, code: 'protocol_error', detail: graphIssue, retryable: false };
      }
      if (steps.length === 0) {
        return {
          ok: false,
          code: 'protocol_error',
          detail: 'Planning produced no executable step.',
          retryable: false,
        };
      }
      if (plannedNow && context.savePlan && !(await context.savePlan(steps))) return cancelled();

      const completed = new Set(context.completedSteps ?? []);
      const results: StepResult[] = [...(context.completedResults ?? [])];
      const sections: string[] = context.priorText ? [context.priorText] : [];
      const blocked: string[] = [];
      const toolLedger: Array<{ callId: string; tool: string; ok: boolean; digest: string }> = [];
      let actionsThisRun = 0;
      let callIndex = 0;
      let pending = context.pendingAction ?? null;
      let useNativeTools =
        context.nativeTools === true &&
        gateway.supportsNativeTools === true &&
        tools !== null;

      // Resume replaces the visible turn with the durable checkpoint before it
      // streams new work, so earlier text is not duplicated in the transcript.
      if (context.priorText) report({ type: 'text.replace', text: context.priorText });

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
      const toolDefinitions: ModelToolDefinition[] =
        tools && typeof tools.runtime.schemas === 'function'
          ? tools.runtime.schemas().map((schema) => ({
              name: schema.name,
              description: schema.description,
              parameters: schema.parameters,
            }))
          : [];

      for (const step of steps) {
        if (request.signal.aborted) return cancelled();
        if (completed.has(step.id)) continue;

        const missing = step.dependsOn.filter((dependency) => !completed.has(dependency));
        if (missing.length > 0) {
          blocked.push(step.id);
          report({
            type: 'step.blocked',
            stepId: step.id,
            title: step.title,
            detail: `The step depends on ${missing.join(', ')}, which did not complete.`,
          });
          continue;
        }

        report({ type: 'step.started', stepId: step.id, title: step.title });
        const observations: string[] = [...(state.observations[step.id] ?? [])];
        let stepText = '';
        let invalidAnswers = 0;
        let stepActions = 0;
        let previousDigest = '';
        let repeats = 0;
        let replay = pending?.stepId === step.id ? pending : null;
        const replayCallId: string | undefined = replay?.callId;
        let replaying = false;

        while (stepText.length === 0 && stepActions < MAX_TOOL_CALLS_PER_STEP) {
          if (request.signal.aborted) return cancelled();
          if (Date.now() > deadline) {
            return {
              ok: false,
              code: 'timeout',
              detail: 'The step budget of wall-clock time was exhausted.',
              retryable: false,
            };
          }
          if (actionsThisRun >= actionCeiling) {
            return {
              ok: false,
              code: 'budget_exhausted',
              detail: 'The run reached its bounded action ceiling.',
              retryable: false,
            };
          }

          let action;
          let completionText = '';
          if (replay) {
            completionText = replay.json;
            action = parseAction(replay.json);
            // The pending action is the exact object the owner approved; it is
            // cleared only after the call has a recorded outcome.
            replay = null;
            replaying = true;
          } else {
            replaying = false;
            if (budgetSpent()) return budgetFailure();
            let completion;
            try {
              completion = await gateway.complete({
                model: request.model,
                ownerId: request.ownerId,
                toolSchemaText: toolCatalogue,
                system: NATIVE_ACTION_SYSTEM,
                prompt: buildActionPrompt({
                  objective: request.objective,
                  steps,
                  step,
                  completed: [...completed],
                  completedResults: results.slice(-MAX_COMPLETED_RESULTS).map((entry) => ({
                    id: entry.id,
                    title: entry.title,
                    text: bounded(entry.text, 2000),
                  })),
                  history,
                  observations,
                  memory: memoryLines,
                  knowledge: knowledgeLines,
                  catalogue: toolCatalogue,
                }),
                signal: request.signal,
                routingMode: tools ? 'complex' : 'fast',
                ...(request.budget ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
                ...(useNativeTools && toolDefinitions.length > 0
                  ? { tools: toolDefinitions, requiresTools: true }
                  : {}),
              });
            } catch (error) {
              if (request.signal.aborted) return cancelled();
              if (error instanceof ToolCallingUnsupportedError) {
                // Proven on the wire: this model cannot accept tool definitions.
                // The JSON action protocol is the supported compatibility mode.
                useNativeTools = false;
                observations.push(
                  'Native tool calling was refused by the provider; continuing with the JSON action protocol.',
                );
                continue;
              }
              if (isBudgetExhausted(error) || (error instanceof Error && error.message === 'budget_exhausted')) {
                return budgetFailure();
              }
              if (isRouterExhausted(error)) {
                return {
                  ok: false,
                  code: 'model_missing',
                  detail:
                    'No verified zero-cost model is available; the run stopped instead of routing to a paid path.',
                  retryable: true,
                };
              }
              return {
                ok: false,
                code: 'provider_error',
                detail: 'The inference endpoint failed while executing this step.',
                retryable: false,
              };
            }
            modelRequests += 1;
            accumulate(totals, completion.usage);
            if (budgetSpent()) return budgetFailure();
            completionText = completion.text;
            action = completion.toolCall
              ? actionFromToolCall(completion.toolCall)
              : parseAction(completion.text);
          }

          if (action.kind === 'final') {
            stepText = action.text.trim();
            break;
          }

          if (action.kind === 'invalid') {
            // A model that answers in prose instead of the action protocol has
            // still answered. Accept that once, but only when it did not attempt
            // a malformed JSON object; a broken tool call is repaired, not
            // silently treated as the result.
            if (
              invalidAnswers === 0 &&
              !completionText.includes('{') &&
              !replay &&
              completionText.trim().length > 0
            ) {
              stepText = completionText.trim();
              break;
            }
            invalidAnswers += 1;
            stepActions += 1;
            actionsThisRun += 1;
            if (invalidAnswers >= MAX_INVALID_ANSWERS) {
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
            state.observations[step.id] = [...observations];
            if (!(await persistState())) return cancelled();
            continue;
          }

          if (!tools) {
            observations.push('No tools are available on this run. Return a final answer.');
            stepActions += 1;
            actionsThisRun += 1;
            continue;
          }

          stepActions += 1;
          actionsThisRun += 1;
          const digest = digestOf(action.tool, action.input);

          // An identical call in the same step is either finished or
          // indeterminate. The one exception is a call that stopped at the
          // approval gate before it could have any effect: an approved replay
          // may execute it exactly once.
          const prior = state.executed.find(
            (entry) => entry.stepId === step.id && entry.digest === digest,
          );
          const replayable = prior !== undefined && prior.state === 'awaiting_approval' && replaying;
          if (prior && !replayable) {
            observations.push(
              prior.state === 'completed'
                ? `Tool ${action.tool} already ran in this step; its recorded result is:\n${bounded(prior.output, 2000)}`
                : prior.state === 'awaiting_approval'
                  ? `Tool ${action.tool} is still waiting for an owner decision and was not executed again.`
                  : `An earlier identical ${action.tool} call was interrupted after it was dispatched. Its effect is unknown; do not retry it.`,
            );
            state.observations[step.id] = [...observations];
            if (!(await persistState())) return cancelled();
            continue;
          }
          if (prior) state.executed = state.executed.filter((entry) => entry !== prior);

          // Reuse the durable call identity: the approval is bound to it, so a
          // resume must consume that exact decision, not invent a new one.
          let callId: string;
          if (prior) callId = prior.callId;
          else if (replayCallId) callId = replayCallId;
          else {
            callIndex += 1;
            callId = `${step.id}-call-${callIndex}`;
          }

          if (previousDigest === digest) {
            repeats += 1;
            if (repeats > MAX_REPEATS) {
              observations.push(
                'The same action was proposed repeatedly without advancing the step. Stop retrying it and report what is missing.',
              );
              break;
            }
          } else {
            previousDigest = digest;
            repeats = 0;
          }

          report({ type: 'tool.call', callId, tool: action.tool, input: action.input });
          const toolContext: ToolContext = {
            ownerId: request.ownerId,
            taskId: context.taskId ?? null,
            agent: 'coderax',
            mode: request.mode,
            workspaceRoot: request.workspaceRoot,
            signal: request.signal,
            callId,
          };

          // The intent is durable before the effect: a crash between dispatch and
          // result is recoverable as indeterminate instead of duplicated.
          const intent: ExecutedToolAction = {
            stepId: step.id,
            digest,
            tool: action.tool,
            callId,
            state: 'dispatched',
            ok: false,
            output: '',
          };
          state.executed.push(intent);
          state.observations[step.id] = [...observations];
          if (!(await persistState())) return cancelled();

          const outcome = await tools.runtime.call({
            name: action.tool,
            arguments: action.input,
            context: toolContext,
            gate: tools.gate,
            policy: toolsPolicy(action.tool, tools.runtime),
          });

          report({
            type: 'tool.result',
            callId,
            tool: action.tool,
            ok: outcome.result.ok,
            output: bounded(outcome.result.ok ? outcome.result.output : outcome.result.detail, 4000),
          });

          if (outcome.approval === 'pending') {
            // The intent records that the gate stopped this call before it ran.
            // A resume may therefore replay exactly this call once approved.
            intent.state = 'awaiting_approval';
            if (
              context.savePendingAction &&
              !(await context.savePendingAction({
                stepId: step.id,
                json: JSON.stringify({ tool: action.tool, input: action.input }),
                callId,
                ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
              }))
            ) {
              return cancelled();
            }
            state.observations[step.id] = [...observations];
            if (!(await persistState())) return cancelled();
            report({
              type: 'approval.required',
              requestId: outcome.requestId ?? callId,
              tool: action.tool,
              description: bounded(`Approval is required for ${action.tool}.`, 2000),
            });
            // Completed sections were already emitted as they finished; the
            // suspension adds no duplicate delta.
            return {
              ok: false,
              code: 'approval_required',
              detail: outcome.result.ok
                ? 'Owner approval is required to continue this run.'
                : outcome.result.detail,
              retryable: true,
            };
          }

          intent.state = 'completed';
          intent.ok = outcome.result.ok;
          intent.output = bounded(
            outcome.result.ok ? outcome.result.output : `${outcome.result.code}: ${outcome.result.detail}`,
            2000,
          );
          if (outcome.result.ok) {
            observations.push(`Tool ${action.tool} succeeded:\n${bounded(outcome.result.output, 4000)}`);
          } else {
            observations.push(
              `Tool ${action.tool} failed (${outcome.result.code}): ${bounded(outcome.result.detail, 1000)}`,
            );
          }
          toolLedger.push({ callId, tool: action.tool, ok: outcome.result.ok, digest });

          // The pending action is settled now that the call has an outcome. A
          // replay that was denied or rejected is also cleared, so it cannot be
          // replayed again on a later resume.
          if (pending && pending.stepId === step.id) {
            if (context.savePendingAction && !(await context.savePendingAction(null))) {
              return cancelled();
            }
            pending = null;
          }
          state.observations[step.id] = [...observations];
          if (!(await persistState())) return cancelled();
        }

        if (stepText.length === 0) {
          // Recovery: report what the engine actually recorded instead of
          // inventing an answer the tools never produced. Completed calls are
          // quoted from the durable ledger, not from the model's narration.
          const recorded = state.executed.filter(
            (entry) => entry.stepId === step.id && entry.state === 'completed',
          );
          const evidence = recorded.map(
            (entry) => `- ${entry.tool} ${entry.ok ? 'succeeded' : 'failed'}: ${bounded(entry.output, 800)}`,
          );
          stepText =
            recorded.length > 0
              ? `Step "${step.title}" did not produce a final answer. Engine-recorded tool results:\n${evidence.join('\n')}`
              : observations.length > 0
                ? `Step "${step.title}" did not produce a final answer. Recorded observations:\n${observations
                    .slice(-3)
                    .join('\n')}`
                : `Step "${step.title}" produced no result.`;
        }

        sections.push(stepText);
        results.push({ id: step.id, title: step.title, text: stepText });
        report({ type: 'text.delta', text: stepText });
        report({ type: 'step.completed', stepId: step.id, title: step.title, output: stepText });
        completed.add(step.id);
        if (context.saveStepResult && !(await context.saveStepResult({ id: step.id, title: step.title, text: stepText }))) {
          return cancelled();
        }
      }

      // Completion is verified against the durable plan, not the model's claim.
      const incomplete = steps.filter((step) => !completed.has(step.id)).map((step) => step.id);
      if (request.signal.aborted) return cancelled();
      if (incomplete.length > 0) {
        return {
          ok: false,
          code: 'verification_failed',
          detail: `The run did not complete ${incomplete.length} planned step(s): ${incomplete.join(', ')}.`,
          retryable: true,
          requests: modelRequests,
        };
      }

      const evidence =
        toolLedger.length > 0
          ? `\n\nEngine-recorded actions:\n${toolLedger
              .map((entry) => `- ${entry.tool} ${entry.ok ? 'succeeded' : 'failed'} (${entry.callId})`)
              .join('\n')}`
          : '';
      const summary = `${sections.join('\n\n').trim()}${evidence}`.trim();
      const usage = usageOf(totals);
      return {
        ok: true,
        summary: summary.length > 0 ? summary : 'The objective produced no content.',
        ...(usage ? { usage } : {}),
        requests: modelRequests,
      };
    },
  };
}

/** Reads the declared policy without letting a model influence it. */
function toolsPolicy(
  name: string,
  runtime: { get: (name: string) => { approval: 'never' | 'once' | 'always' } | null },
): 'never' | 'once' | 'always' {
  return runtime.get(name)?.approval ?? 'once';
}
