import { z } from 'zod';
import {
  AgentId,
  EngineFailureCode,
  EVENT_SCHEMA_VERSION,
  IsoDateTime,
  ModelRef,
  TaskId,
  Usage,
} from './primitives.js';

/**
 * Execution events are versioned independently from HTTP contracts. Every
 * envelope carries a stable event id and a per-task sequence number, so a
 * consumer can deduplicate a replayed event and detect an out-of-order one
 * instead of applying it twice.
 */
export const ExecutionEventType = z.enum([
  'task.queued',
  'task.started',
  'step.started',
  'step.completed',
  'text.delta',
  'text.replace',
  'tool.call',
  'tool.result',
  'approval.required',
  'usage',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
]);
export type ExecutionEventType = z.infer<typeof ExecutionEventType>;

const envelope = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  eventId: z.string().min(1).max(120),
  taskId: TaskId,
  /** Monotonic per task, starting at 1. A gap means a dropped event, not a reset. */
  seq: z.number().int().positive(),
  at: IsoDateTime,
  agent: AgentId,
  generation: z.number().int().nonnegative(),
};

const stepPayload = z
  .object({ stepId: z.string().min(1).max(80), title: z.string().max(200) })
  .strict();

export const ExecutionEvent = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('task.queued') }).strict(),
  z.object({ ...envelope, type: z.literal('task.started') }).strict(),
  z.object({ ...envelope, type: z.literal('step.started'), payload: stepPayload }).strict(),
  z
    .object({ ...envelope, type: z.literal('step.completed'), payload: stepPayload })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.delta'),
      payload: z.object({ text: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('text.replace'),
      payload: z.object({ text: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('tool.call'),
      payload: z
        .object({
          callId: z.string().min(1).max(120),
          tool: z.string().min(1).max(80),
          input: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('tool.result'),
      payload: z
        .object({
          callId: z.string().min(1).max(120),
          tool: z.string().min(1).max(80),
          ok: z.boolean(),
          output: z.string().max(20_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('approval.required'),
      payload: z
        .object({
          requestId: z.string().min(1).max(120),
          tool: z.string().min(1).max(80),
          description: z.string().max(2000),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal('usage'), payload: Usage }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('task.completed'),
      payload: z
        .object({
          summary: z.string().max(20_000).optional(),
          model: ModelRef.optional(),
          usage: Usage.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('task.failed'),
      payload: z
        .object({
          code: EngineFailureCode,
          detail: z.string().max(1000).optional(),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('task.cancelled'),
      payload: z.object({ reason: z.string().max(500).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('task.interrupted'),
      payload: z.object({ detail: z.string().max(500) }).strict(),
    })
    .strict(),
]);
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

export const TERMINAL_EVENT_TYPES: readonly ExecutionEventType[] = [
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
];

export function isTerminalEvent(type: ExecutionEventType): boolean {
  return TERMINAL_EVENT_TYPES.includes(type);
}
