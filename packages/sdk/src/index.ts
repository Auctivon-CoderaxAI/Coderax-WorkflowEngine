import type { z } from 'zod';
import {
  AgentList,
  BudgetState,
  ChatReply,
  Conversation,
  ConversationDeletion,
  ConversationList,
  ExecutionEvent,
  HealthReport,
  MemoryDeletion,
  MemoryEntry,
  MemoryList,
  ModelList,
  MetricsReport,
  NotificationList,
  PermissionList,
  Problem,
  ReadinessReport,
  ReceiptList,
  TaskAccepted,
  TaskControlResult,
  TaskList,
  TaskStatus,
} from '@coderax/contracts';
import type {
  ChatRequest,
  ConversationListQuery,
  DataMode,
  NotificationListQuery,
  PermissionDecisionRequest,
  PermissionListQuery,
  ReceiptListQuery,
  WorkListQuery,
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

type RequestInput = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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

  submitWork(
    request: WorkSubmitRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<TaskAccepted> {
    return this.request<TaskAccepted>(TaskAccepted, {
      method: 'POST',
      path: '/v1/work',
      body: {
        ...request,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      },
    });
  }

  /** Owner-scoped Work tasks, filtered and cursor-paged. */
  tasks(query: WorkListQuery = {}): Promise<TaskList> {
    return this.request<TaskList>(TaskList, {
      method: 'GET',
      path: '/v1/work',
      query: {
        state: query.state,
        conversationId: query.conversationId,
        agent: query.agent,
        mode: query.mode,
        limit: query.limit,
        cursor: query.cursor,
      },
    });
  }

  /** Execution receipts for one task. */
  receipts(taskId: string, query: ReceiptListQuery = {}): Promise<ReceiptList> {
    return this.request<ReceiptList>(ReceiptList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/receipts`,
      query: { limit: query.limit, cursor: query.cursor },
    });
  }

  /** Process-local queue, execution, lease and persistence counters. */
  metrics(): Promise<MetricsReport> {
    return this.request<MetricsReport>(MetricsReport, {
      method: 'GET',
      path: '/v1/metrics',
    });
  }

  /** Daily zero-cost budget and quota status. */
  budget(): Promise<BudgetState> {
    return this.request<BudgetState>(BudgetState, {
      method: 'GET',
      path: '/v1/budget',
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

  conversations(query: ConversationListQuery = {}): Promise<ConversationList> {
    return this.request<ConversationList>(ConversationList, {
      method: 'GET',
      path: '/v1/conversations',
      query: {
        mode: query.mode,
        isWork: query.isWork,
        agent: query.agent,
        limit: query.limit,
        cursor: query.cursor,
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
    query: { limit?: number; cursor?: string } = {},
  ): Promise<MemoryList> {
    return this.request<MemoryList>(MemoryList, {
      method: 'GET',
      path: '/v1/memory',
      query: { mode, limit: query.limit, cursor: query.cursor },
    });
  }

  writeMemory(
    key: string,
    value: string,
    mode: DataMode = 'private',
  ): Promise<MemoryEntry> {
    return this.request<MemoryEntry>(MemoryEntry, {
      method: 'PUT',
      path: `/v1/memory/${encodeURIComponent(key)}`,
      body: { value, mode },
    });
  }

  deleteMemory(key: string, mode: DataMode = 'private'): Promise<MemoryDeletion> {
    return this.request<MemoryDeletion>(MemoryDeletion, {
      method: 'DELETE',
      path: `/v1/memory/${encodeURIComponent(key)}`,
      query: { mode },
    });
  }

  permissions(
    taskId: string,
    query: PermissionListQuery = {},
  ): Promise<PermissionList> {
    return this.request<PermissionList>(PermissionList, {
      method: 'GET',
      path: `/v1/work/${encodeURIComponent(taskId)}/permissions`,
      query: { decision: query.decision, limit: query.limit, cursor: query.cursor },
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
      query: {
        unreadOnly: query.unreadOnly,
        limit: query.limit,
        cursor: query.cursor,
      },
    });
  }

  /** Clears the blue dot for the named terminal tasks. */
  markNotificationsRead(taskIds: string[]): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'POST',
      path: '/v1/notifications/read',
      body: { taskIds },
    });
  }

  /** Replays and tails execution events from a sequence cursor. */
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

export type { ChatRequest, DataMode, PermissionDecisionRequest, WorkSubmitRequest };
