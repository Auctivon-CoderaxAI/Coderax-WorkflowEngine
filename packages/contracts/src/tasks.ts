import { z } from 'zod';
import { Budget } from './models.js';
import { ExecutionReceipt } from './receipts.js';
import {
  AgentId,
  ConversationId,
  DataMode,
  IsoDateTime,
  MessageId,
  ModelRef,
  TaskId,
  TaskState,
  Usage,
} from './primitives.js';

export const ChatRequest = z
  .object({
    message: z.string().min(1).max(200_000),
    conversationId: ConversationId.optional(),
    agent: AgentId.default('coderax'),
    model: ModelRef.optional(),
    mode: DataMode.default('private'),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatReply = z
  .object({
    conversationId: ConversationId,
    messageId: MessageId,
    text: z.string(),
    agent: AgentId,
    model: ModelRef,
    usage: Usage.optional(),
    createdAt: IsoDateTime,
  })
  .strict();
export type ChatReply = z.infer<typeof ChatReply>;

/**
 * Submitting Work creates a durable task. The response is returned as soon as
 * ownership is recorded, so the caller may disconnect immediately: closing a
 * browser or a terminal never terminates an authorized task.
 */
export const WorkSubmitRequest = z
  .object({
    objective: z.string().min(1).max(200_000),
    conversationId: ConversationId.optional(),
    /** Omitted means Coderax Native. An external agent must be named explicitly. */
    agent: AgentId.optional(),
    model: ModelRef.optional(),
    mode: DataMode.default('cloud'),
    budget: Budget.optional(),
    /** Refuse the run rather than wait when a tool needs an owner decision. */
    requireApproval: z.boolean().default(true),
  })
  .strict();
export type WorkSubmitRequest = z.infer<typeof WorkSubmitRequest>;

export const Artifact = z
  .object({
    path: z.string().min(1).max(1024),
    bytes: z.number().int().nonnegative().optional(),
    digest: z.string().min(1).max(128).optional(),
  })
  .strict();
export type Artifact = z.infer<typeof Artifact>;

export const TaskStatus = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    state: TaskState,
    agent: AgentId,
    mode: DataMode,
    model: ModelRef.optional(),
    /** The fencing generation currently authorized to write this task's state. */
    generation: z.number().int().nonnegative(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    leaseExpiresAt: IsoDateTime.optional(),
    cancelRequested: z.boolean(),
    steps: z.array(
      z.object({ id: z.string().min(1).max(80), title: z.string().max(200), state: TaskState }).strict(),
    ),
    result: z
      .object({
        summary: z.string().max(20_000).optional(),
        artifacts: z.array(Artifact),
      })
      .strict()
      .optional(),
    usage: Usage.optional(),
    /** Engine ledger of steps and dispatched calls; never model narrative. */
    receipt: ExecutionReceipt.optional(),
    failure: z
      .object({ code: z.string().min(1).max(60), detail: z.string().max(1000).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskAccepted = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    state: TaskState,
    generation: z.number().int().nonnegative(),
    eventsPath: z.string().min(1).max(300),
  })
  .strict();
export type TaskAccepted = z.infer<typeof TaskAccepted>;

export const CancelRequest = z.object({ reason: z.string().max(500).optional() }).strict();
export type CancelRequest = z.infer<typeof CancelRequest>;

export const TaskControlResult = z
  .object({
    taskId: TaskId,
    state: TaskState,
    generation: z.number().int().nonnegative(),
    /** What the engine actually did, not what the caller asked for. */
    outcome: z.enum(['accepted', 'already_terminal', 'not_found', 'superseded']),
  })
  .strict();
export type TaskControlResult = z.infer<typeof TaskControlResult>;

export const RetryRequest = z
  .object({ generation: z.number().int().nonnegative(), model: ModelRef.optional() })
  .strict();
export type RetryRequest = z.infer<typeof RetryRequest>;

export const ResumeRequest = z
  .object({ generation: z.number().int().nonnegative() })
  .strict();
export type ResumeRequest = z.infer<typeof ResumeRequest>;

export const Message = z
  .object({
    messageId: MessageId,
    conversationId: ConversationId,
    role: z.enum(['user', 'assistant', 'tool']),
    text: z.string(),
    createdAt: IsoDateTime,
    unfinished: z.boolean().optional(),
    agent: AgentId.optional(),
  })
  .strict();
export type Message = z.infer<typeof Message>;

export const Conversation = z
  .object({
    conversationId: ConversationId,
    title: z.string().max(300).optional(),
    mode: DataMode,
    isWork: z.boolean(),
    agent: AgentId,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    messages: z.array(Message),
  })
  .strict();
export type Conversation = z.infer<typeof Conversation>;

export const ConversationSummary = z
  .object({
    conversationId: ConversationId,
    title: z.string().max(300).optional(),
    isWork: z.boolean(),
    agent: AgentId,
    updatedAt: IsoDateTime,
  })
  .strict();
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationList = z
  .object({ conversations: z.array(ConversationSummary) })
  .strict();
export type ConversationList = z.infer<typeof ConversationList>;

export const MemoryEntry = z
  .object({
    key: z.string().min(1).max(200),
    value: z.string().max(20_000),
    mode: DataMode,
    updatedAt: IsoDateTime,
  })
  .strict();
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryList = z.object({ entries: z.array(MemoryEntry) }).strict();
export type MemoryList = z.infer<typeof MemoryList>;
