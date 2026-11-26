import { z } from 'zod';
import { AgentId, DataMode, EngineId, IsoDateTime, ModelRef, TaskId, TaskState, Usage } from './primitives.js';

/**
 * An execution receipt is the engine's record of what actually happened. It is
 * written from the engine's own ledger (the steps it ran and the tool calls it
 * dispatched), never from model text, so a summary cannot invent work that no
 * receipt entry supports.
 */
export const ExecutionReceipt = z
  .object({
    receiptId: z.string().min(1).max(128),
    taskId: TaskId,
    generation: z.number().int().nonnegative(),
    agent: AgentId,
    engine: EngineId,
    mode: DataMode,
    model: ModelRef.optional(),
    state: z.enum(['completed', 'failed', 'cancelled']),
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime,
    usage: Usage.optional(),
    /** Model requests observed by the engine; omitted when it cannot count them. */
    requests: z.number().int().nonnegative().optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            title: z.string().max(200),
            state: TaskState,
          })
          .strict(),
      )
      .max(128),
    toolCalls: z
      .array(
        z
          .object({
            callId: z.string().min(1).max(120),
            tool: z.string().min(1).max(120),
            ok: z.boolean(),
            /** Digest of the arguments, never the arguments themselves. */
            digest: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(256),
    planDigest: z.string().min(1).max(128),
  })
  .strict();
export type ExecutionReceipt = z.infer<typeof ExecutionReceipt>;
