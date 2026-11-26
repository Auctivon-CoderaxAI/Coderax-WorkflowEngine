import type {
  CapabilityFlags,
  ChatStreamEvent,
  DataMode,
  ScheduleAction,
} from '@coderax/contracts';
import {
  API_PREFIX,
  CHAT_STREAM_VERSION,
  CONTRACT_FINGERPRINT,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  negotiateContract,
  supportedContractVersions,
} from '@coderax/contracts';
import type { ApplicationService, EventStream } from '../orchestration/service.js';
import type { RouteRegistry } from './router.js';
import { problemResult } from './router.js';
import type { ServiceFailure } from '../support/result.js';

/**
 * Route handlers are wiring, not behavior.
 *
 * Each handler validates nothing (the router already validated against the
 * contract), decides nothing (the service owns the decision) and formats the
 * response it was given. There is no orchestration logic here, and no route
 * reaches a repository, an adapter or a provider directly.
 */

export type HandshakeInfo = {
  server: { name: string; version: string; startedAt: string };
  limits: {
    maxBodyBytes: number;
    eventBufferSize: number;
    maxConcurrentTasks: number;
    scheduleMinIntervalMs: number;
    artifactMaxBytes: number;
    memoryMaxValueLength: number;
  };
};

const TERMINAL_EVENT_TYPES = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
]);

function fromFailure(failure: ServiceFailure, requestId: string) {
  return problemResult(failure.code, failure.detail, requestId, failure.retryable);
}

function isTerminalPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TERMINAL_EVENT_TYPES.has(type);
}

function isTerminalChatPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'chat.completed' || type === 'chat.failed';
}

function eventId(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { eventId?: unknown }).eventId;
    if (typeof id === 'string') return id;
  }
  return '';
}

function acceptsEventStream(accept: string | undefined): boolean {
  if (!accept) return false;
  return accept.split(',').some((entry) => {
    const [mediaType, ...params] = entry
      .trim()
      .toLowerCase()
      .split(';')
      .map((part) => part.trim());
    if (mediaType !== 'text/event-stream') return false;
    // `q=0` means the client explicitly refuses this media type (RFC 9110), so
    // `application/json, text/event-stream;q=0` must still get JSON.
    const quality = params.find((param) => param.startsWith('q='));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

/**
 * Replays retained events, then tails the live ones. The stream closes on a
 * terminal event so a client never waits for a task that already finished; a
 * disconnected client stops consuming without stopping the run.
 */
async function* toEventStream(stream: EventStream): AsyncIterable<unknown> {
  const seen = new Set<string>();
  if (stream.truncatedEvent) {
    seen.add(stream.truncatedEvent.eventId);
    yield stream.truncatedEvent;
  }
  for (const event of stream.replay.events) {
    seen.add(eventId(event));
    yield event;
    if (isTerminalPayload(event)) return;
  }
  // A task that already finished will never publish again, so a cursor past the
  // terminal frame must close the stream instead of holding it open.
  if (stream.closedAfterReplay) return;

  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  const unsubscribe = stream.subscribe((event) => {
    const id = eventId(event);
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    pending.push(event);
    wake?.();
  });

  try {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        if (isTerminalPayload(next)) return;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, 30_000);
        timer.unref();
      });
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}

/**
 * Chat frames are already ordered by the turn itself, so this only has to stop
 * at the terminal frame. A client that disconnects mid-turn does not affect the
 * turn: the reply is still persisted once the adapter finishes.
 */
async function* toChatStream(
  events: AsyncIterable<ChatStreamEvent>,
): AsyncIterable<unknown> {
  for await (const frame of events) {
    yield frame;
    if (isTerminalChatPayload(frame)) return;
  }
}

export function registerRoutes(
  registry: RouteRegistry,
  service: ApplicationService,
  info: HandshakeInfo,
): void {
  registry.register('getHealth', async () => ({
    kind: 'json',
    status: 200,
    body: await service.health(),
  }));

  registry.register('getReadiness', async () => ({
    kind: 'json',
    status: 200,
    body: await service.readiness(),
  }));

  /**
   * The handshake is built from the registry, not from the catalogue, so the
   * operations it reports are exactly the ones a handler exists for.
   */
  registry.register('getHandshake', async (context) => {
    const requested =
      typeof context.query.contract === 'string' ? context.query.contract : undefined;
    const fingerprint =
      typeof context.query.fingerprint === 'string' ? context.query.fingerprint : undefined;
    const negotiation = negotiateContract(requested, {
      ...(fingerprint !== undefined ? { provided: fingerprint } : {}),
      expected: CONTRACT_FINGERPRINT,
    });
    const registered = registry.list().map((route) => route.spec);
    const operationIds = new Set(registered.map((spec) => spec.operationId));
    const has = (operationId: string): boolean => operationIds.has(operationId);
    const chatRoute = registered.find((spec) => spec.operationId === 'submitChat');
    const agents = service.agents();

    const capabilities: CapabilityFlags = {
      health: has('getHealth') && has('getReadiness'),
      discovery: has('listAgents') && has('listModels'),
      chat: has('submitChat'),
      chatStreaming: has('submitChat') && chatRoute?.negotiated === true,
      work: has('submitWork') && has('getTask'),
      workStreaming: has('streamTaskEvents'),
      cursorReplay: has('streamTaskEvents'),
      cancellation: has('cancelTask'),
      resume: has('resumeTask'),
      retry: has('retryTask'),
      permissions: has('listPermissions') && has('decidePermission'),
      notifications: has('listNotifications'),
      notificationRead: has('markNotificationRead'),
      schedules: has('listSchedules') && has('createSchedule'),
      artifacts: has('listArtifacts') && has('getArtifact') && has('uploadArtifact'),
      memory: has('listMemory') && has('writeMemory') && has('deleteMemory'),
      memorySearch: has('searchMemory'),
      conversations: has('listConversations') && has('getConversation'),
      taskList: has('listTasks'),
      idempotentSubmission: has('submitWork'),
      externalAgents: agents.agents.some(
        (agent) => agent.external && agent.availability.available,
      ),
      paidModels: false,
    };

    return {
      kind: 'json',
      status: 200,
      body: {
        contractVersion: CONTRACT_VERSION,
        contractMajor: CONTRACT_MAJOR,
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        chatStreamVersion: CHAT_STREAM_VERSION,
        apiPrefix: API_PREFIX,
        contractFingerprint: CONTRACT_FINGERPRINT,
        supportedContractVersions: supportedContractVersions(),
        ...(requested ? { requestedContractVersion: requested } : {}),
        compatible: negotiation.compatible,
        negotiatedContractVersion: negotiation.negotiatedContractVersion,
        negotiation: negotiation.negotiation,
        server: info.server,
        operations: registered.map((spec) => ({
          operationId: spec.operationId,
          method: spec.method,
          path: spec.path,
          tags: spec.tags,
          auth: spec.auth,
          stream: spec.stream === true,
        })),
        capabilities,
        limits: info.limits,
      },
    };
  });

  registry.register('listAgents', async () => ({
    kind: 'json',
    status: 200,
    body: service.agents(),
  }));

  registry.register('listModels', async () => ({
    kind: 'json',
    status: 200,
    body: service.models(),
  }));

  registry.register('submitChat', async (context) => {
    const request = context.body as never;
    if (acceptsEventStream(context.accept)) {
      const streamed = await service.chatStream(context.principal, request);
      if (!streamed.ok) return fromFailure(streamed, context.requestId);
      return { kind: 'sse', status: 200, drainOnDisconnect: true, events: toChatStream(streamed.value) };
    }
    const result = await service.chat(context.principal, request);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('submitWork', async (context) => {
    const result = await service.submitWork(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 202, body: result.value };
  });

  registry.register('listTasks', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.tasks(context.principal, context.query as never),
  }));

  // The compatibility address for the same read model. One handler, two specs.
  registry.register('listWork', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.tasks(context.principal, context.query as never),
  }));

  registry.register('getTask', async (context) => {
    const result = await service.task(context.principal, context.params.taskId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('cancelTask', async (context) => {
    const body = (context.body ?? {}) as { reason?: string };
    const result = await service.cancelTask(
      context.principal,
      context.params.taskId ?? '',
      body.reason,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('resumeTask', async (context) => {
    const body = context.body as { generation: number };
    const result = await service.resumeTask(
      context.principal,
      context.params.taskId ?? '',
      body.generation,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('retryTask', async (context) => {
    const body = context.body as { generation: number };
    const result = await service.retryTask(
      context.principal,
      context.params.taskId ?? '',
      body.generation,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('streamTaskEvents', async (context) => {
    const after = context.query.after;
    const cursor = typeof after === 'number' ? after : 0;
    const result = await service.events(context.principal, context.params.taskId ?? '', cursor);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'sse', status: 200, events: toEventStream(result.value) };
  });

  registry.register('listArtifacts', async (context) => {
    const result = await service.artifacts.list(context.principal, context.query as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('uploadArtifact', async (context) => {
    const result = await service.artifacts.upload(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('pruneArtifacts', async (context) => {
    const body = context.body as { mode?: DataMode };
    const result = await service.artifacts.prune(context.principal, body.mode ?? 'private');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('getArtifact', async (context) => {
    const query = context.query as { mode?: DataMode };
    const result = await service.artifacts.get(
      context.principal,
      context.params.artifactId ?? '',
      query.mode ?? 'private',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('uploadArtifactVersion', async (context) => {
    const result = await service.artifacts.addVersion(
      context.principal,
      context.params.artifactId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('listArtifactVersions', async (context) => {
    const query = context.query as { mode?: DataMode };
    const result = await service.artifacts.versions(
      context.principal,
      context.params.artifactId ?? '',
      query.mode ?? 'private',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('downloadArtifact', async (context) => {
    const result = await service.artifacts.download(
      context.principal,
      context.params.artifactId ?? '',
      context.query as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('exportArtifact', async (context) => {
    const result = await service.artifacts.exportBundle(
      context.principal,
      context.params.artifactId ?? '',
      context.query as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('deleteArtifact', async (context) => {
    const body = context.body as { mode?: DataMode };
    const result = await service.artifacts.remove(
      context.principal,
      context.params.artifactId ?? '',
      body.mode ?? 'private',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  // Task routes project the same durable store; they add scoping, not storage.
  registry.register('listTaskArtifacts', async (context) => {
    const result = await service.taskArtifacts(context.principal, context.params.taskId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('createTaskArtifact', async (context) => {
    const result = await service.createTaskArtifact(
      context.principal,
      context.params.taskId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('getTaskArtifact', async (context) => {
    const result = await service.taskArtifact(
      context.principal,
      context.params.taskId ?? '',
      context.params.artifactId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listConversations', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.conversations(context.principal),
  }));

  registry.register('getConversation', async (context) => {
    const result = await service.conversation(
      context.principal,
      context.params.conversationId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listMemory', async (context) => {
    const mode: DataMode = context.query.mode === 'cloud' ? 'cloud' : 'private';
    return { kind: 'json', status: 200, body: await service.memory(context.principal, mode) };
  });

  registry.register('writeMemory', async (context) => {
    const result = await service.writeMemory(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('deleteMemory', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.deleteMemory(context.principal, context.body as never),
  }));

  registry.register('searchMemory', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.searchMemory(context.principal, context.query as never),
  }));

  registry.register('listPermissions', async (context) => {
    const result = await service.permissions(context.principal, context.params.taskId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('decidePermission', async (context) => {
    const result = await service.decidePermission(
      context.principal,
      context.params.taskId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listNotifications', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.notifications(context.principal),
  }));

  registry.register('markNotificationRead', async (context) => {
    const result = await service.markNotificationRead(
      context.principal,
      context.params.taskId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listSchedules', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.schedules(context.principal),
  }));

  registry.register('createSchedule', async (context) => {
    const result = await service.createSchedule(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('controlSchedule', async (context) => {
    const body = context.body as { action: ScheduleAction };
    const result = await service.controlSchedule(
      context.principal,
      context.params.scheduleId ?? '',
      body.action,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('deleteSchedule', async (context) => {
    const result = await service.removeSchedule(
      context.principal,
      context.params.scheduleId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });
}
