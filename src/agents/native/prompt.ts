import type { AgentHistoryTurn } from '../types.js';
import type { PlanStep } from './types.js';

/**
 * The gateway takes one prompt, so the engine owns the transcript format. Roles
 * are spelled out rather than mapped onto provider-specific chat roles, so a
 * different zero-cost provider cannot change what the model is told about who
 * said what.
 */
export function renderHistory(turns: AgentHistoryTurn[]): string {
  return turns
    .map((turn) => `${turn.role === 'user' ? 'Owner' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
}

export function buildPlanPrompt(input: {
  objective: string;
  maxSteps: number;
  history?: AgentHistoryTurn[];
}): string {
  const history = input.history ?? [];
  return [
    ...(history.length > 0
      ? [`Earlier in this conversation:\n\n${renderHistory(history)}`, '']
      : []),
    `Break this objective into at most ${input.maxSteps} concrete steps.`,
    'Return ONLY a JSON array of step titles, for example ["Read the file","Fix the bug"].',
    'Do not include prose, numbering, or markdown fences.',
    '',
    'Objective:',
    input.objective.slice(0, 20_000),
  ].join('\n');
}

const ACTION_SYSTEM = [
  'You are Coderax Native, the owner’s private execution agent.',
  'You act by returning exactly one JSON object and nothing else.',
  'To use a tool: {"thought":"why","tool":"tool.name","input":{...}}',
  'To finish the current step: {"thought":"why","final":"the concrete result"}.',
  'Use only tools from the catalogue. Never invent a tool name.',
  'If a tool fails, read the observation and choose a different action.',
  'Do not describe what you would do; either call a tool or return the result.',
].join(' ');

export function buildActionPrompt(input: {
  objective: string;
  steps: PlanStep[];
  step: PlanStep;
  completed: string[];
  history: AgentHistoryTurn[];
  observations: string[];
  memory: string[];
  knowledge: string[];
  catalogue: string;
}): string {
  const sections: string[] = [];
  if (input.history.length > 0) {
    sections.push(`Earlier in this conversation:\n\n${renderHistory(input.history)}`);
  }
  sections.push(`Objective:\n${input.objective.slice(0, 20_000)}`);
  sections.push(
    `Plan:\n${input.steps.map((step, index) => `${index + 1}. [${step.id}] ${step.title}`).join('\n')}`,
  );
  sections.push(`Current step (${input.step.id}): ${input.step.title}`);
  sections.push(
    `Completed steps: ${input.completed.length > 0 ? input.completed.join(', ') : 'none'}`,
  );
  if (input.memory.length > 0) {
    sections.push(`Owner memory:\n${input.memory.map((entry) => `- ${entry}`).join('\n')}`);
  }
  if (input.knowledge.length > 0) {
    sections.push(`Relevant stored passages:\n${input.knowledge.join('\n---\n')}`);
  }
  sections.push(`Tool catalogue:\n${input.catalogue.length > 0 ? input.catalogue : '(no tools)'}`);
  if (input.observations.length > 0) {
    sections.push(
      `Observations from your actions in this step (oldest first):\n${input.observations
        .slice(-6)
        .join('\n')}`,
    );
  }
  sections.push('Return one JSON object now.');
  return sections.join('\n\n');
}

export const NATIVE_ACTION_SYSTEM = ACTION_SYSTEM;
