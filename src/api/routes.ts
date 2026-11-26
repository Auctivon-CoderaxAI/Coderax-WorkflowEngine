import type { DataMode } from '@coderax/contracts';
import type { ApplicationService } from '../orchestration/service.js';
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

function eventId(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { eventId?: unknown }).eventId;
    if (typeof id === 'string') return id;
  }
  return '';
}

/**
 * Replays retained events, then tails the live ones. The stream closes on a
 * terminal event so a client never waits for a task that already finished; a
 * disconnected client stops consuming without stopping the run.
 */
async function* toEventStream(stream: {
  replay: { events: unknown[] };
  subscribe: (listener: (event: unknown) => void) => () => void;
}): AsyncIterable<unknown> {
  const seen = new Set<string>();
  for (const event of stream.replay.events) {
    seen.add(eventId(event));
    yield event;
    if (isTerminalPayload(event)) return;
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

  registry.register('listTools', async () => ({
    kind: 'json',
    status: 200,
    body: service.tools(),
  }));

  registry.register('getRouting', async (context) => {
    const mode =
      context.query.mode === 'fast' || context.query.mode === 'complex'
        ? context.query.mode
        : 'auto';
    return { kind: 'json', status: 200, body: service.routing(mode) };
  });

  registry.register('ingestKnowledge', async (context) => {
    const result = await service.ingestKnowledge(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 202, body: result.value };
  });

  registry.register('listKnowledge', async (context) => {
    const mode: DataMode = context.query.mode === 'cloud' ? 'cloud' : 'private';
    return { kind: 'json', status: 200, body: await service.knowledge(context.principal, mode) };
  });

  registry.register('searchKnowledge', async (context) => {
    const query = context.query as { q: string; k?: number; mode?: string };
    const mode: DataMode = query.mode === 'cloud' ? 'cloud' : 'private';
    return {
      kind: 'json',
      status: 200,
      body: await service.searchKnowledge(
        context.principal,
        query.q,
        typeof query.k === 'number' ? query.k : 4,
        mode,
      ),
    };
  });

/**
 * Chat frames follow the published `ChatFrame` contract: the assistant text,
 * then the reply the JSON body would have carried. A failure happens before the
 * stream opens, so it is still a normal Problem response and no client has to
 * parse an error out of an event.
 */
async function* chatFrames<T extends { text: string }>(reply: T): AsyncIterable<unknown> {
  yield { type: 'chat.delta', text: reply.text };
  yield { type: 'chat.completed', reply };
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
    const queryCursor = typeof context.query.after === 'number' ? context.query.after : 0;
    // A reconnecting EventSource cannot set a query string; it sends the last
    // sequence it received. The larger cursor wins, so a stale header can never
    // rewind a client that already asked for a later position.
    const headerCursor = Number.parseInt(context.headers['last-event-id'] ?? '', 10);
    const cursor = Math.max(
      queryCursor,
      Number.isFinite(headerCursor) && headerCursor > 0 ? headerCursor : 0,
    );
    const result = await service.events(context.principal, context.params.taskId ?? '', cursor);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'sse', status: 200, events: toEventStream(result.value) };
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
}
