import { z } from 'zod';
import {
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactKind,
  ArtifactModeRequest,
  ArtifactPruneResult,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactVersionList,
  ArtifactVersionRequest,
  TaskArtifactUploadRequest,
} from './artifacts.js';
import { AgentList } from './capabilities.js';
import { Problem } from './errors.js';
import { CapabilityHandshake, HandshakeQuery, RouteMethodSchema } from './handshake.js';
import { HealthReport, ReadinessReport } from './health.js';
import { ModelList } from './models.js';
import { NotificationList, PermissionDecisionRequest, PermissionList } from './permissions.js';
import {
  ArtifactId,
  ConversationId,
  DataMode,
  ProjectId,
  ScheduleId,
  TaskId,
} from './primitives.js';
import {
  Schedule,
  ScheduleControlRequest,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleList,
  ScheduleRemoval,
} from './schedules.js';
import {
  CancelRequest,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  MemoryDeleteRequest,
  MemoryList,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteRequest,
  ResumeRequest,
  RetryRequest,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskListQuery,
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
 * An operation is published only when a handler is registered for it: the
 * composition root refuses to start when the catalogue advertises an operation
 * nothing implements, and the handshake reports the registry rather than this
 * list.
 */

export type RouteMethod = z.infer<typeof RouteMethodSchema>;

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
  /** The success response; every operation can also answer with a Problem. */
  response: { status: number; description: string; schema: z.ZodTypeAny };
  /** The success response is server-sent events rather than a single JSON body. */
  stream?: boolean;
  /**
   * The success response is SSE when the caller accepts `text/event-stream` and
   * the JSON `response` otherwise. Only meaningful together with `stream`.
   */
  negotiated?: boolean;
};

const TaskParams = z.object({ taskId: TaskId }).strict();
const ConversationParams = z.object({ conversationId: ConversationId }).strict();
const ScheduleParams = z.object({ scheduleId: ScheduleId }).strict();
const TaskArtifactParams = z.object({ taskId: TaskId, artifactId: ArtifactId }).strict();
const ArtifactParams = z.object({ artifactId: ArtifactId }).strict();

const ArtifactListQuery = z
  .object({
    mode: DataMode.optional(),
    kind: ArtifactKind.optional(),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const ArtifactModeQuery = z.object({ mode: DataMode.optional() }).strict();

const ArtifactContentQuery = z
  .object({
    mode: DataMode.optional(),
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();

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
    summary: 'Contract version, negotiated version and the operations this build serves.',
    tags: ['handshake'],
    auth: 'owner',
    query: HandshakeQuery,
    response: { status: 200, description: 'Capability handshake', schema: CapabilityHandshake },
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
    operationId: 'submitChat',
    method: 'POST',
    path: '/v1/chat',
    summary: 'One Chat turn. Answers with SSE frames when the caller accepts them.',
    tags: ['chat'],
    auth: 'owner',
    body: ChatRequest,
    stream: true,
    negotiated: true,
    response: { status: 200, description: 'Chat reply', schema: ChatReply },
  },
  {
    operationId: 'submitWork',
    method: 'POST',
    path: '/v1/work',
    summary: 'Submit a durable Work task; returns before execution finishes.',
    tags: ['work'],
    auth: 'owner',
    body: WorkSubmitRequest,
    response: { status: 202, description: 'Task accepted', schema: TaskAccepted },
  },
  {
    operationId: 'listTasks',
    method: 'GET',
    path: '/v1/tasks',
    summary: 'The owner task read model, newest first.',
    tags: ['tasks'],
    auth: 'owner',
    query: TaskListQuery,
    response: { status: 200, description: 'Task list', schema: TaskList },
  },
  {
    // Compatibility alias: the same read model, still reachable where 1.1.0
    // published it. Two operation ids over one handler, never two handlers.
    operationId: 'listWork',
    method: 'GET',
    path: '/v1/work',
    summary: 'Compatibility alias for the task read model at GET /v1/tasks.',
    tags: ['tasks'],
    auth: 'owner',
    query: TaskListQuery,
    response: { status: 200, description: 'Task list', schema: TaskList },
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
    query: z.object({ after: z.coerce.number().int().nonnegative().optional() }).strict(),
    stream: true,
    response: { status: 200, description: 'Server-sent execution events', schema: z.any() },
  },
  {
    operationId: 'listArtifacts',
    method: 'GET',
    path: '/v1/artifacts',
    summary: 'Owner-scoped durable artifacts in one data-mode partition.',
    tags: ['artifacts'],
    auth: 'owner',
    query: ArtifactListQuery,
    response: {
      status: 200,
      description: 'Artifact list and storage quota',
      schema: ArtifactDescriptorList,
    },
  },
  {
    operationId: 'uploadArtifact',
    method: 'POST',
    path: '/v1/artifacts',
    summary: 'Store a new artifact version from base64-encoded bytes.',
    tags: ['artifacts'],
    auth: 'owner',
    body: ArtifactUploadRequest,
    response: { status: 201, description: 'Stored artifact', schema: ArtifactUploadResult },
  },
  {
    operationId: 'pruneArtifacts',
    method: 'POST',
    path: '/v1/artifacts/prune',
    summary: 'Delete this owner’s artifacts whose retention has expired.',
    tags: ['artifacts'],
    auth: 'owner',
    body: ArtifactModeRequest,
    response: { status: 200, description: 'Prune result', schema: ArtifactPruneResult },
  },
  {
    operationId: 'getArtifact',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}',
    summary: 'Authoritative metadata for one artifact in the requested mode.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    query: ArtifactModeQuery,
    response: { status: 200, description: 'Artifact descriptor', schema: ArtifactDescriptor },
  },
  {
    operationId: 'uploadArtifactVersion',
    method: 'POST',
    path: '/v1/artifacts/{artifactId}/versions',
    summary: 'Append a new immutable version to an existing artifact.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    body: ArtifactVersionRequest,
    response: { status: 201, description: 'Stored artifact version', schema: ArtifactUploadResult },
  },
  {
    operationId: 'listArtifactVersions',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}/versions',
    summary: 'Retained version history for one artifact, newest last.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    query: ArtifactModeQuery,
    response: { status: 200, description: 'Artifact version list', schema: ArtifactVersionList },
  },
  {
    operationId: 'downloadArtifact',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}/content',
    summary: 'Exact bytes of one artifact version, integrity-verified on read.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    query: ArtifactContentQuery,
    response: { status: 200, description: 'Artifact content', schema: ArtifactContent },
  },
  {
    operationId: 'exportArtifact',
    method: 'GET',
    path: '/v1/artifacts/{artifactId}/export',
    summary: 'Portable export: descriptor, version manifest and exact bytes.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    query: ArtifactContentQuery,
    response: { status: 200, description: 'Artifact export', schema: ArtifactExport },
  },
  {
    operationId: 'deleteArtifact',
    method: 'POST',
    path: '/v1/artifacts/{artifactId}/delete',
    summary: 'Delete an artifact and every retained version it owns.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    body: ArtifactModeRequest,
    response: { status: 200, description: 'Delete result', schema: ArtifactDeleteResult },
  },
  {
    operationId: 'listTaskArtifacts',
    method: 'GET',
    path: '/v1/work/{taskId}/artifacts',
    summary: 'Artifacts projected for one task, with their digests and quota.',
    tags: ['artifacts'],
    auth: 'owner',
    params: TaskParams,
    response: { status: 200, description: 'Artifact list', schema: ArtifactDescriptorList },
  },
  {
    operationId: 'createTaskArtifact',
    method: 'POST',
    path: '/v1/work/{taskId}/artifacts',
    summary: 'Attach an owner artifact to a task; mode and conversation come from the task.',
    tags: ['artifacts'],
    auth: 'owner',
    params: TaskParams,
    body: TaskArtifactUploadRequest,
    response: { status: 201, description: 'Stored artifact', schema: ArtifactUploadResult },
  },
  {
    operationId: 'getTaskArtifact',
    method: 'GET',
    path: '/v1/work/{taskId}/artifacts/{artifactId}',
    summary: 'Read one task artifact with its recorded digest and encoding.',
    tags: ['artifacts'],
    auth: 'owner',
    params: TaskArtifactParams,
    response: { status: 200, description: 'Artifact content', schema: ArtifactContent },
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
    query: z.object({ mode: z.enum(['private', 'cloud']).optional() }).strict(),
    response: { status: 200, description: 'Memory entries', schema: MemoryList },
  },
  {
    operationId: 'writeMemory',
    method: 'POST',
    path: '/v1/memory',
    summary: 'Write one memory entry inside a single data mode.',
    tags: ['memory'],
    auth: 'owner',
    body: MemoryWriteRequest,
    response: { status: 200, description: 'Memory entries', schema: MemoryList },
  },
  {
    operationId: 'deleteMemory',
    method: 'POST',
    path: '/v1/memory/delete',
    summary: 'Delete one memory entry from one data mode.',
    tags: ['memory'],
    auth: 'owner',
    body: MemoryDeleteRequest,
    response: { status: 200, description: 'Memory entries', schema: MemoryList },
  },
  {
    operationId: 'searchMemory',
    method: 'GET',
    path: '/v1/memory/search',
    summary: 'Lexical retrieval over the owner memory partition.',
    tags: ['memory'],
    auth: 'owner',
    query: MemorySearchQuery,
    response: { status: 200, description: 'Memory search result', schema: MemorySearchResult },
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
    operationId: 'markNotificationRead',
    method: 'POST',
    path: '/v1/notifications/{taskId}',
    summary: 'Mark the notification for one finished task as read.',
    tags: ['notifications'],
    auth: 'owner',
    params: TaskParams,
    response: { status: 200, description: 'Notification list', schema: NotificationList },
  },
  {
    operationId: 'listSchedules',
    method: 'GET',
    path: '/v1/schedules',
    summary: 'Schedules that submit Work on an interval.',
    tags: ['schedules'],
    auth: 'owner',
    response: { status: 200, description: 'Schedule list', schema: ScheduleList },
  },
  {
    operationId: 'createSchedule',
    method: 'POST',
    path: '/v1/schedules',
    summary: 'Create a durable schedule; validates the agent and model up front.',
    tags: ['schedules'],
    auth: 'owner',
    body: ScheduleCreateRequest,
    response: { status: 201, description: 'Schedule', schema: Schedule },
  },
  {
    operationId: 'controlSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}',
    summary: 'Pause or resume one schedule.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    body: ScheduleControlRequest,
    response: { status: 200, description: 'Schedule control outcome', schema: ScheduleControlResult },
  },
  {
    operationId: 'deleteSchedule',
    method: 'DELETE',
    path: '/v1/schedules/{scheduleId}',
    summary: 'Delete one schedule. A run already started keeps running.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Schedule removal outcome', schema: ScheduleRemoval },
  },
]);

export const ROUTE_INDEX: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTES.map((route) => [route.operationId, route]),
);

export const PROBLEM_CONTENT = Problem;
