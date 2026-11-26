import { z } from 'zod';
import { Budget } from './models.js';
import {
  AgentId,
  ConversationId,
  DataMode,
  IdempotencyKey,
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
    /**
     * A repeated submission with the same key returns the task the first one
     * created. The key is scoped to the owner, so two owners can never collide.
     */
    idempotencyKey: IdempotencyKey.optional(),
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
    /** The data partition this conversation belongs to; clients never mix them. */
    mode: DataMode,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .strict();
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationList = z
  .object({
    conversations: z.array(ConversationSummary),
    /** Rows matching the filter, independent of the current page. */
    total: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type ConversationList = z.infer<typeof ConversationList>;

export const ConversationListQuery = z
  .object({
    mode: DataMode.optional(),
    isWork: z.enum(['true', 'false']).optional(),
    agent: AgentId.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

/**
 * Authorized deletion of one conversation and its cascade.
 *
 * There is no automatic retention for conversations, transcripts or tasks; this
 * is the only path that removes them, and it requires an owner decision.
 */
export const ConversationDeletion = z
  .object({
    conversationId: ConversationId,
    deleted: z.boolean(),
    messagesDeleted: z.number().int().nonnegative(),
    tasksDeleted: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationDeletion = z.infer<typeof ConversationDeletion>;

export const ConversationDeleteParams = z.object({ conversationId: ConversationId }).strict();

export const MemoryEntry = z
  .object({
    key: z.string().min(1).max(200),
    value: z.string().max(20_000),
    mode: DataMode,
    updatedAt: IsoDateTime,
  })
  .strict();
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryList = z
  .object({
    entries: z.array(MemoryEntry),
    nextCursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type MemoryList = z.infer<typeof MemoryList>;

/**
 * Writing memory over HTTP is explicit and owner-scoped. It is not retrieval:
 * the returned entry is exact key/value storage in one data mode, and the
 * handshake reports retrieval augmentation as unavailable.
 */
export const MemoryPutRequest = z
  .object({
    key: z.string().trim().min(1).max(200),
    value: z.string().max(20_000),
    mode: DataMode.default('private'),
  })
  .strict();
export type MemoryPutRequest = z.infer<typeof MemoryPutRequest>;

export const MemoryListQuery = z
  .object({
    mode: DataMode.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type MemoryListQuery = z.infer<typeof MemoryListQuery>;

export const MemoryKeyParams = z.object({ key: z.string().trim().min(1).max(200) }).strict();

export const MemoryDeletion = z
  .object({
    key: z.string().min(1).max(200),
    mode: DataMode,
    deleted: z.boolean(),
  })
  .strict();
export type MemoryDeletion = z.infer<typeof MemoryDeletion>;

/** The task read model. It is a projection, not a second task record. */
export const TaskSummary = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    objective: z.string().min(1).max(200_000),
    state: TaskState,
    agent: AgentId,
    mode: DataMode,
    generation: z.number().int().nonnegative(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    cancelRequested: z.boolean(),
  })
  .strict();
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z
  .object({
    tasks: z.array(TaskSummary),
    /** Rows matching the filter, independent of the current page. */
    total: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type TaskList = z.infer<typeof TaskList>;

/** Owner-scoped Work discovery: one filter set, one ordering, one cursor. */
export const TaskListQuery = z
  .object({
    state: TaskState.optional(),
    mode: DataMode.optional(),
    agent: AgentId.optional(),
    conversationId: ConversationId.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type TaskListQuery = z.infer<typeof TaskListQuery>;
