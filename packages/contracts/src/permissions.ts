import { z } from 'zod';
import {
  AgentId,
  ConversationId,
  DataMode,
  IsoDateTime,
  RequestId,
  TaskId,
} from './primitives.js';
import { ScheduleNotice } from './schedules.js';

/**
 * A permission request is the only way an agent obtains something it was not
 * already granted. External agents start with no private memory, no credentials
 * and no conversations, and a grant is scoped to one request.
 */
export const PermissionScope = z.enum([
  'memory.write',
  'knowledge.read',
  'knowledge.write',
  'browser.use',
  'workspace.read',
  'workspace.write',
  'command.execute',
  'network.access',
  'memory.read',
  'conversation.read',
  'credential.use',
  'browser.use',
  'browser.control',
  'browser.transfer',
]);
export type PermissionScope = z.infer<typeof PermissionScope>;

export const PermissionRequest = z
  .object({
    requestId: RequestId,
    taskId: TaskId,
    agent: AgentId,
    scope: PermissionScope,
    /** What the agent wants to do, in owner-readable terms. */
    description: z.string().min(1).max(2000),
    /** Exact resource named by the request; a grant never widens it. */
    resource: z.string().min(1).max(1024),
    requestedAt: IsoDateTime,
    expiresAt: IsoDateTime,
    decision: z.enum(['pending', 'approved', 'denied']),
    decidedAt: IsoDateTime.optional(),
  })
  .strict();
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionList = z
  .object({ requests: z.array(PermissionRequest) })
  .strict();
export type PermissionList = z.infer<typeof PermissionList>;

export const PermissionDecisionRequest = z
  .object({
    requestId: RequestId,
    decision: z.enum(['approved', 'denied']),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type PermissionDecisionRequest = z.infer<typeof PermissionDecisionRequest>;

/**
 * Completion notifications drive the blue-dot unread indicator. They are durable
 * so a client that was closed when the task finished still learns about it.
 */
export const CompletionNotification = z
  .object({
    taskId: TaskId,
    conversationId: ConversationId,
    agent: AgentId,
    mode: DataMode,
    state: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    summary: z.string().max(500).optional(),
    createdAt: IsoDateTime,
    read: z.boolean(),
  })
  .strict();
export type CompletionNotification = z.infer<typeof CompletionNotification>;

export const NotificationResponse = z
  .object({
    notifications: z.array(CompletionNotification),
    /**
     * Schedule notices share this endpoint and this unread count. A schedule can
     * fail before a Work task exists, so it cannot be represented as a
     * CompletionNotification; it is not a second notification authority, just a
     * second record kind behind the same owner-facing surface.
     */
    schedules: z.array(ScheduleNotice).optional(),
    unread: z.number().int().nonnegative(),
  })
  .strict();
export const NotificationList = NotificationResponse.extend({ schedules: z.array(ScheduleNotice).default([]) });
export type NotificationList = z.infer<typeof NotificationList>;
