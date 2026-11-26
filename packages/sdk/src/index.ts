import type { z } from 'zod';
import {
  AgentList,
  MediaIntakeRequest,
  MediaIntakeResult,
  ArtifactContent,
  ArtifactDeleteResult,
  ArtifactDescriptor,
  ArtifactDescriptorList,
  ArtifactExport,
  ArtifactPruneResult,
  ArtifactUploadResult,
  ArtifactVersionList,
  CapabilityReport,
  ChatReply,
  Conversation,
  ConversationList,
  Deliverable,
  ExecutionEvent,
  HealthReport,
  MemoryList,
  ModelList,
  NotificationList,
  PermissionList,
  Problem,
  ReadinessReport,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
} from '@coderax/contracts';
import type {
  ArtifactKind,
  ArtifactUploadRequest,
  ArtifactVersionRequest,
  ChatRequest,
  DataMode,
  DeliverableRequestInput,
  PermissionDecisionRequest,
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
  method: 'GET' | 'POST';
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

  capabilities(): Promise<CapabilityReport> {
    return this.request<CapabilityReport>(CapabilityReport, {
      method: 'GET',
      path: '/v1/capabilities',
    });
  }

  /** Produces a real, verified artifact inside the request's workspace mode. */
  intakeMedia(request: MediaIntakeRequest): Promise<MediaIntakeResult> {
    return this.request<MediaIntakeResult>(MediaIntakeResult, {
      method: 'POST',
      path: '/v1/media',
      body: request,
    });
  }

  deliver(request: DeliverableRequestInput): Promise<Deliverable> {
    return this.request<Deliverable>(Deliverable, {
      method: 'POST',
      path: '/v1/deliverables',
      body: request,
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

  notifications(): Promise<NotificationList> {
    return this.request<NotificationList>(NotificationList, {
      method: 'GET',
      path: '/v1/notifications',
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

  uploadArtifact(request: ArtifactUploadRequest): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: '/v1/artifacts',
      body: request,
    });
  }

  uploadArtifactVersion(
    artifactId: string,
    request: ArtifactVersionRequest,
  ): Promise<ArtifactUploadResult> {
    return this.request<ArtifactUploadResult>(ArtifactUploadResult, {
      method: 'POST',
      path: `/v1/artifacts/${encodeURIComponent(artifactId)}/versions`,
      body: request,
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

export type {
  ArtifactKind,
  ArtifactUploadRequest,
  ArtifactVersionRequest,
  ChatRequest,
  DataMode,
  PermissionDecisionRequest,
  WorkSubmitRequest,
};
