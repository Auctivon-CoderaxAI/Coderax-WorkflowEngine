import type { z } from 'zod';
import { CapabilityReport, Deliverable, DeliverableRequest } from './artifacts.js';
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
import { z as zod } from 'zod';
import { ConversationId, TaskId } from './primitives.js';

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
};

const TaskParams = zod.object({ taskId: TaskId }).strict();
const ConversationParams = zod.object({ conversationId: ConversationId }).strict();

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
    operationId: 'listCapabilities',
    method: 'GET',
    path: '/v1/capabilities',
    summary: 'Artifact formats and media capabilities, with truthful availability.',
    tags: ['discovery'],
    auth: 'owner',
    response: { status: 200, description: 'Capability report', schema: CapabilityReport },
  },
  {
    operationId: 'generateDeliverable',
    method: 'POST',
    path: '/v1/deliverables',
    summary: 'Produce and objectively verify a document, workbook, deck, dataset analysis, source tree or media inspection.',
    tags: ['artifacts'],
    auth: 'owner',
    body: DeliverableRequest,
    response: { status: 201, description: 'Verified deliverable', schema: Deliverable },
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
