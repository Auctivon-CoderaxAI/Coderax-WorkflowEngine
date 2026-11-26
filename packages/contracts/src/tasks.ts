import { z } from 'zod';
import { ProblemCode } from './errors.js';
import { Budget } from './models.js';
import {
  AgentId,
  CHAT_STREAM_VERSION,
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
/** What a caller may send: defaulted fields are optional on the wire. */
export type ChatRequestInput = z.input<typeof ChatRequest>;

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
 * Chat streaming is a separate, versioned frame type rather than an execution
 * event. A chat turn is not durable and has no task id, so reusing the event
 * envelope would teach a client to expect `taskId` and `seq` on something that
 * can never have them. `chat.completed` and `chat.failed` are terminal.
 */
export const ChatStreamEvent = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(CHAT_STREAM_VERSION),
      type: z.literal('chat.started'),
      conversationId: ConversationId,
      messageId: MessageId,
      agent: AgentId,
      model: ModelRef,
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_VERSION),
      type: z.literal('chat.delta'),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_VERSION),
      type: z.literal('chat.replace'),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_VERSION),
      type: z.literal('chat.completed'),
      reply: ChatReply,
    })
    .strict(),
  z
    .object({
      v: z.literal(CHAT_STREAM_VERSION),
      type: z.literal('chat.failed'),
      code: ProblemCode,
      detail: z.string().max(1000).optional(),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

export const TERMINAL_CHAT_EVENT_TYPES: readonly ChatStreamEvent['type'][] = [
  'chat.completed',
  'chat.failed',
];

export function isTerminalChatEvent(type: ChatStreamEvent['type']): boolean {
  return TERMINAL_CHAT_EVENT_TYPES.includes(type);
}

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
    /**
     * A caller-chosen key that makes a submission safe to retry. A repeat with
     * the same key returns the original task instead of starting a second run
     * for a request whose response the caller never saw.
     */
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'idempotencyKey must be url-safe')
      .optional(),
  })
  .strict();
export type WorkSubmitRequest = z.infer<typeof WorkSubmitRequest>;
export type WorkSubmitRequestInput = z.input<typeof WorkSubmitRequest>;

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
    failure: z
      .object({ code: z.string().min(1).max(60), detail: z.string().max(1000).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A list row. Deliberately smaller than TaskStatus: a list is not a detail view. */
export const TaskSummary = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    title: z.string().max(300),
    state: TaskState,
    agent: AgentId,
    mode: DataMode,
    model: ModelRef.optional(),
    generation: z.number().int().nonnegative(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    cancelRequested: z.boolean(),
  })
  .strict();
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskListQuery = z
  .object({
    state: TaskState.optional(),
    conversationId: ConversationId.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type TaskListQuery = z.infer<typeof TaskListQuery>;

export const TaskList = z.object({ tasks: z.array(TaskSummary) }).strict();
export type TaskList = z.infer<typeof TaskList>;

export const TaskAccepted = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    state: TaskState,
    generation: z.number().int().nonnegative(),
    eventsPath: z.string().min(1).max(300),
    /** True when an idempotency key replayed an earlier accepted submission. */
    replayed: z.boolean().optional(),
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

export const MemoryWriteRequest = z
  .object({
    key: z.string().trim().min(1).max(200),
    value: z.string().max(20_000),
    mode: DataMode.default('private'),
  })
  .strict();
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequest>;
export type MemoryWriteRequestInput = z.input<typeof MemoryWriteRequest>;

export const MemoryDeleteRequest = z
  .object({
    key: z.string().trim().min(1).max(200),
    mode: DataMode.default('private'),
  })
  .strict();
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteRequest>;
export type MemoryDeleteRequestInput = z.input<typeof MemoryDeleteRequest>;

export const MemorySearchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    mode: z.enum(['private', 'cloud']).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type MemorySearchQuery = z.infer<typeof MemorySearchQuery>;

export const MemoryMatch = z
  .object({
    key: z.string().min(1).max(200),
    value: z.string().max(20_000),
    mode: DataMode,
    updatedAt: IsoDateTime,
    /** Number of query terms found, then a bounded length tie-break. */
    score: z.number().nonnegative(),
  })
  .strict();
export type MemoryMatch = z.infer<typeof MemoryMatch>;

export const MemorySearchResult = z
  .object({
    query: z.string().min(1).max(200),
    matches: z.array(MemoryMatch),
  })
  .strict();
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;
