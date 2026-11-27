import type { AgentHistoryTurn } from '../types.js';
import type { PlanStep } from './types.js';

/**
 * The gateway port takes one prompt, so the engine owns the transcript format
 * rather than mapping turns onto provider-specific chat roles. Roles are spelled
 * out for the same reason: a different provider must not change what the model
 * is told about who said what.
 */
export function renderHistory(turns: AgentHistoryTurn[]): string {
  return turns
    .map((turn) => `${turn.role === 'user' ? 'Owner' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
}

/**
 * One step's prompt. Earlier turns are included only when the conversation has
 * them, so the first turn is unchanged by the feature.
 */
export function buildStepPrompt(input: {
  objective: string;
  step: PlanStep;
  completed: string[];
  history: AgentHistoryTurn[];
}): string {
  const sections: string[] = [];
  if (input.history.length > 0) {
    sections.push(`Earlier in this conversation:\n\n${renderHistory(input.history)}`);
  }
  sections.push(`Objective:\n${input.objective}`);
  sections.push(`Current step (${input.step.id}): ${input.step.title}`);
  sections.push(
    `Completed steps: ${input.completed.length > 0 ? input.completed.join(', ') : 'none'}`,
  );
  return sections.join('\n\n');
}
