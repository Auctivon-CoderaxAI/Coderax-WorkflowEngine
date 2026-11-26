import type { z } from 'zod';
import { z as zod } from 'zod';
import { ArtifactContent, ArtifactList, ArtifactRecord, ArtifactUploadRequest } from './artifacts.js';
import { AgentList } from './capabilities.js';
import { ChatStreamFrame } from './chat.js';
import { Problem } from './errors.js';
import { ExecutionEvent } from './events.js';
import { EngineHandshake } from './handshake.js';
import { HealthReport, ReadinessReport } from './health.js';
import { ModelList } from './models.js';
import {
  CreativeValidation,
  CreativeValidationRequest,
  MediaCapabilities,
  MediaDownload,
  MediaId,
  MediaUploadRequest,
  MediaUploadResult,
} from './media.js';
import {
  NotificationList,
  NotificationReadRequest,
  PermissionDecisionRequest,
  PermissionList,
} from './permissions.js';
import { ArtifactId, ConversationId, ScheduleId, TaskId, TaskState } from './primitives.js';
import { Schedule, ScheduleControlResult, ScheduleCreateRequest, ScheduleList } from './schedules.js';
import {
  CancelRequest,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  MemoryEntry,
  MemoryList,
  MemoryPutRequest,
  ResumeRequest,
  RetryRequest,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
  WorkSubmitRequest,
} from './tasks.js';

/**
 * The single authoritative HTTP surface.
 *
 * The engine may only register routes that appear here, and a contract test
 * asserts the registered table and this catalogue are the same set. The OpenAPI
 * document is generated from this list, so documentation, server validation and
 * the SDK cannot drift apart.
 *
 * Only an operation with a real server implementation is published. A subsystem
 * whose implementation still lives on an unmerged branch is reported by the
 * handshake as `unsupported`, never described as a route the engine cannot
 * answer.
 */

export type RouteMethod = 'GET' | 'POST';

export type RouteAuth = 'owner' | 'public';

export type RouteSpec = {
  operationId: string;
  method: RouteMethod;
  path: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  /** Every operation can also answer with a Problem. */
  response: { status: number; description: string; schema: z.ZodTypeAny };
  /** Server-sent events rather than a single JSON body. */
  stream?: boolean;
  /** The frame schema for an SSE response; validated before it is written. */
  frames?: z.ZodTypeAny;
  /**
   * A streaming operation that also answers JSON when the client does not send
   * `Accept: text/event-stream`. Shape reserved by `feat/intelligence-core`.
   */
  negotiated?: boolean;
};

const TaskParams = zod.object({ taskId: TaskId }).strict();
const ConversationParams = zod.object({ conversationId: ConversationId }).strict();
const MediaParams = zod.object({ mediaId: MediaId }).strict();
const ScheduleParams = zod.object({ scheduleId: ScheduleId }).strict();
const ArtifactParams = zod.object({ artifactId: ArtifactId }).strict();

export const ROUTES: readonly RouteSpec[] = Object.freeze([
  {
    operationId: 'getHealth',
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness and dependency health for the engine.',
    tags: ['health'],
    auth: 'public',
    response: { status: 200, description: 'Health report', schema: HealthReport },
  },
  {
    operationId: 'getReadiness',
    method: 'GET',
    path: '/v1/ready',
    summary: 'Whether the engine finished startup validation.',
    tags: ['health'],
    auth: 'public',
    response: { status: 200, description: 'Readiness report', schema: ReadinessReport },
  },
  {
    operationId: 'getHandshake',
    method: 'GET',
    path: '/v1/handshake',
    summary: 'Contract version, event version and the operations this engine implements.',
    tags: ['health'],
    auth: 'public',
    response: { status: 200, description: 'Version and capability handshake', schema: EngineHandshake },
  },
  {
    operationId: 'listAgents',
    method: 'GET',
    path: '/v1/agents',
    summary: 'Discover the three agent identities and their truthful availability.',
    tags: ['discovery'],
    auth: 'owner',
    response: { status: 200, description: 'Agent list', schema: AgentList },
  },
  {
    operationId: 'listModels',
    method: 'GET',
    path: '/v1/models',
    summary: 'Discover models, cost class and the zero-cost route.',
    tags: ['discovery'],
    auth: 'owner',
    response: { status: 200, description: 'Model list', schema: ModelList },
  },
  {
    operationId: 'getMediaCapabilities',
    method: 'GET',
    path: '/v1/media/capabilities',
    summary: 'What image, audio, video, document and creative handling is actually available.',
    tags: ['media'],
    auth: 'owner',
    response: { status: 200, description: 'Media capabilities', schema: MediaCapabilities },
  },
  {
    operationId: 'uploadMedia',
    method: 'POST',
    path: '/v1/media',
    summary: 'Upload one owner-scoped image; the format is identified from its header.',
    tags: ['media'],
    auth: 'owner',
    body: MediaUploadRequest,
    response: { status: 201, description: 'Stored media', schema: MediaUploadResult },
  },
  {
    operationId: 'getMedia',
    method: 'GET',
    path: '/v1/media/{mediaId}',
    summary: 'Read one owner-scoped media item and its canonical base64 bytes.',
    tags: ['media'],
    auth: 'owner',
    params: MediaParams,
    response: { status: 200, description: 'Media bytes', schema: MediaDownload },
  },
  {
    operationId: 'validateCreative',
    method: 'POST',
    path: '/v1/creative/validate',
    summary: 'Validate a generated SVG or HTML draft against the sandboxed-render allowlist.',
    tags: ['creative'],
    auth: 'owner',
    body: CreativeValidationRequest,
    response: { status: 200, description: 'Validation result', schema: CreativeValidation },
  },
  {
    operationId: 'submitChat',
    method: 'POST',
    path: '/v1/chat',
    summary: 'One Chat turn. Streams typed SSE frames when the client accepts them.',
    tags: ['chat'],
    auth: 'owner',
    body: ChatRequest,
    stream: true,
    negotiated: true,
    frames: ChatStreamFrame,
    response: { status: 200, description: 'Chat reply or typed chat frames', schema: ChatReply },
  },
  {
    operationId: 'submitWork',
    method: 'POST',
    path: '/v1/work',
    summary: 'Submit an idempotent durable Work task; returns before execution finishes.',
    tags: ['work'],
    auth: 'owner',
    body: WorkSubmitRequest,
    response: { status: 202, description: 'Task accepted', schema: TaskAccepted },
  },
  {
    operationId: 'getTask',
    method: 'GET',
    path: '/v1/work/{taskId}',
    summary: 'Authoritative task status, including terminal state and failure.',
    tags: ['work'],
    auth: 'owner',
    params: TaskParams,
    response: { status: 200, description: 'Task status', schema: TaskStatus },
  },
  {
    operationId: 'listTasks',
    method: 'GET',
    path: '/v1/tasks',
    summary: 'Owner-scoped task read model, newest first.',
    tags: ['work'],
    auth: 'owner',
    query: zod
      .object({
        limit: zod.coerce.number().int().min(1).max(200).optional(),
        state: TaskState.optional(),
      })
      .strict(),
    response: { status: 200, description: 'Task list', schema: TaskList },
  },
  {
    operationId: 'cancelTask',
    method: 'POST',
    path: '/v1/work/{taskId}/cancel',
    summary: 'Request cancellation. Safe from any replica and after disconnect.',
    tags: ['work'],
    auth: 'owner',
    params: TaskParams,
    body: CancelRequest,
    response: { status: 200, description: 'Cancellation outcome', schema: TaskControlResult },
  },
  {
    operationId: 'resumeTask',
    method: 'POST',
    path: '/v1/work/{taskId}/resume',
    summary: 'Resume a suspended or interrupted task from its last checkpoint.',
    tags: ['work'],
    auth: 'owner',
    params: TaskParams,
    body: ResumeRequest,
    response: { status: 200, description: 'Resume outcome', schema: TaskControlResult },
  },
  {
    operationId: 'retryTask',
    method: 'POST',
    path: '/v1/work/{taskId}/retry',
    summary: 'Retry a failed task on the same engine with a new generation.',
    tags: ['work'],
    auth: 'owner',
    params: TaskParams,
    body: RetryRequest,
    response: { status: 200, description: 'Retry outcome', schema: TaskControlResult },
  },
  {
    operationId: 'streamTaskEvents',
    method: 'GET',
    path: '/v1/work/{taskId}/events',
    summary: 'Replay and tail execution events from a sequence cursor.',
    tags: ['events'],
    auth: 'owner',
    params: TaskParams,
    query: zod.object({ after: zod.coerce.number().int().nonnegative().optional() }).strict(),
    stream: true,
    frames: ExecutionEvent,
    response: { status: 200, description: 'Server-sent execution events', schema: ExecutionEvent },
  },
  {
    operationId: 'listConversations',
    method: 'GET',
    path: '/v1/conversations',
    summary: 'Conversation history shared by web and CLI clients.',
    tags: ['conversations'],
    auth: 'owner',
    response: { status: 200, description: 'Conversation list', schema: ConversationList },
  },
  {
    operationId: 'getConversation',
    method: 'GET',
    path: '/v1/conversations/{conversationId}',
    summary: 'One conversation with its persisted messages.',
    tags: ['conversations'],
    auth: 'owner',
    params: ConversationParams,
    response: { status: 200, description: 'Conversation', schema: Conversation },
  },
  {
    operationId: 'listMemory',
    method: 'GET',
    path: '/v1/memory',
    summary: 'Owner-scoped memory for the requested data mode.',
    tags: ['memory'],
    auth: 'owner',
    query: zod.object({ mode: zod.enum(['private', 'cloud']).optional() }).strict(),
    response: { status: 200, description: 'Memory entries', schema: MemoryList },
  },
  {
    operationId: 'putMemory',
    method: 'POST',
    path: '/v1/memory',
    summary: 'Write one exact key/value memory entry in a data mode.',
    tags: ['memory'],
    auth: 'owner',
    body: MemoryPutRequest,
    response: { status: 200, description: 'Stored memory entry', schema: MemoryEntry },
  },
  {
    operationId: 'listPermissions',
    method: 'GET',
    path: '/v1/work/{taskId}/permissions',
    summary: 'Pending and decided permission requests for a task.',
    tags: ['permissions'],
    auth: 'owner',
    params: TaskParams,
    response: { status: 200, description: 'Permission list', schema: PermissionList },
  },
  {
    operationId: 'listPendingPermissions',
    method: 'GET',
    path: '/v1/permissions',
    summary: 'Every pending permission request across owner tasks.',
    tags: ['permissions'],
    auth: 'owner',
    response: { status: 200, description: 'Permission list', schema: PermissionList },
  },
  {
    operationId: 'decidePermission',
    method: 'POST',
    path: '/v1/work/{taskId}/permissions',
    summary: 'Approve or deny one scoped permission request.',
    tags: ['permissions'],
    auth: 'owner',
    params: TaskParams,
    body: PermissionDecisionRequest,
    response: { status: 200, description: 'Permission list', schema: PermissionList },
  },
  {
    operationId: 'listNotifications',
    method: 'GET',
    path: '/v1/notifications',
    summary: 'Durable completion notifications, including unread count.',
    tags: ['notifications'],
    auth: 'owner',
    response: { status: 200, description: 'Notification list', schema: NotificationList },
  },
  {
    operationId: 'markNotificationsRead',
    method: 'POST',
    path: '/v1/notifications/read',
    summary: 'Clear the unread flag for the named terminal notifications.',
    tags: ['notifications'],
    auth: 'owner',
    body: NotificationReadRequest,
    response: { status: 200, description: 'Notification list', schema: NotificationList },
  },
  {
    operationId: 'listSchedules',
    method: 'GET',
    path: '/v1/schedules',
    summary: 'Durable schedules owned by the caller.',
    tags: ['schedules'],
    auth: 'owner',
    response: { status: 200, description: 'Schedule list', schema: ScheduleList },
  },
  {
    operationId: 'createSchedule',
    method: 'POST',
    path: '/v1/schedules',
    summary: 'Store a durable one-shot or repeating Work schedule.',
    tags: ['schedules'],
    auth: 'owner',
    body: ScheduleCreateRequest,
    response: { status: 201, description: 'Created schedule', schema: Schedule },
  },
  {
    operationId: 'getSchedule',
    method: 'GET',
    path: '/v1/schedules/{scheduleId}',
    summary: 'One durable schedule and its last submission outcome.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Schedule', schema: Schedule },
  },
  {
    operationId: 'cancelSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}/cancel',
    summary: 'Cancel a schedule before its next due time.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Schedule cancellation outcome', schema: ScheduleControlResult },
  },
  {
    operationId: 'listTaskArtifacts',
    method: 'GET',
    path: '/v1/work/{taskId}/artifacts',
    summary: 'Artifacts a Work task produced, with digest and size.',
    tags: ['artifacts'],
    auth: 'owner',
    params: TaskParams,
    response: { status: 200, description: 'Artifact list', schema: ArtifactList },
  },
  {
    operationId: 'uploadTaskArtifact',
    method: 'POST',
    path: '/v1/work/{taskId}/artifacts',
    summary: 'Store artifact bytes for a task and return their verified digest.',
    tags: ['artifacts'],
    auth: 'owner',
    params: TaskParams,
    body: ArtifactUploadRequest,
    response: { status: 201, description: 'Stored artifact', schema: ArtifactRecord },
  },
  {
    operationId: 'getArtifact',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}',
    summary: 'Artifact metadata, scoped to its owning task.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    response: { status: 200, description: 'Artifact metadata', schema: ArtifactRecord },
  },
  {
    operationId: 'getArtifactContent',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}/content',
    summary: 'Artifact bytes as base64 with the digest they were verified against.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    response: { status: 200, description: 'Artifact content', schema: ArtifactContent },
  },
]);

export const ROUTE_INDEX: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTES.map((route) => [route.operationId, route]),
);

export const PROBLEM_CONTENT = Problem;
