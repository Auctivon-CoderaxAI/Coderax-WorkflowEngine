import type { z } from 'zod';
import { AgentList } from './capabilities.js';
import { Problem } from './errors.js';
import {
  BuildGameRequest,
  CreateGameRequest,
  CreateGameSessionRequest,
  GameBuild,
  GameCapabilityReport,
  GameExport,
  GameIteration,
  GameObservation,
  GameProject,
  GameProjectList,
  GameSession,
  GameSessionControlRequest,
  GameSessionList,
  GameSessionLogs,
  GameSessionVerification,
  IterateGameRequest,
  SaveGameSpecRequest,
} from './games.js';
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
  response: {
    status: number;
    description: string;
    schema: z.ZodTypeAny;
    /** Set for a non-JSON success body such as a playable HTML preview. */
    contentType?: string;
  };
  /** Server-sent events rather than a single JSON body. */
  stream?: boolean;
};

const TaskParams = zod.object({ taskId: TaskId }).strict();
const ConversationParams = zod.object({ conversationId: ConversationId }).strict();
const GameParams = zod.object({ gameId: zod.string().trim().min(1).max(120) }).strict();
const GameSessionParams = zod
  .object({ sessionId: zod.string().trim().min(1).max(120) })
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
    operationId: 'getGameCapabilities',
    method: 'GET',
    path: '/v1/games/capabilities',
    summary: 'Truthful status of Native Game Studio and Native Gaming Agent, with evidence.',
    tags: ['games'],
    auth: 'owner',
    response: { status: 200, description: 'Game capability report', schema: GameCapabilityReport },
  },
  {
    operationId: 'listGames',
    method: 'GET',
    path: '/v1/games',
    summary: 'Owner-scoped, persistent game projects.',
    tags: ['games'],
    auth: 'owner',
    query: zod
      .object({ cursor: zod.string().max(200).optional(), limit: zod.coerce.number().int().min(1).max(100).optional() })
      .strict(),
    response: { status: 200, description: 'Game project list', schema: GameProjectList },
  },
  {
    operationId: 'createGame',
    method: 'POST',
    path: '/v1/games',
    summary: 'Create a game project from a natural-language specification.',
    tags: ['games'],
    auth: 'owner',
    body: CreateGameRequest,
    response: { status: 201, description: 'Created game project', schema: GameProject },
  },
  {
    operationId: 'getGame',
    method: 'GET',
    path: '/v1/games/{gameId}',
    summary: 'One game project with its latest build and design plan.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    response: { status: 200, description: 'Game project', schema: GameProject },
  },
  {
    operationId: 'saveGameSpec',
    method: 'POST',
    path: '/v1/games/{gameId}/spec',
    summary: 'Replace the design spec at an expected revision.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    body: SaveGameSpecRequest,
    response: { status: 200, description: 'Updated game project', schema: GameProject },
  },
  {
    operationId: 'buildGame',
    method: 'POST',
    path: '/v1/games/{gameId}/build',
    summary: 'Generate original source, assets and levels, then verify playability.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    body: BuildGameRequest,
    response: { status: 200, description: 'Verified or failed build with evidence', schema: GameBuild },
  },
  {
    operationId: 'iterateGame',
    method: 'POST',
    path: '/v1/games/{gameId}/iterate',
    summary: 'Apply a natural-language edit, rebuild and re-verify.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    body: IterateGameRequest,
    response: { status: 200, description: 'Iteration result', schema: GameIteration },
  },
  {
    operationId: 'previewGame',
    method: 'GET',
    path: '/v1/games/{gameId}/preview',
    summary: 'Playable HTML preview of the latest verified build.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    response: {
      status: 200,
      description: 'Playable HTML document',
      schema: zod.string(),
      contentType: 'text/html; charset=utf-8',
    },
  },
  {
    operationId: 'exportGame',
    method: 'GET',
    path: '/v1/games/{gameId}/export',
    summary: 'Export the verified source as a deterministic ZIP archive.',
    tags: ['games'],
    auth: 'owner',
    params: GameParams,
    response: { status: 200, description: 'ZIP archive as base64', schema: GameExport },
  },
  {
    operationId: 'createGameSession',
    method: 'POST',
    path: '/v1/games/{gameId}/sessions',
    summary: 'Start an isolated gaming-agent session against a verified build.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameParams,
    body: CreateGameSessionRequest,
    response: { status: 201, description: 'Created game session', schema: GameSession },
  },
  {
    operationId: 'listGameSessions',
    method: 'GET',
    path: '/v1/game-sessions',
    summary: 'Owner-scoped gaming-agent sessions.',
    tags: ['gaming-agent'],
    auth: 'owner',
    response: { status: 200, description: 'Game session list', schema: GameSessionList },
  },
  {
    operationId: 'getGameSession',
    method: 'GET',
    path: '/v1/game-sessions/{sessionId}',
    summary: 'Session status, bounded progress, memory and recent logs.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameSessionParams,
    response: { status: 200, description: 'Game session', schema: GameSession },
  },
  {
    operationId: 'observeGameSession',
    method: 'GET',
    path: '/v1/game-sessions/{sessionId}/observation',
    summary: 'Screen frame and inspected game state for the current tick.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameSessionParams,
    response: { status: 200, description: 'Observation', schema: GameObservation },
  },
  {
    operationId: 'controlGameSession',
    method: 'POST',
    path: '/v1/game-sessions/{sessionId}/control',
    summary: 'Pause, resume, take over, release, cancel or send one bounded input.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameSessionParams,
    body: GameSessionControlRequest,
    response: { status: 200, description: 'Updated game session', schema: GameSession },
  },
  {
    operationId: 'gameSessionLogs',
    method: 'GET',
    path: '/v1/game-sessions/{sessionId}/logs',
    summary: 'Bounded execution log and session memory.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameSessionParams,
    response: { status: 200, description: 'Session logs', schema: GameSessionLogs },
  },
  {
    operationId: 'gameSessionVerification',
    method: 'GET',
    path: '/v1/game-sessions/{sessionId}/verification',
    summary: 'Measured objective completion evidence for a finished session.',
    tags: ['gaming-agent'],
    auth: 'owner',
    params: GameSessionParams,
    response: { status: 200, description: 'Session verification', schema: GameSessionVerification },
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
