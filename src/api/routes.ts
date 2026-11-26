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

  registry.register('submitChat', async (context) => {
    const result = await service.chat(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
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
    const after = context.query.after;
    const cursor = typeof after === 'number' ? after : 0;
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

  registry.register('getGameCapabilities', async (context) => ({
    kind: 'json',
    status: 200,
    body: service.gameCapabilities(context.principal),
  }));

  registry.register('listGames', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.listGames(context.principal, {
      ...(typeof context.query.cursor === 'string' ? { cursor: context.query.cursor } : {}),
      ...(typeof context.query.limit === 'number' ? { limit: context.query.limit } : {}),
    }),
  }));

  registry.register('createGame', async (context) => {
    const result = await service.createGame(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('getGame', async (context) => {
    const result = await service.getGame(context.principal, context.params.gameId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('saveGameSpec', async (context) => {
    const result = await service.saveGameSpec(
      context.principal,
      context.params.gameId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('buildGame', async (context) => {
    const result = await service.buildGame(
      context.principal,
      context.params.gameId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listGameBuilds', async (context) => {
    const result = await service.listGameBuilds(context.principal, context.params.gameId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('restoreGameBuild', async (context) => {
    const result = await service.restoreGameBuild(
      context.principal,
      context.params.gameId ?? '',
      context.params.buildId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('iterateGame', async (context) => {
    const result = await service.iterateGame(
      context.principal,
      context.params.gameId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('previewGame', async (context) => {
    const result = await service.gamePreview(context.principal, context.params.gameId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return {
      kind: 'text',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: result.value,
    };
  });

  registry.register('exportGame', async (context) => {
    const result = await service.exportGame(context.principal, context.params.gameId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('createGameSession', async (context) => {
    const result = await service.createGameSession(
      context.principal,
      context.params.gameId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('listGameSessions', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.listGameSessions(context.principal),
  }));

  registry.register('getGameSession', async (context) => {
    const result = await service.getGameSession(context.principal, context.params.sessionId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('observeGameSession', async (context) => {
    const result = await service.observeGameSession(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('controlGameSession', async (context) => {
    const result = await service.controlGameSession(
      context.principal,
      context.params.sessionId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('gameSessionLogs', async (context) => {
    const result = await service.gameSessionLogs(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('gameSessionVerification', async (context) => {
    const result = await service.gameSessionVerification(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });
}
