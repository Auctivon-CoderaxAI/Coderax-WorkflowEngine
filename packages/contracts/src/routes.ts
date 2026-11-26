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
import { z as zod } from 'zod';
import {
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleDispatch,
  ScheduleEventRequest,
  ScheduleEventResult,
  ScheduleExecutionList,
  ScheduleList,
  ScheduleNoticeList,
  ScheduleTriggerRequest,
} from './schedules.js';
import { ConversationId, ScheduleId, TaskId } from './primitives.js';

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
const ScheduleParams = zod.object({ scheduleId: ScheduleId }).strict();
const ExecutionHistoryQuery = zod
  .object({ limit: zod.coerce.number().int().positive().max(500).optional() })
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
    operationId: 'listNotifications',
    method: 'GET',
    path: '/v1/notifications',
    summary: 'Durable completion notifications, including unread count.',
    tags: ['notifications'],
    auth: 'owner',
    response: { status: 200, description: 'Notification list', schema: NotificationList },
  },
  {
    operationId: 'createSchedule',
    method: 'POST',
    path: '/v1/schedules',
    summary: 'Create a durable, owner-controlled schedule executed by the engine.',
    tags: ['schedules'],
    auth: 'owner',
    body: ScheduleCreateRequest,
    response: { status: 201, description: 'Created schedule', schema: Schedule },
  },
  {
    operationId: 'listSchedules',
    method: 'GET',
    path: '/v1/schedules',
    summary: 'List this owner\'s schedules with their next run and state.',
    tags: ['schedules'],
    auth: 'owner',
    response: { status: 200, description: 'Schedule list', schema: ScheduleList },
  },
  {
    operationId: 'listScheduleNotifications',
    method: 'GET',
    path: '/v1/schedules/notifications',
    summary: 'Durable schedule completion, failure, missed-run and refusal notices.',
    tags: ['schedules'],
    auth: 'owner',
    response: { status: 200, description: 'Schedule notice list', schema: ScheduleNoticeList },
  },
  {
    operationId: 'markScheduleNotificationsRead',
    method: 'POST',
    path: '/v1/schedules/notifications/read',
    summary: 'Mark every schedule notice for this owner as read.',
    tags: ['schedules'],
    auth: 'owner',
    response: { status: 200, description: 'Schedule notice list', schema: ScheduleNoticeList },
  },
  {
    operationId: 'dispatchScheduleEvent',
    method: 'POST',
    path: '/v1/schedule-events',
    summary: 'Fire a named event; each matching event-triggered schedule runs at most once.',
    tags: ['schedules'],
    auth: 'owner',
    body: ScheduleEventRequest,
    response: { status: 202, description: 'Dispatched occurrences', schema: ScheduleEventResult },
  },
  {
    operationId: 'getSchedule',
    method: 'GET',
    path: '/v1/schedules/{scheduleId}',
    summary: 'One schedule with its authoritative state and next run.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Schedule', schema: Schedule },
  },
  {
    operationId: 'pauseSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}/pause',
    summary: 'Pause future occurrences; a run already in flight is not stopped.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Pause outcome', schema: ScheduleControlResult },
  },
  {
    operationId: 'resumeSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}/resume',
    summary: 'Resume a paused schedule from the next occurrence; missed runs are not stormed.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Resume outcome', schema: ScheduleControlResult },
  },
  {
    operationId: 'cancelSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}/cancel',
    summary: 'Cancel a schedule permanently and cancel its current Work task.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    response: { status: 200, description: 'Cancellation outcome', schema: ScheduleControlResult },
  },
  {
    operationId: 'triggerSchedule',
    method: 'POST',
    path: '/v1/schedules/{scheduleId}/trigger',
    summary: 'Run one occurrence now, deduplicated by the supplied idempotency key.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    body: ScheduleTriggerRequest,
    response: { status: 202, description: 'Dispatched occurrence', schema: ScheduleDispatch },
  },
  {
    operationId: 'listScheduleExecutions',
    method: 'GET',
    path: '/v1/schedules/{scheduleId}/executions',
    summary: 'Durable execution receipts for one schedule, newest first.',
    tags: ['schedules'],
    auth: 'owner',
    params: ScheduleParams,
    query: ExecutionHistoryQuery,
    response: { status: 200, description: 'Execution history', schema: ScheduleExecutionList },
  },
]);

export const ROUTE_INDEX: ReadonlyMap<string, RouteSpec> = new Map(
  ROUTES.map((route) => [route.operationId, route]),
);

export const PROBLEM_CONTENT = Problem;
