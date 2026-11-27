import type { z } from 'zod';
import {
  AgentList,
  BrowserActionResult,
  BrowserArtifactContent,
  BrowserCapabilities,
  BrowserReceiptList,
  BrowserSession,
  BrowserSessionList,
  BrowserTakeoverResult,
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactKind,
  ArtifactPruneResult,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactVersionList,
  ArtifactVersionRequest,
  ChatReply,
  Conversation,
  Deliverable,
  ConversationList,
  CreativeValidation,
  EngineHandshake,
  ExecutionEvent,
  GameBuild,
  GameBuildList,
  GameCapabilityReport,
  GameExport,
  GameIteration,
  GameObservation,
  GameProject,
  GameProjectList,
  GameSession,
  GameSessionList,
  GameSessionLogs,
  GameSessionVerification,
  HealthReport,
  MediaCapabilities,
  MediaDownload,
  MediaUploadResult,
  MemoryEntry,
  MemoryList,
  ModelList,
  NotificationList,
  PermissionList,
  PermissionRequest,
  Problem,
  ReadinessReport,
  RoutingReport,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  TeamAccepted,
  TeamControlResult,
  TeamStatus,
  TeamSubmitRequest,
} from '@coderax/contracts';
import type {
  ChatRequest,
  CreativeValidationRequest,
  DataMode,
  MediaUploadRequest,
  MemoryPutRequest,
  NotificationReadRequest,
  PermissionDecisionRequest,
  RestoreGameBuildRequest,
  SaveGameSpecRequest,
  ScheduleCreateInput,
  ScheduleUpdateRequest,
  ScheduleEventRequest,
  ScheduleTriggerRequest,
  WorkSubmitRequest,
} from '@coderax/contracts';

/**
 * The one client both Coderax (web) and Coderax-CLI consume.
 *
 * Every response is parsed with the same zod schema the server validated
 * against, so a deployment that drifts from the contract fails at the client
 * boundary with a named contract error instead of producing subtly wrong UI. The
 * client performs no retries, follows no redirects, keeps no cookie jar and never
 * places the token in a URL or an error message.
 */

export class CoderaxApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = 'CoderaxApiError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryable = input.retryable ?? false;
  }
}

export class CoderaxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoderaxContractError';
  }
}

export type CoderaxClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Every operation the SDK implements, keyed by the contract operation id.
 *
 * The route-completeness gate compares this map with the route catalogue: a new
 * HTTP operation is not complete until a client can call it, and removing a
 * client method without removing the route fails the same check. The map is
 * also checked against the class at runtime so a renamed method cannot hide.
 */
export const SDK_OPERATIONS = Object.freeze({
  getHealth: 'health',
  getReadiness: 'readiness',
  listAgents: 'agents',
  listModels: 'models',
  listTools: 'listTools',
  getRouting: 'getRouting',
  ingestKnowledge: 'ingestKnowledge',
  listKnowledge: 'listKnowledge',
  searchKnowledge: 'searchKnowledge',
  submitChat: 'chat',
  submitWork: 'submitWork',
  getTask: 'task',
  cancelTask: 'cancel',
  resumeTask: 'resume',
  retryTask: 'retry',
  streamTaskEvents: 'events',
  listConversations: 'conversations',
  getConversation: 'conversation',
  listMemory: 'memory',
  listPermissions: 'permissions',
  decidePermission: 'decidePermission',
  listNotifications: 'notifications',
  markNotificationsRead: 'markNotificationsRead',
} as const);

export type SdkOperationId = keyof typeof SDK_OPERATIONS;

type RequestInput = {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
};

function joinUrl(baseUrl: string, path: string, query?: RequestInput['query']): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (url.origin !== new URL(base).origin) {
    throw new CoderaxContractError(`route ${path} resolves outside the configured origin`);
  }
  return url.toString();
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data.length > 0) {
        try {
          yield JSON.parse(data);
        } catch {
          throw new CoderaxContractError('an event frame was not valid JSON');
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export class CoderaxClient {
  private readonly options: Required<Pick<CoderaxClientOptions, 'baseUrl' | 'token'>> & {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  };

  constructor(options: CoderaxClientOptions) {
    this.options = {
      baseUrl: options.baseUrl,
      token: options.token,
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
  }

  private headers(accept = 'application/json'): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.options.token}`,
    };
  }

  /**
   * The owner bearer token is never attached to a cleartext non-loopback URL.
   * Loopback HTTP stays available for local development and tests.
   */
  private assertSecureOrigin(): void {
    const url = new URL(this.options.baseUrl);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1';
    if (url.protocol !== 'https:' && !loopback) {
      throw new Error('CoderaxClient requires HTTPS for a non-loopback base URL.');
    }
  }

  private async send(input: RequestInput): Promise<Response> {
    this.assertSecureOrigin();
    return this.options.fetchImpl(
      joinUrl(this.options.baseUrl, input.path, input.query),
      {
        method: input.method,
        headers: {
          ...this.headers(),
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: 'error',
        signal: input.signal ?? AbortSignal.timeout(this.options.timeoutMs),
      },
    );
  }

  private async parse<T>(schema: z.ZodTypeAny, response: Response, path: string): Promise<T> {
    const text = await response.text();
    let json: unknown = null;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const problem = Problem.safeParse(json);
      if (problem.success) {
        throw new CoderaxApiError({
          code: problem.data.code,
          message: problem.data.detail ?? problem.data.title,
          status: problem.data.status,
          ...(problem.data.requestId ? { requestId: problem.data.requestId } : {}),
          retryable: problem.data.retryable,
        });
      }
      throw new CoderaxApiError({
        code: 'internal_error',
        message: `HTTP ${response.status} from ${path}`,
        status: response.status,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CoderaxContractError(`the response for ${path} did not match the published contract`);
    }
    return parsed.data as T;
  }

  private async request<T>(
    schema: z.ZodTypeAny,
    input: RequestInput,
  ): Promise<T> {
    return this.parse<T>(schema, await this.send(input), input.path);
  }

  health(): Promise<HealthReport> {
    return this.request<HealthReport>(HealthReport, { method: 'GET', path: '/v1/health' });
  }

  /**
   * The first call a client should make. It carries the served contract, the
   * catalogue fingerprint and the operations this build actually publishes.
   */
  handshake(input: { contract?: string; fingerprint?: string } = {}): Promise<CapabilityHandshake> {
    return this.request<CapabilityHandshake>(CapabilityHandshake, {
      method: 'GET',
      path: '/v1/handshake',
      query: { contract: input.contract, fingerprint: input.fingerprint },
    });
  }

  readiness(): Promise<ReadinessReport> {
    return this.request<ReadinessReport>(ReadinessReport, { method: 'GET', path: '/v1/ready' });
  }

  agents(): Promise<AgentList> {
    return this.request<AgentList>(AgentList, { method: 'GET', path: '/v1/agents' });
  }

  models(): Promise<ModelList> {
    return this.request<ModelList>(ModelList, { method: 'GET', path: '/v1/models' });
  }

  browserCapabilities(): Promise<BrowserCapabilities> {
    return this.request<BrowserCapabilities>(BrowserCapabilities, {
      method: 'GET',
      path: '/v1/browser/capabilities',
    });
  }

  browserSessions(): Promise<BrowserSessionList> {
    return this.request<BrowserSessionList>(BrowserSessionList, {
      method: 'GET',
      path: '/v1/browser/sessions',
    });
  }

  browserSession(sessionId: string): Promise<BrowserSession> {
    return this.request<BrowserSession>(BrowserSession, {
      method: 'GET',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}`,
    });
  }

  createBrowserSession(request: BrowserSessionCreateInput): Promise<BrowserSession> {
    return this.request<BrowserSession>(BrowserSession, {
      method: 'POST',
      path: '/v1/browser/sessions',
      body: request,
    });
  }

  browserAction(sessionId: string, action: BrowserActionInput): Promise<BrowserActionResult> {
    return this.request<BrowserActionResult>(BrowserActionResult, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/actions`,
      body: action,
    });
  }

  pauseBrowserSession(sessionId: string): Promise<BrowserSession> {
    return this.request<BrowserSession>(BrowserSession, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/pause`,
    });
  }

  resumeBrowserSession(sessionId: string): Promise<BrowserSession> {
    return this.request<BrowserSession>(BrowserSession, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/resume`,
    });
  }

  takeoverBrowserSession(
    sessionId: string,
    request: BrowserTakeoverRequest,
  ): Promise<BrowserTakeoverResult> {
    return this.request<BrowserTakeoverResult>(BrowserTakeoverResult, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/takeover`,
      body: request,
    });
  }

  closeBrowserSession(
    sessionId: string,
    request: BrowserCloseRequest = {},
  ): Promise<BrowserSession> {
    return this.request<BrowserSession>(BrowserSession, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/close`,
      body: request,
    });
  }

  authorizeBrowserSession(
    sessionId: string,
    request: BrowserAuthorizationRequest,
  ): Promise<PermissionRequest> {
    return this.request<PermissionRequest>(PermissionRequest, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/authorize`,
      body: request,
    });
  }

  decideBrowserAuthorization(
    sessionId: string,
    request: PermissionDecisionRequest,
  ): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'POST',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/authorize/decision`,
      body: request,
    });
  }

  browserReceipts(sessionId: string): Promise<BrowserReceiptList> {
    return this.request<BrowserReceiptList>(BrowserReceiptList, {
      method: 'GET',
      path: `/v1/browser/sessions/${encodeURIComponent(sessionId)}/receipts`,
    });
  }

  browserArtifact(artifactId: string): Promise<BrowserArtifactContent> {
    return this.request<BrowserArtifactContent>(BrowserArtifactContent, {
      method: 'GET',
      path: `/v1/browser/artifacts/${encodeURIComponent(artifactId)}`,
    });
  }

  chat(request: ChatRequest): Promise<ChatReply> {
    return this.request<ChatReply>(ChatReply, {
      method: 'POST',
      path: '/v1/chat',
      body: request,
    });
  }

  submitWork(request: WorkSubmitRequest): Promise<TaskAccepted> {
    return this.request<TaskAccepted>(TaskAccepted, {
      method: 'POST',
      path: '/v1/work',
      body: request,
    });
  }

  task(taskId: string): Promise<TaskStatus> {
    return this.request<TaskStatus>(TaskStatus, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}`,
    });
  }

  cancel(taskId: string, reason?: string): Promise<TaskControlResult> {
    return this.request<TaskControlResult>(TaskControlResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/cancel`,
      body: reason ? { reason } : {},
    });
  }

  resume(taskId: string, generation: number): Promise<TaskControlResult> {
    return this.request<TaskControlResult>(TaskControlResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/resume`,
      body: { generation },
    });
  }

  retry(taskId: string, generation: number): Promise<TaskControlResult> {
    return this.request<TaskControlResult>(TaskControlResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/retry`,
      body: { generation },
    });
  }

  conversations(): Promise<ConversationList> {
    return this.request<ConversationList>(ConversationList, {
      method: 'GET',
      path: '/v1/conversations',
    });
  }

  conversation(conversationId: string): Promise<Conversation> {
    return this.request<Conversation>(Conversation, {
      method: 'GET',
      path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
    });
  }

  memory(mode: DataMode = 'private'): Promise<MemoryList> {
    return this.request<MemoryList>(MemoryList, {
      method: 'GET',
      path: '/v1/memory',
      query: { mode },
    });
  }

  listTools(): Promise<ToolList> {
    return this.request<ToolList>(ToolList, {
      method: 'GET',
      path: '/v1/tools',
    });
  }

  getRouting(mode: 'auto' | 'fast' | 'complex' = 'auto'): Promise<RoutingReport> {
    return this.request<RoutingReport>(RoutingReport, {
      method: 'GET',
      path: '/v1/routing',
      query: { mode },
    });
  }

  ingestKnowledge(request: KnowledgeIngestRequest): Promise<KnowledgeIngestResult> {
    return this.request<KnowledgeIngestResult>(KnowledgeIngestResult, {
      method: 'POST',
      path: '/v1/knowledge',
      body: request,
    });
  }

  listKnowledge(mode: DataMode = 'private'): Promise<KnowledgeList> {
    return this.request<KnowledgeList>(KnowledgeList, {
      method: 'GET',
      path: '/v1/knowledge',
      query: { mode },
    });
  }

  searchKnowledge(q: string, k?: number, mode?: DataMode): Promise<KnowledgeSearchResult> {
    return this.request<KnowledgeSearchResult>(KnowledgeSearchResult, {
      method: 'GET',
      path: '/v1/knowledge/search',
      query: { q, k, mode },
    });
  }

  permissions(taskId: string): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/permissions`,
    });
  }

  decidePermission(
    taskId: string,
    request: PermissionDecisionRequest,
  ): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/permissions`,
      body: request,
    });
  }

  submitTeam(request: TeamSubmitRequest): Promise<TeamAccepted> {
    return this.request<TeamAccepted>(TeamAccepted, {
      method: 'POST',
      path: '/v1/teams',
      body: request,
    });
  }

  team(teamId: string): Promise<TeamStatus> {
    return this.request<TeamStatus>(TeamStatus, {
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}`,
    });
  }

  cancelTeam(teamId: string): Promise<TeamControlResult> {
    return this.request<TeamControlResult>(TeamControlResult, {
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/cancel`,
      body: {},
    });
  }

  resumeTeam(teamId: string, generation: number): Promise<TeamControlResult> {
    return this.request<TeamControlResult>(TeamControlResult, {
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/resume`,
      body: { generation },
    });
  }

  teamPermissions(teamId: string): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'GET',
      path: `/v1/teams/${encodeURIComponent(teamId)}/permissions`,
    });
  }

  decideTeamPermission(
    teamId: string,
    request: PermissionDecisionRequest,
  ): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'POST',
      path: `/v1/teams/${encodeURIComponent(teamId)}/permissions`,
      body: request,
    });
  }

  notifications(): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'GET',
      path: '/v1/notifications',
      query: { includeSchedules: 'true' },
    });
  }

  /** Clears the blue dot for the named terminal tasks. */
  markNotificationsRead(taskIds: string[]): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'POST',
      path: '/v1/notifications/read',
      body: { taskIds } satisfies NotificationReadRequest,
    });
  }

  schedules(): Promise<ScheduleList> {
    return this.request<ScheduleList>(ScheduleList, {
      method: 'GET',
      path: '/v1/schedules',
    });
  }

  createSchedule(request: ScheduleCreateRequest): Promise<Schedule> {
    return this.request<Schedule>(Schedule, {
      method: 'POST',
      path: '/v1/schedules',
      body: request,
    });
  }

  schedules(): Promise<ScheduleList> {
    return this.request<ScheduleList>(ScheduleList, { method: 'GET', path: '/v1/schedules' });
  }

  schedule(scheduleId: string): Promise<Schedule> {
    return this.request<Schedule>(Schedule, {
      method: 'GET',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}`,
    });
  }

  pauseSchedule(scheduleId: string): Promise<ScheduleControlResult> {
    return this.request<ScheduleControlResult>(ScheduleControlResult, {
      method: 'POST',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}/pause`,
    });
  }

  resumeSchedule(scheduleId: string): Promise<ScheduleControlResult> {
    return this.request<ScheduleControlResult>(ScheduleControlResult, {
      method: 'POST',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}/resume`,
    });
  }

  cancelSchedule(scheduleId: string): Promise<ScheduleControlResult> {
    return this.request<ScheduleControlResult>(ScheduleControlResult, {
      method: 'POST',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}/cancel`,
    });
  }

  /** Durable artifacts in one data-mode partition, with the storage quota. */
  artifacts(
    query: {
      mode?: DataMode;
      kind?: ArtifactKind;
      projectId?: string;
      conversationId?: string;
      taskId?: string;
      limit?: number;
    } = {},
  ): Promise<ArtifactDescriptorList> {
    return this.request<ArtifactDescriptorList>(ArtifactDescriptorList, {
      method: 'GET',
      path: '/v1/artifacts',
      query,
    });
  }

  artifact(artifactId: string, mode: DataMode = 'private'): Promise<ArtifactDescriptor> {
    return this.request<ArtifactDescriptor>(ArtifactDescriptor, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}`,
      query: { mode },
    });
  }

  artifactVersions(artifactId: string, mode: DataMode = 'private'): Promise<ArtifactVersionList> {
    return this.request<ArtifactVersionList>(ArtifactVersionList, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/versions`,
      query: { mode },
    });
  }

  artifactManifest(
    projectId: string,
    mode: DataMode = 'private',
  ): Promise<ArtifactProjectManifest> {
    return this.request<ArtifactProjectManifest>(ArtifactProjectManifest, {
      method: 'GET',
      path: '/v1/artifacts/manifest',
      query: { projectId, mode },
    });
  }

  /**
   * Generates and durably persists a document, workbook, deck, analysis or
   * software project. The response names stored artifacts, never workspace paths.
   */
  generateDeliverable(request: DeliverableRequestInput): Promise<Deliverable> {
    return this.request<Deliverable>(Deliverable, {
      method: 'POST',
      path: '/v1/deliverables',
      body: request,
    });
  }

  uploadArtifact(request: ArtifactUploadInput): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: '/v1/artifacts',
      body: request,
    });
  }

  uploadArtifactVersion(
    artifactId: string,
    request: ArtifactVersionInput,
  ): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/versions`,
      body: request,
    });
  }

  restoreArtifactVersion(
    artifactId: string,
    request: { mode?: DataMode; version: number; expectedVersion: number },
  ): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/restore`,
      body: {
        mode: request.mode ?? 'private',
        version: request.version,
        expectedVersion: request.expectedVersion,
      },
    });
  }

  downloadArtifact(
    artifactId: string,
    options: { mode?: DataMode; version?: number } = {},
  ): Promise<ArtifactContent> {
    return this.request<ArtifactContent>(ArtifactContent, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      query: { mode: options.mode ?? 'private', version: options.version },
    });
  }

  exportArtifact(
    artifactId: string,
    options: { mode?: DataMode; version?: number } = {},
  ): Promise<ArtifactExport> {
    return this.request<ArtifactExport>(ArtifactExport, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/export`,
      query: { mode: options.mode ?? 'private', version: options.version },
    });
  }

  deleteArtifact(
    artifactId: string,
    mode: DataMode = 'private',
  ): Promise<ArtifactDeleteResult> {
    return this.request<ArtifactDeleteResult>(ArtifactDeleteResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/delete`,
      body: { mode },
    });
  }

  pruneArtifacts(mode: DataMode = 'private'): Promise<ArtifactPruneResult> {
    return this.request<ArtifactPruneResult>(ArtifactPruneResult, {
      method: 'POST',
      path: '/v1/artifacts/prune',
      body: { mode },
    });
  }

  mediaCapabilities(): Promise<MediaCapabilities> {
    return this.request<MediaCapabilities>(MediaCapabilities, {
      method: 'GET',
      path: '/v1/media/capabilities',
    });
  }

  uploadMedia(request: MediaUploadRequest): Promise<MediaUploadResult> {
    return this.request<MediaUploadResult>(MediaUploadResult, {
      method: 'POST',
      path: '/v1/media',
      body: request,
    });
  }

  media(mediaId: string): Promise<MediaDownload> {
    return this.request<MediaDownload>(MediaDownload, {
      method: 'GET',
      path: `/v1/media/${encodeURIComponent(mediaId)}`,
    });
  }

  validateCreative(request: CreativeValidationRequest): Promise<CreativeValidation> {
    return this.request<CreativeValidation>(CreativeValidation, {
      method: 'POST',
      path: '/v1/creative/validate',
      body: request,
    });
  }

  /**
   * Opens the durable Work stream. The returned generator replays from the
   * cursor and then tails live events; `truncated` reports that the retained
   * window no longer contains the requested cursor, and `lastSeq` is the engine's
   * last assigned sequence at open. A consumer resumes with the last `seq` it
   * applied, either as `after` or as `lastEventId`.
   */
  async openEvents(
    taskId: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ExecutionEvent> {
    const path = `/v1/work/${encodeURIComponent(taskId)}/events`;
    const response = await this.options.fetchImpl(
      joinUrl(this.options.baseUrl, path, { after: options.after }),
      {
        method: 'GET',
        headers: this.headers('text/event-stream'),
        redirect: 'error',
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      await this.parse(ExecutionEvent, response, path);
      throw new CoderaxContractError('the event stream had no body');
    }
    for await (const frame of parseSse(response.body)) {
      const parsed = ExecutionEvent.safeParse(frame);
      if (!parsed.success) {
        throw new CoderaxContractError('an event did not match the published event schema');
      }
      yield parsed.data;
    }
  }
}
