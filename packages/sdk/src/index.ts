import type { z } from 'zod';
import {
  CONTRACT_FINGERPRINT,
  AgentList,
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactPruneResult,
  ArtifactUploadResult,
  ArtifactVersionList,
  CapabilityHandshake,
  ChatReply,
  ChatStreamEvent,
  Conversation,
  ConversationList,
  ExecutionEvent,
  HealthReport,
  MemoryList,
  MemorySearchResult,
  ModelList,
  NotificationList,
  PermissionList,
  Problem,
  ReadinessReport,
  ROUTE_INDEX,
  Schedule,
  ScheduleControlResult,
  ScheduleList,
  ScheduleRemoval,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
  isTerminalChatEvent,
} from '@coderax/contracts';
import type {
  ArtifactKind,
  ArtifactUploadRequestInput,
  ArtifactVersionRequestInput,
  ChatRequestInput,
  DataMode,
  MemoryDeleteRequestInput,
  MemoryWriteRequestInput,
  PermissionDecisionRequest,
  ScheduleAction,
  ScheduleCreateRequestInput,
  TaskArtifactUploadRequestInput,
  TaskListQuery,
  WorkSubmitRequestInput,
} from '@coderax/contracts';
import { checkCompatibility, type CompatibilityReport } from './compat.js';
import { SDK_CONTRACT_VERSION, sdkMetadata, type SdkVersionMetadata } from './version.js';

/**
 * The one client both Coderax (web) and CoderaxCLI consume.
 *
 * Every request body is validated against the route catalogue before it is sent,
 * and every response and streamed frame is parsed with the same schema the
 * server validated against. A deployment that drifts from the contract fails at
 * the client boundary with a named contract error instead of producing subtly
 * wrong UI. The client performs no retries, follows no redirects, keeps no cookie
 * jar and never places the token in a URL or an error message.
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

type RequestMethod = 'GET' | 'POST' | 'DELETE';

type RequestInput = {
  method: RequestMethod;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Which SDK method serves which published operation.
 *
 * `tests/contract/sdk-coverage.test.ts` asserts this table covers the route
 * catalogue exactly, and the cross-repository harness calls the server through
 * these methods only. A new operation without a client method fails that test,
 * so the clients cannot be left behind by the engine.
 */
export const SDK_OPERATION_COVERAGE: Readonly<Record<string, string>> = Object.freeze({
  getHealth: 'health',
  getReadiness: 'readiness',
  getHandshake: 'handshake',
  listAgents: 'agents',
  listModels: 'models',
  submitChat: 'chat',
  submitWork: 'submitWork',
  listTasks: 'tasks',
  listWork: 'listWork',
  getTask: 'task',
  cancelTask: 'cancel',
  resumeTask: 'resume',
  retryTask: 'retry',
  streamTaskEvents: 'events',
  listArtifacts: 'listArtifacts',
  uploadArtifact: 'uploadArtifact',
  pruneArtifacts: 'pruneArtifacts',
  getArtifact: 'getArtifact',
  uploadArtifactVersion: 'uploadArtifactVersion',
  listArtifactVersions: 'listArtifactVersions',
  downloadArtifact: 'downloadArtifact',
  exportArtifact: 'exportArtifact',
  deleteArtifact: 'deleteArtifact',
  listTaskArtifacts: 'artifacts',
  createTaskArtifact: 'createArtifact',
  getTaskArtifact: 'artifact',
  listConversations: 'conversations',
  getConversation: 'conversation',
  listMemory: 'memory',
  writeMemory: 'writeMemory',
  deleteMemory: 'deleteMemory',
  searchMemory: 'searchMemory',
  listPermissions: 'permissions',
  decidePermission: 'decidePermission',
  listNotifications: 'notifications',
  markNotificationRead: 'markNotificationRead',
  listSchedules: 'schedules',
  createSchedule: 'createSchedule',
  controlSchedule: 'controlSchedule',
  deleteSchedule: 'deleteSchedule',
});

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

  /** The version this client was built against. */
  static readonly metadata: SdkVersionMetadata = sdkMetadata();

  private headers(accept = 'application/json'): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.options.token}`,
    };
  }

  /**
   * Validates a request body against the operation's published schema before it
   * leaves the process. The server would reject it anyway; failing here turns a
   * round trip into a named error and makes the catalogue the only description
   * of a payload on both sides.
   */
  private encodeBody(operationId: string, value: unknown): unknown {
    const spec = ROUTE_INDEX.get(operationId);
    if (!spec?.body) {
      throw new CoderaxContractError(`operation ${operationId} publishes no request body`);
    }
    const parsed = spec.body.safeParse(value);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first && first.path.length > 0 ? first.path.join('.') : 'body';
      throw new CoderaxContractError(
        `the request for ${operationId} does not match the published contract (${where}: ${
          first?.message ?? 'invalid'
        })`,
      );
    }
    return parsed.data;
  }

  private async send(input: RequestInput): Promise<Response> {
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

  private async request<T>(schema: z.ZodTypeAny, input: RequestInput): Promise<T> {
    return this.parse<T>(schema, await this.send(input), input.path);
  }

  health(): Promise<HealthReport> {
    return this.request<HealthReport>(HealthReport, { method: 'GET', path: '/v1/health' });
  }

  readiness(): Promise<ReadinessReport> {
    return this.request<ReadinessReport>(ReadinessReport, { method: 'GET', path: '/v1/ready' });
  }

  /** Contract negotiation. Omit `contract` to read the served version only. */
  handshake(options: { contract?: string; fingerprint?: string } = {}): Promise<CapabilityHandshake> {
    const query: Record<string, string> = {};
    if (options.contract !== undefined) query.contract = options.contract;
    if (options.fingerprint !== undefined) query.fingerprint = options.fingerprint;
    return this.request<CapabilityHandshake>(CapabilityHandshake, {
      method: 'GET',
      path: '/v1/handshake',
      ...(Object.keys(query).length === 0 ? {} : { query }),
    });
  }

  /**
   * Negotiates this build's contract version and reports every reason the server
   * cannot serve it. Call this once at startup rather than discovering a gap on
   * the first failed operation.
   */
  async compatibility(): Promise<CompatibilityReport> {
    const handshake = await this.handshake({
      contract: SDK_CONTRACT_VERSION,
      // A matching version string is not proof of a matching catalogue.
      fingerprint: CONTRACT_FINGERPRINT,
    });
    return checkCompatibility({
      handshake,
      requiredOperations: Object.keys(SDK_OPERATION_COVERAGE),
    });
  }

  agents(): Promise<AgentList> {
    return this.request<AgentList>(AgentList, { method: 'GET', path: '/v1/agents' });
  }

  models(): Promise<ModelList> {
    return this.request<ModelList>(ModelList, { method: 'GET', path: '/v1/models' });
  }

  chat(request: ChatRequestInput): Promise<ChatReply> {
    return this.request<ChatReply>(ChatReply, {
      method: 'POST',
      path: '/v1/chat',
      body: this.encodeBody('submitChat', request),
    });
  }

  /**
   * The same Chat turn as versioned frames. The stream ends at `chat.completed`
   * or `chat.failed`; a dropped connection does not cancel a turn the server has
   * already started.
   */
  async *chatStream(
    request: ChatRequestInput,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const path = '/v1/chat';
    const body = this.encodeBody('submitChat', request);
    const response = await this.options.fetchImpl(joinUrl(this.options.baseUrl, path), {
      method: 'POST',
      headers: { ...this.headers('text/event-stream'), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) {
      await this.parse(ChatReply, response, path);
      throw new CoderaxContractError('the chat stream had no body');
    }
    for await (const frame of parseSse(response.body)) {
      const parsed = ChatStreamEvent.safeParse(frame);
      if (!parsed.success) {
        throw new CoderaxContractError('a chat frame did not match the published stream schema');
      }
      yield parsed.data;
      if (isTerminalChatEvent(parsed.data.type)) return;
    }
    throw new CoderaxContractError('the chat stream ended without a terminal frame');
  }

  submitWork(request: WorkSubmitRequestInput): Promise<TaskAccepted> {
    return this.request<TaskAccepted>(TaskAccepted, {
      method: 'POST',
      path: '/v1/work',
      body: this.encodeBody('submitWork', request),
    });
  }

  /** The owner task read model, newest first. */
  tasks(query: TaskListQuery = {}): Promise<TaskList> {
    return this.request<TaskList>(TaskList, {
      method: 'GET',
      path: '/v1/tasks',
      query: {
        state: query.state,
        conversationId: query.conversationId,
        limit: query.limit,
      },
    });
  }

  /**
   * The same read model at the address `1.1.0` published. It exists so a client
   * that has not moved to `GET /v1/tasks` keeps working; it is an alias over the
   * same handler, not a second implementation.
   */
  listWork(query: TaskListQuery = {}): Promise<TaskList> {
    return this.request<TaskList>(TaskList, {
      method: 'GET',
      path: '/v1/work',
      query: {
        state: query.state,
        conversationId: query.conversationId,
        limit: query.limit,
      },
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
      body: this.encodeBody('cancelTask', reason ? { reason } : {}),
    });
  }

  resume(taskId: string, generation: number): Promise<TaskControlResult> {
    return this.request<TaskControlResult>(TaskControlResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/resume`,
      body: this.encodeBody('resumeTask', { generation }),
    });
  }

  retry(taskId: string, generation: number): Promise<TaskControlResult> {
    return this.request<TaskControlResult>(TaskControlResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/retry`,
      body: this.encodeBody('retryTask', { generation }),
    });
  }

  /** The task-scoped projection of the durable artifact store. */
  artifacts(taskId: string): Promise<ArtifactDescriptorList> {
    return this.request<ArtifactDescriptorList>(ArtifactDescriptorList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/artifacts`,
    });
  }

  artifact(taskId: string, artifactId: string): Promise<ArtifactContent> {
    return this.request<ArtifactContent>(ArtifactContent, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
    });
  }

  createArtifact(
    taskId: string,
    request: TaskArtifactUploadRequestInput,
  ): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/artifacts`,
      body: this.encodeBody('createTaskArtifact', request),
    });
  }

  listArtifacts(query: {
    mode?: DataMode;
    kind?: ArtifactKind;
    projectId?: string;
    conversationId?: string;
    taskId?: string;
    limit?: number;
  } = {}): Promise<ArtifactDescriptorList> {
    return this.request<ArtifactDescriptorList>(ArtifactDescriptorList, {
      method: 'GET',
      path: '/v1/artifacts',
      query,
    });
  }

  uploadArtifact(request: ArtifactUploadRequestInput): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: '/v1/artifacts',
      body: this.encodeBody('uploadArtifact', request),
    });
  }

  pruneArtifacts(mode: DataMode = 'private'): Promise<ArtifactPruneResult> {
    return this.request<ArtifactPruneResult>(ArtifactPruneResult, {
      method: 'POST',
      path: '/v1/artifacts/prune',
      body: this.encodeBody('pruneArtifacts', { mode }),
    });
  }

  getArtifact(artifactId: string, mode: DataMode = 'private'): Promise<ArtifactDescriptor> {
    return this.request<ArtifactDescriptor>(ArtifactDescriptor, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}`,
      query: { mode },
    });
  }

  uploadArtifactVersion(
    artifactId: string,
    request: ArtifactVersionRequestInput,
  ): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/versions`,
      body: this.encodeBody('uploadArtifactVersion', request),
    });
  }

  listArtifactVersions(
    artifactId: string,
    mode: DataMode = 'private',
  ): Promise<ArtifactVersionList> {
    return this.request<ArtifactVersionList>(ArtifactVersionList, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/versions`,
      query: { mode },
    });
  }

  downloadArtifact(
    artifactId: string,
    query: { mode?: DataMode; version?: number } = {},
  ): Promise<ArtifactContent> {
    return this.request<ArtifactContent>(ArtifactContent, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      query,
    });
  }

  exportArtifact(
    artifactId: string,
    query: { mode?: DataMode; version?: number } = {},
  ): Promise<ArtifactExport> {
    return this.request<ArtifactExport>(ArtifactExport, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/export`,
      query,
    });
  }

  deleteArtifact(artifactId: string, mode: DataMode = 'private'): Promise<ArtifactDeleteResult> {
    return this.request<ArtifactDeleteResult>(ArtifactDeleteResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/delete`,
      body: this.encodeBody('deleteArtifact', { mode }),
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

  writeMemory(request: MemoryWriteRequestInput): Promise<MemoryList> {
    return this.request<MemoryList>(MemoryList, {
      method: 'POST',
      path: '/v1/memory',
      body: this.encodeBody('writeMemory', request),
    });
  }

  deleteMemory(request: MemoryDeleteRequestInput): Promise<MemoryList> {
    return this.request<MemoryList>(MemoryList, {
      method: 'POST',
      path: '/v1/memory/delete',
      body: this.encodeBody('deleteMemory', request),
    });
  }

  searchMemory(query: { q: string; mode?: DataMode; limit?: number }): Promise<MemorySearchResult> {
    return this.request<MemorySearchResult>(MemorySearchResult, {
      method: 'GET',
      path: '/v1/memory/search',
      query: { q: query.q, mode: query.mode, limit: query.limit },
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
      body: this.encodeBody('decidePermission', request),
    });
  }

  notifications(): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'GET',
      path: '/v1/notifications',
    });
  }

  markNotificationRead(taskId: string): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'POST',
      path: `/v1/notifications/${encodeURIComponent(taskId)}`,
    });
  }

  schedules(): Promise<ScheduleList> {
    return this.request<ScheduleList>(ScheduleList, {
      method: 'GET',
      path: '/v1/schedules',
    });
  }

  createSchedule(request: ScheduleCreateRequestInput): Promise<Schedule> {
    return this.request<Schedule>(Schedule, {
      method: 'POST',
      path: '/v1/schedules',
      body: this.encodeBody('createSchedule', request),
    });
  }

  controlSchedule(scheduleId: string, action: ScheduleAction): Promise<ScheduleControlResult> {
    return this.request<ScheduleControlResult>(ScheduleControlResult, {
      method: 'POST',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}`,
      body: this.encodeBody('controlSchedule', { action }),
    });
  }

  deleteSchedule(scheduleId: string): Promise<ScheduleRemoval> {
    return this.request<ScheduleRemoval>(ScheduleRemoval, {
      method: 'DELETE',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}`,
    });
  }

  /**
   * Replays and tails execution events from a sequence cursor.
   *
   * Pass the last `seq` you consumed as `after`. The first frame is
   * `stream.truncated` when the retained window no longer covers that cursor.
   */
  async *events(
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

export { checkCompatibility, type CompatibilityReport } from './compat.js';
export {
  SDK_CHAT_STREAM_VERSION,
  SDK_CONTRACT_MAJOR,
  SDK_CONTRACT_VERSION,
  SDK_EVENT_SCHEMA_VERSION,
  SDK_NAME,
  SDK_SUPPORTED_CONTRACT_VERSIONS,
  SDK_VERSION,
  sdkMetadata,
  type SdkVersionMetadata,
} from './version.js';

// Consumers get the input shapes, where defaulted fields may be omitted.
export type {
  ArtifactUploadRequestInput as ArtifactUploadRequest,
  ArtifactVersionRequestInput as ArtifactVersionRequest,
  TaskArtifactUploadRequestInput as TaskArtifactUploadRequest,
  ChatRequestInput as ChatRequest,
  DataMode,
  MemoryDeleteRequestInput as MemoryDeleteRequest,
  MemoryWriteRequestInput as MemoryWriteRequest,
  PermissionDecisionRequest,
  ScheduleAction,
  ScheduleCreateRequestInput as ScheduleCreateRequest,
  TaskListQuery,
  WorkSubmitRequestInput as WorkSubmitRequest,
};
