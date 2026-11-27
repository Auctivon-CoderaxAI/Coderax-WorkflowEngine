import type { z } from 'zod';
import {
  AgentList,
  ArtifactContent,
  BudgetState,
  MetricsReport,
  ArtifactList,
  ArtifactRecord,
  ArtifactUploadRequest,
  ChatReply,
  ChatStreamFrame,
  Conversation,
  ConversationDeletion,
  ConversationList,
  EngineHandshake,
  ExecutionEvent,
  HealthReport,
  MemoryDeletion,
  MemoryEntry,
  MemoryList,
  ModelList,
  NotificationList,
  PermissionList,
  Problem,
  ReceiptList,
  ReadinessReport,
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleList,
  ScheduleUpdateRequest,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
} from '@coderax/contracts';
import type {
  ChatRequest,
  DataMode,
  MemoryPutRequest,
  NotificationListQuery,
  NotificationReadRequest,
  PermissionDecisionRequest,
  PermissionListQuery,
  ReceiptListQuery,
  TaskState,
  WorkSubmitRequest,
} from '@coderax/contracts';
import { CoderaxApiError, CoderaxContractError } from './errors.js';
import { parseSseFrames } from './stream.js';
import { assertCompatible } from './version.js';

/**
 * The one client both Coderax (web) and Coderax-CLI consume.
 *
 * Every response is parsed with the same zod schema the server validated
 * against, so a deployment that drifts from the contract fails at the client
 * boundary with a named contract error instead of producing subtly wrong UI. The
 * client performs no retries, follows no redirects, keeps no cookie jar and never
 * places the token in a URL or an error message.
 */

export { CoderaxApiError, CoderaxCompatibilityError, CoderaxContractError } from './errors.js';
export {
  SDK_CONTRACT_VERSION,
  SDK_ENGINE_CONTRACT,
  SDK_EVENT_SCHEMA_VERSION,
  SDK_VERSION,
  SDK_VERSION_METADATA,
  assertCompatible,
  checkCompatibility,
} from './version.js';
export { parseSse, parseSseFrames } from './stream.js';
export { SDK_COVERAGE, SDK_MANIFEST, SDK_STREAM_METHODS } from './manifest.js';
export type { CompatibilityReport } from './version.js';
export type { ParsedSseFrame } from './stream.js';
export type {
  ChatRequest,
  DataMode,
  MemoryPutRequest,
  NotificationReadRequest,
  PermissionDecisionRequest,
  TaskState,
  WorkSubmitRequest,
} from '@coderax/contracts';

export type CoderaxClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type RequestInput = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra headers, used for `Idempotency-Key` on Work submission. */
  headers?: Record<string, string>;
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

  private async send(input: RequestInput): Promise<Response> {
    return this.options.fetchImpl(
      joinUrl(this.options.baseUrl, input.path, input.query),
      {
        method: input.method,
        headers: {
          ...this.headers(),
          ...(input.headers ?? {}),
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

  readiness(): Promise<ReadinessReport> {
    return this.request<ReadinessReport>(ReadinessReport, { method: 'GET', path: '/v1/ready' });
  }

  /** The raw handshake. Use `negotiate()` to refuse an incompatible engine. */
  handshake(): Promise<EngineHandshake> {
    return this.request<EngineHandshake>(EngineHandshake, {
      method: 'GET',
      path: '/v1/handshake',
    });
  }

  /** Fetches the handshake and throws unless this SDK can parse it. */
  async negotiate(): Promise<EngineHandshake> {
    return assertCompatible(await this.handshake());
  }

  agents(): Promise<AgentList> {
    return this.request<AgentList>(AgentList, { method: 'GET', path: '/v1/agents' });
  }

  models(): Promise<ModelList> {
    return this.request<ModelList>(ModelList, { method: 'GET', path: '/v1/models' });
  }

  chat(request: ChatRequest): Promise<ChatReply> {
    return this.request<ChatReply>(ChatReply, {
      method: 'POST',
      path: '/v1/chat',
      body: request,
    });
  }

  /**
   * The same Chat turn over the shared SSE transport. Each frame is validated
   * against the published `ChatStreamFrame` schema, so a deployment that streams
   * a shape the contract does not describe fails here instead of in a renderer.
   */
  async *chatStream(
    request: ChatRequest,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamFrame> {
    const path = '/v1/chat';
    const response = await this.options.fetchImpl(joinUrl(this.options.baseUrl, path), {
      method: 'POST',
      headers: {
        ...this.headers('text/event-stream'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) {
      await this.parse(ChatReply, response, path);
      throw new CoderaxContractError('the chat stream had no body');
    }
    for await (const frame of parseSseFrames(response.body)) {
      const parsed = ChatStreamFrame.safeParse(frame.data);
      if (!parsed.success) {
        throw new CoderaxContractError('a chat frame did not match the published schema');
      }
      yield parsed.data;
    }
  }

  /**
   * Submits durable Work. Reusing an idempotency key with the same request
   * replays the original task; reusing it with a different request is refused.
   * The key is sent as a header so it is never part of a logged URL.
   */
  submitWork(
    request: WorkSubmitRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<TaskAccepted> {
    return this.request<TaskAccepted>(TaskAccepted, {
      method: 'POST',
      path: '/v1/work',
      body: request,
      ...(options.idempotencyKey
        ? { headers: { 'idempotency-key': options.idempotencyKey } }
        : {}),
    });
  }

  task(taskId: string): Promise<TaskStatus> {
    return this.request<TaskStatus>(TaskStatus, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}`,
    });
  }

  /** The owner-scoped task read model, newest first. */
  tasks(
    options: {
      limit?: number;
      cursor?: string;
      state?: TaskState;
      mode?: DataMode;
      agent?: string;
      conversationId?: string;
    } = {},
  ): Promise<TaskList> {
    return this.request<TaskList>(TaskList, {
      method: 'GET',
      path: '/v1/tasks',
      query: {
        limit: options.limit,
        cursor: options.cursor,
        state: options.state,
        mode: options.mode,
        agent: options.agent,
        conversationId: options.conversationId,
      },
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

  conversations(
    options: {
      mode?: DataMode;
      isWork?: boolean;
      agent?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ConversationList> {
    return this.request<ConversationList>(ConversationList, {
      method: 'GET',
      path: '/v1/conversations',
      query: {
        mode: options.mode,
        isWork: options.isWork === undefined ? undefined : String(options.isWork),
        agent: options.agent,
        limit: options.limit,
        cursor: options.cursor,
      },
    });
  }

  deleteConversation(conversationId: string): Promise<ConversationDeletion> {
    return this.request<ConversationDeletion>(ConversationDeletion, {
      method: 'DELETE',
      path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
    });
  }

  conversation(conversationId: string): Promise<Conversation> {
    return this.request<Conversation>(Conversation, {
      method: 'GET',
      path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
    });
  }

  memory(
    mode: DataMode = 'private',
    options: { limit?: number; cursor?: string } = {},
  ): Promise<MemoryList> {
    return this.request<MemoryList>(MemoryList, {
      method: 'GET',
      path: '/v1/memory',
      query: { mode, limit: options.limit, cursor: options.cursor },
    });
  }

  deleteMemory(key: string, mode: DataMode = 'private'): Promise<MemoryDeletion> {
    return this.request<MemoryDeletion>(MemoryDeletion, {
      method: 'DELETE',
      path: `/v1/memory/${encodeURIComponent(key)}`,
      query: { mode },
    });
  }

  putMemory(request: MemoryPutRequest): Promise<MemoryEntry> {
    return this.request<MemoryEntry>(MemoryEntry, {
      method: 'POST',
      path: '/v1/memory',
      body: request,
    });
  }

  permissions(taskId: string, query: PermissionListQuery = {}): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/permissions`,
      query,
    });
  }

  pendingPermissions(query: PermissionListQuery = {}): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'GET',
      path: '/v1/permissions',
      query,
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

  notifications(query: NotificationListQuery = {}): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'GET',
      path: '/v1/notifications',
      query,
    });
  }

  budget(): Promise<BudgetState> {
    return this.request<BudgetState>(BudgetState, { method: 'GET', path: '/v1/budget' });
  }

  metrics(): Promise<MetricsReport> {
    return this.request<MetricsReport>(MetricsReport, { method: 'GET', path: '/v1/metrics' });
  }

  receipts(taskId: string, query: ReceiptListQuery = {}): Promise<ReceiptList> {
    return this.request<ReceiptList>(ReceiptList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/receipts`,
      query,
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

  updateSchedule(scheduleId: string, request: ScheduleUpdateRequest): Promise<Schedule> {
    return this.request<Schedule>(Schedule, {
      method: 'PATCH',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}`,
      body: request,
    });
  }

  schedule(scheduleId: string): Promise<Schedule> {
    return this.request<Schedule>(Schedule, {
      method: 'GET',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}`,
    });
  }

  cancelSchedule(scheduleId: string): Promise<ScheduleControlResult> {
    return this.request<ScheduleControlResult>(ScheduleControlResult, {
      method: 'POST',
      path: `/v1/schedules/${encodeURIComponent(scheduleId)}/cancel`,
    });
  }

  artifacts(taskId: string): Promise<ArtifactList> {
    return this.request<ArtifactList>(ArtifactList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/artifacts`,
    });
  }

  uploadArtifact(taskId: string, request: ArtifactUploadRequest): Promise<ArtifactRecord> {
    return this.request<ArtifactRecord>(ArtifactRecord, {
      method: 'POST',
      path: `/v1/work/${encodeURIComponent(taskId)}/artifacts`,
      body: request,
    });
  }

  artifact(artifactId: string): Promise<ArtifactRecord> {
    return this.request<ArtifactRecord>(ArtifactRecord, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}`,
    });
  }

  artifactContent(artifactId: string): Promise<ArtifactContent> {
    return this.request<ArtifactContent>(ArtifactContent, {
      method: 'GET',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
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
    options: { after?: number; lastEventId?: number; signal?: AbortSignal } = {},
  ): Promise<{
    truncated: boolean;
    lastSeq: number;
    events: AsyncGenerator<ExecutionEvent>;
  }> {
    const path = `/v1/work/${encodeURIComponent(taskId)}/events`;
    const cursor = options.after ?? options.lastEventId;
    const response = await this.options.fetchImpl(
      joinUrl(this.options.baseUrl, path, { after: options.after }),
      {
        method: 'GET',
        headers: {
          ...this.headers('text/event-stream'),
          ...(cursor === undefined ? {} : { 'last-event-id': String(cursor) }),
        },
        redirect: 'error',
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      await this.parse(ExecutionEvent, response, path);
      throw new CoderaxContractError('the event stream had no body');
    }
    const truncated = response.headers.get('x-coderax-truncated') === 'true';
    const headerSeq = Number(response.headers.get('x-coderax-last-seq') ?? '0');
    const body = response.body;
    async function* iterate(): AsyncGenerator<ExecutionEvent> {
      for await (const frame of parseSseFrames(body)) {
        const parsed = ExecutionEvent.safeParse(frame.data);
        if (!parsed.success) {
          throw new CoderaxContractError('an event did not match the published event schema');
        }
        yield parsed.data;
      }
    }
    return {
      truncated,
      lastSeq: Number.isFinite(headerSeq) ? headerSeq : 0,
      events: iterate(),
    };
  }

  /** Replays and tails execution events from a sequence cursor. */
  async *events(
    taskId: string,
    options: { after?: number; lastEventId?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ExecutionEvent> {
    const stream = await this.openEvents(taskId, options);
    for await (const event of stream.events) {
      yield event;
    }
  }
}
