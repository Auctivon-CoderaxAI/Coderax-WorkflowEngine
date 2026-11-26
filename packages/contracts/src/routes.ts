import type { z } from 'zod';
import { AgentList } from './capabilities.js';
import { Problem } from './errors.js';
import { HealthReport, ReadinessReport } from './health.js';
import { ModelList } from './models.js';
import { NotificationList, PermissionDecisionRequest, PermissionList } from './permissions.js';
import {
  CancelRequest,
  ChatReply,
  ChatRequest,
  Conversation,
  ConversationList,
  MemoryList,
  ResumeRequest,
  RetryRequest,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  WorkSubmitRequest,
} from './tasks.js';
import {
  ARTIFACT_BODY_LIMIT_BYTES,
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactKind,
  ArtifactManifestQuery,
  ArtifactModeRequest,
  ArtifactProjectManifest,
  ArtifactPruneResult,
  ArtifactRestoreRequest,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactVersionList,
  ArtifactVersionRequest,
} from './artifacts.js';
import { Deliverable, DeliverableRequest } from './deliverables.js';
import { z as zod } from 'zod';
import { ArtifactId, ConversationId, DataMode, ProjectId, TaskId } from './primitives.js';

/**
 * The single authoritative HTTP surface.
 *
 * The engine may only register routes that appear here, and a contract test
 * asserts the registered table and this catalogue are the same set. The OpenAPI
 * document is generated from this list, so documentation, server validation and
 * the SDK cannot drift apart.
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
  /** The success response; every operation can also answer with a Problem. */
  response: { status: number; description: string; schema: z.ZodTypeAny };
  /** Server-sent events rather than a single JSON body. */
  stream?: boolean;
  /**
   * Per-operation JSON body ceiling. Absent means the transport default. Only a
   * route that carries encoded file content may raise it, so an ordinary write
   * cannot be made to buffer an unbounded body.
   */
  maxBodyBytes?: number;
};

const TaskParams = zod.object({ taskId: TaskId }).strict();
const ConversationParams = zod.object({ conversationId: ConversationId }).strict();
const ArtifactParams = zod.object({ artifactId: ArtifactId }).strict();

const ArtifactListQuery = zod
  .object({
    mode: DataMode.optional(),
    kind: ArtifactKind.optional(),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    limit: zod.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const ArtifactModeQuery = zod.object({ mode: DataMode.optional() }).strict();

const ArtifactContentQuery = zod
  .object({
    mode: DataMode.optional(),
    version: zod.coerce.number().int().positive().optional(),
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
    summary: 'One Chat turn. Streams SSE frames when the client accepts them.',
    tags: ['chat'],
    auth: 'owner',
    body: ChatRequest,
    stream: true,
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
    query: zod.object({ after: zod.coerce.number().int().nonnegative().optional() }).strict(),
    stream: true,
    response: { status: 200, description: 'Server-sent execution events', schema: zod.any() },
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
    operationId: 'listArtifacts',
    method: 'GET',
    path: '/v1/artifacts',
    summary: 'Owner-scoped durable artifacts in one data-mode partition.',
    tags: ['artifacts'],
    auth: 'owner',
    query: ArtifactListQuery,
    response: { status: 200, description: 'Artifact list and storage quota', schema: ArtifactDescriptorList },
  },
  {
    operationId: 'artifactProjectManifest',
    method: 'GET',
    path: '/v1/artifacts/manifest',
    summary: 'Version-pinned manifest for one project, with a digest of the entry list.',
    tags: ['artifacts'],
    auth: 'owner',
    query: ArtifactManifestQuery,
    response: { status: 200, description: 'Project artifact manifest', schema: ArtifactProjectManifest },
  },
  {
    operationId: 'uploadArtifact',
    method: 'POST',
    path: '/v1/artifacts',
    summary: 'Store a new artifact version from base64-encoded bytes.',
    tags: ['artifacts'],
    auth: 'owner',
    body: ArtifactUploadRequest,
    maxBodyBytes: ARTIFACT_BODY_LIMIT_BYTES,
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
    maxBodyBytes: ARTIFACT_BODY_LIMIT_BYTES,
    response: { status: 201, description: 'Stored artifact version', schema: ArtifactUploadResult },
  },
  {
    operationId: 'restoreArtifactVersion',
    method: 'POST',
    path: '/v1/artifacts/{artifactId}/restore',
    summary: 'Point an artifact at an existing immutable version without deleting newer ones.',
    tags: ['artifacts'],
    auth: 'owner',
    params: ArtifactParams,
    body: ArtifactRestoreRequest,
    response: { status: 200, description: 'Restored artifact version', schema: ArtifactUploadResult },
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
    operationId: 'generateDeliverable',
    method: 'POST',
    path: '/v1/deliverables',
    summary:
      'Generate, verify and durably persist a document, workbook, deck, analysis or software project.',
    tags: ['artifacts'],
    auth: 'owner',
    body: DeliverableRequest,
    maxBodyBytes: 8_388_608,
    response: { status: 201, description: 'Created deliverable', schema: Deliverable },
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
]);

export const ROUTE_INDEX: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTES.map((route) => [route.operationId, route]),
);

export const PROBLEM_CONTENT = Problem;
