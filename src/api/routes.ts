import type { DataMode } from '@coderax/contracts';
import type { ApplicationService } from '../orchestration/service.js';
import type { RouteRegistry, SseFrame } from './router.js';
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

function fromFailure(failure: ServiceFailure, requestId: string) {
  return problemResult(failure.code, failure.detail, requestId, failure.retryable);
}

function isTerminalPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'task.completed' ||
    type === 'task.failed' ||
    type === 'task.cancelled' ||
    type === 'task.interrupted'
  );
}

/** A terminal event closes the stream only for the generation that owns it. */
function closesStream(value: unknown, generation: number): boolean {
  if (!isTerminalPayload(value)) return false;
  const eventGeneration = (value as { generation?: unknown }).generation;
  return typeof eventGeneration === 'number' ? eventGeneration === generation : true;
}

function eventId(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { eventId?: unknown }).eventId;
    if (typeof id === 'string') return id;
  }
  return '';
}

/** The SSE cursor is the per-task sequence, so Last-Event-ID can resume it. */
function eventSeq(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const seq = (value as { seq?: unknown }).seq;
    if (typeof seq === 'number') return String(seq);
  }
  return undefined;
}

function frame(event: unknown): SseFrame {
  const id = eventSeq(event);
  return { ...(id ? { id } : {}), data: event };
}

/**
 * Replays retained events, then tails the live ones. The stream closes on a
 * terminal event so a client never waits for a task that already finished; a
 * disconnected client stops consuming without stopping the run.
 */
async function* toEventStream(stream: {
  replay: { events: unknown[] };
  subscribe: (listener: (event: unknown) => void) => () => void;
  generation: number;
}): AsyncIterable<SseFrame> {
  const seen = new Set<string>();
  for (const event of stream.replay.events) {
    seen.add(eventId(event));
    yield frame(event);
    if (closesStream(event, stream.generation)) return;
  }

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
        yield frame(next);
        if (closesStream(next, stream.generation)) return;
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

export function registerRoutes(registry: RouteRegistry, service: ApplicationService): void {
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

  registry.register('getHandshake', async () => ({
    kind: 'json',
    status: 200,
    body: service.handshake(),
  }));

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

/**
 * Chat frames follow the published `ChatStreamFrame` contract: the assistant
 * text, then the reply the JSON body would have carried. A failure happens
 * before the stream opens, so it is still a normal Problem response and no
 * client has to parse an error out of an event.
 */
async function* chatFrames(reply: { text: string }): AsyncIterable<SseFrame> {
  yield { data: { type: 'chat.delta', text: reply.text } };
  yield { data: { type: 'chat.completed', reply } };
}

  registry.register('submitChat', async (context) => {
    const result = await service.chat(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    if (context.accept.toLowerCase().includes('text/event-stream')) {
      return { kind: 'sse', status: 200, events: chatFrames(result.value) };
    }
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('submitWork', async (context) => {
    const result = await service.submitWork(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 202, body: result.value };
  });

  registry.register('getTask', async (context) => {
    const result = await service.task(context.principal, context.params.taskId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listTasks', async (context) => {
    const result = await service.listTasks(context.principal, context.query as never);
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
    // An explicit `after` wins; otherwise Last-Event-ID resumes the cursor the
    // client last received. A malformed header is ignored rather than trusted.
    const after = context.query.after;
    // SSE clients resume with `Last-Event-ID`; `after` is kept for plain HTTP
    // clients. The larger of the two wins so a stale query cannot rewind a
    // client that already received newer events.
    const fromQuery = typeof after === 'number' ? after : 0;
    const header = context.lastEventId ?? '';
    const headerCursor = /^\d+$/.test(header) ? Number(header) : 0;
    const cursor = Math.max(fromQuery, headerCursor);
    const result = await service.events(context.principal, context.params.taskId ?? '', cursor);
    if (!result.ok) return fromFailure(result, context.requestId);
    return {
      kind: 'sse',
      status: 200,
      events: toEventStream(result.value),
      headers: {
        'x-coderax-truncated': result.value.replay.truncated ? 'true' : 'false',
        'x-coderax-last-seq': String(result.value.lastSeq),
        'x-coderax-event-schema': '1',
      },
    };
  });

  registry.register('listConversations', async (context) => {
    const result = await service.conversations(context.principal, context.query as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('deleteConversation', async (context) => {
    const result = await service.deleteConversation(
      context.principal,
      context.params.conversationId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

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
    const limit = typeof context.query.limit === 'number' ? context.query.limit : undefined;
    const cursor = typeof context.query.cursor === 'string' ? context.query.cursor : undefined;
    return {
      kind: 'json',
      status: 200,
      body: await service.memory(context.principal, mode, {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor ? { cursor } : {}),
      }),
    };
  });

  registry.register('deleteMemory', async (context) => {
    const mode: DataMode = context.query.mode === 'cloud' ? 'cloud' : 'private';
    return {
      kind: 'json',
      status: 200,
      body: await service.deleteMemory(context.principal, context.params.key ?? '', mode),
    };
  });

  registry.register('putMemory', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.putMemory(context.principal, context.body as never),
  }));

  registry.register('listPendingPermissions', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.pendingPermissions(context.principal, context.query as never),
  }));

  registry.register('listPermissions', async (context) => {
    const result = await service.permissions(
      context.principal,
      context.params.taskId ?? '',
      context.query as never,
    );
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

  registry.register('getBudget', async (context) => ({
    kind: 'json',
    status: 200,
    body: service.budget(context.principal),
  }));

  registry.register('getMetrics', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.metrics(context.principal),
  }));

  registry.register('listReceipts', async (context) => {
    const result = await service.receipts(
      context.principal,
      context.params.taskId ?? '',
      context.query as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listNotifications', async (context) => {
    const result = await service.notifications(context.principal, context.query as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('markNotificationsRead', async (context) => {
    const body = context.body as { taskIds: string[] };
    return {
      kind: 'json',
      status: 200,
      body: await service.markNotificationsRead(context.principal, body.taskIds),
    };
  });

  registry.register('listSchedules', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.listSchedules(context.principal),
  }));

  registry.register('createSchedule', async (context) => {
    const result = await service.createSchedule(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('getSchedule', async (context) => {
    const result = await service.schedule(
      context.principal,
      context.params.scheduleId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('cancelSchedule', async (context) => {
    const result = await service.cancelSchedule(
      context.principal,
      context.params.scheduleId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listTaskArtifacts', async (context) => {
    const result = await service.listArtifacts(
      context.principal,
      context.params.taskId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('uploadTaskArtifact', async (context) => {
    const result = await service.uploadArtifact(
      context.principal,
      context.params.taskId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('getArtifact', async (context) => {
    const result = await service.artifact(context.principal, context.params.artifactId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('getArtifactContent', async (context) => {
    const result = await service.artifactContent(
      context.principal,
      context.params.artifactId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });
}
