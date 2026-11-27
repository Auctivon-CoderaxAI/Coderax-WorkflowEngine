import type { TaskState, Usage } from '@coderax/contracts';
import type { ExecutionReceipt, TaskRecord } from '../domain.js';

/**
 * Receipt construction is a pure function of engine-owned facts: the task
 * record, the steps it actually ran, and the tool calls the runtime dispatched.
 * Model output is deliberately absent, so a receipt cannot be fabricated by a
 * prompt.
 */
export type ToolLedgerEntry = {
  callId: string;
  tool: string;
  ok: boolean;
  digest: string;
};

export function createReceipt(input: {
  receiptId: string;
  task: TaskRecord;
  state: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  steps: Array<{ id: string; title: string; state: TaskState }>;
  toolCalls: ToolLedgerEntry[];
  planDigest: string;
  usage?: Usage;
  requests?: number;
}): ExecutionReceipt {
  return {
    receiptId: input.receiptId,
    taskId: input.task.taskId,
    generation: input.task.generation,
    agent: input.task.agent,
    engine: input.task.engine,
    mode: input.task.mode,
    ...(input.task.model ? { model: input.task.model } : {}),
    state: input.state,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.requests !== undefined ? { requests: input.requests } : {}),
    steps: input.steps.slice(0, 128).map((step) => ({
      id: step.id,
      title: step.title.slice(0, 200),
      state: step.state,
    })),
    toolCalls: input.toolCalls.slice(0, 256),
    planDigest: input.planDigest,
  };
}
