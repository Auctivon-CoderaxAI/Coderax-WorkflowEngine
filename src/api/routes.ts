import type {
  ArtifactKind,
  ArtifactModeRequest,
  ArtifactUploadRequest,
  ArtifactVersionRequest,
  DataMode,
  DeliverableRequestInput,
} from '@coderax/contracts';
import type { ApplicationService, EventStream } from '../orchestration/service.js';
import type { RouteRegistry, SseFrame } from './router.js';
import { problemResult } from './router.js';
import type { ServiceFailure } from '../support/result.js';
import { buildHandshake, type HandshakeContext } from './handshake.js';

/**
 * Route handlers are wiring, not behavior.
 *
 * Each handler validates nothing (the router already validated against the
 * contract), decides nothing (the service owns the decision) and formats the
 * response it was given. There is no orchestration logic here, and no route
 * reaches a repository, an adapter or a provider directly.
 */

/** The router validates a query string but hands handlers the raw values. */
function queryNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function fromFailure(failure: ServiceFailure, requestId: string) {
  return problemResult(failure.code, failure.detail, requestId, failure.retryable);
}

/** The query schema already validated the enum; this only names the default. */
function modeFrom(value: unknown): DataMode {
  return value === 'cloud' ? 'cloud' : 'private';
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

/**
 * Replays the durable log from the cursor, then tails it. The first frame is an
 * SSE comment carrying the log's metadata: the SDK drops any line that is not
 * `data:`, so a deployed client keeps working while a newer one can read
 * `lastSeq` and `truncated` without a new frame type in the event contract. The
 * stream closes on a terminal event so a client never waits for a task that
 * already finished; a disconnected client stops consuming without stopping the
 * run.
 */
async function* toEventStream(stream: EventStream): AsyncIterable<SseFrame> {
  yield {
    kind: 'comment',
    comment: `coderax-meta ${JSON.stringify({
      lastSeq: stream.replay.lastSeq,
      truncated: stream.replay.truncated,
    })}`,
  };

  for (const event of stream.replay.events) {
    yield { kind: 'event', event };
    if (isTerminalPayload(event)) return;
  }

  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  const unsubscribe = stream.subscribe((event) => {
    pending.push(event);
    wake?.();
  });

  try {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield { kind: 'event', event: next };
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
export function registerRoutes(
  registry: RouteRegistry,
  service: ApplicationService,
  handshake: HandshakeContext,
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
async function* chatFrames<T extends { text: string }>(reply: T): AsyncIterable<SseFrame> {
  yield { kind: 'event', event: { type: 'chat.delta', text: reply.text } };
  yield { kind: 'event', event: { type: 'chat.completed', reply } };
}

  registry.register('intakeMedia', async (context) => {
    const result = await service.intakeMedia(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

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
    const after = context.query.after;
    const fromQuery = typeof after === 'number' ? after : 0;
    const fromHeader = Number(context.lastEventId ?? 0);
    const cursor = Number.isSafeInteger(fromHeader) && fromHeader >= 0
      ? Math.max(fromQuery, fromHeader)
      : fromQuery;
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

  registry.register('listArtifacts', async (context) => {
    const query = context.query as {
      mode?: DataMode;
      kind?: ArtifactKind;
      projectId?: string;
      conversationId?: string;
      taskId?: string;
      limit?: number;
    };
    const result = await service.artifacts.list(context.principal, query);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('artifactProjectManifest', async (context) => {
    const query = context.query as { mode?: DataMode; projectId: string };
    const result = await service.artifacts.manifest(context.principal, {
      mode: modeFrom(query.mode),
      projectId: query.projectId,
    });
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('uploadArtifact', async (context) => {
    const result = await service.artifacts.upload(
      context.principal,
      context.body as ArtifactUploadRequest,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('pruneArtifacts', async (context) => {
    const body = context.body as ArtifactModeRequest;
    const result = await service.artifacts.prune(context.principal, modeFrom(body.mode));
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('getArtifact', async (context) => {
    const result = await service.artifacts.get(
      context.principal,
      context.params.artifactId ?? '',
      modeFrom(context.query.mode),
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('uploadArtifactVersion', async (context) => {
    const result = await service.artifacts.addVersion(
      context.principal,
      context.params.artifactId ?? '',
      context.body as ArtifactVersionRequest,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('restoreArtifactVersion', async (context) => {
    const body = context.body as { mode?: DataMode; version: number; expectedVersion: number };
    const result = await service.artifacts.restore(
      context.principal,
      context.params.artifactId ?? '',
      {
        mode: modeFrom(body.mode),
        version: body.version,
        expectedVersion: body.expectedVersion,
      },
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listArtifactVersions', async (context) => {
    const result = await service.artifacts.versions(
      context.principal,
      context.params.artifactId ?? '',
      modeFrom(context.query.mode),
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('downloadArtifact', async (context) => {
    const query = context.query as { mode?: DataMode; version?: number };
    const result = await service.artifacts.download(
      context.principal,
      context.params.artifactId ?? '',
      query,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('exportArtifact', async (context) => {
    const query = context.query as { mode?: DataMode; version?: number };
    const result = await service.artifacts.exportBundle(
      context.principal,
      context.params.artifactId ?? '',
      query,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('deleteArtifact', async (context) => {
    const body = context.body as ArtifactModeRequest;
    const result = await service.artifacts.remove(
      context.principal,
      context.params.artifactId ?? '',
      modeFrom(body.mode),
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('generateDeliverable', async (context) => {
    const result = await service.deliver(
      context.principal,
      context.body as DeliverableRequestInput,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  // Registration order follows the catalogue order so the served OpenAPI
  // document is byte-identical to the published one.
  registry.register('browserCapabilities', async () => ({
    kind: 'json',
    status: 200,
    body: await service.browserCapabilities(),
  }));

  registry.register('listBrowserSessions', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.browserSessions(context.principal),
  }));

  registry.register('createBrowserSession', async (context) => {
    const result = await service.createBrowserSession(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('getBrowserSession', async (context) => {
    const result = await service.browserSession(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('browserAction', async (context) => {
    const result = await service.browserAction(
      context.principal,
      context.params.sessionId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('pauseBrowserSession', async (context) => {
    const result = await service.pauseBrowserSession(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('resumeBrowserSession', async (context) => {
    const result = await service.resumeBrowserSession(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('takeoverBrowserSession', async (context) => {
    const result = await service.takeoverBrowserSession(
      context.principal,
      context.params.sessionId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('closeBrowserSession', async (context) => {
    const result = await service.closeBrowserSession(
      context.principal,
      context.params.sessionId ?? '',
      (context.body ?? {}) as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('authorizeBrowserSession', async (context) => {
    const result = await service.authorizeBrowserSession(
      context.principal,
      context.params.sessionId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('decideBrowserAuthorization', async (context) => {
    const result = await service.decideBrowserAuthorization(
      context.principal,
      context.params.sessionId ?? '',
      context.body as never,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listBrowserReceipts', async (context) => {
    const result = await service.browserReceipts(
      context.principal,
      context.params.sessionId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('getBrowserArtifact', async (context) => {
    const result = await service.browserArtifact(
      context.principal,
      context.params.artifactId ?? '',
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listNotifications', async (context) => {
    const include = context.query.includeSchedules === 'true';
    const list = await service.notifications(context.principal, include);
    return { kind: 'json', status: 200, body: include ? list : { notifications: list.notifications, unread: list.unread } };
  });

  registry.register('markNotificationsRead', async (context) => {
    const include = context.query.includeSchedules === 'true';
    const list = await service.markNotificationsRead(context.principal, include);
    return { kind: 'json', status: 200, body: include ? list : { notifications: list.notifications, unread: list.unread } };
  });

  registry.register('createSchedule', async (context) => {
    const result = await service.createSchedule(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 201, body: result.value };
  });

  registry.register('listSchedules', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.schedules(context.principal),
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

  registry.register('dispatchScheduleEvent', async (context) => {
    const result = await service.scheduleEvent(context.principal, context.body as never);
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 202, body: result.value };
  });

  registry.register('getSchedule', async (context) => {
    const result = await service.schedule(context.principal, context.params.scheduleId ?? '');
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

  registry.register('updateSchedule', async (context) => {
    const result = await service.updateSchedule(
      context.principal,
      context.params.scheduleId ?? '',
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

  registry.register('getScheduleUpcoming', async (context) => {
    const limit = queryNumber(context.query.limit);
    const result = await service.scheduleUpcoming(
      context.principal,
      context.params.scheduleId ?? '',
      limit,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('listGameBuilds', async (context) => {
    const result = await service.listGameBuilds(context.principal, context.params.gameId ?? '');
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('pauseSchedule', async (context) => {
    const result = await service.pauseSchedule(context.principal, context.params.scheduleId ?? '');
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

  registry.register('resumeSchedule', async (context) => {
    const result = await service.resumeSchedule(context.principal, context.params.scheduleId ?? '');
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

  registry.register('cancelSchedule', async (context) => {
    const result = await service.cancelSchedule(context.principal, context.params.scheduleId ?? '');
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

  registry.register('triggerSchedule', async (context) => {
    const body = (context.body ?? {}) as { idempotencyKey?: string };
    const result = await service.triggerSchedule(
      context.principal,
      context.params.scheduleId ?? '',
      body,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 202, body: result.value };
  });

  registry.register('listScheduleExecutions', async (context) => {
    const limit = queryNumber(context.query.limit);
    const result = await service.scheduleExecutions(
      context.principal,
      context.params.scheduleId ?? '',
      limit,
    );
    if (!result.ok) return fromFailure(result, context.requestId);
    return { kind: 'json', status: 200, body: result.value };
  });

  registry.register('getHandshake', async (context) => {
    const requested = context.query.contract;
    const fingerprint = context.query.fingerprint;
    return {
      kind: 'json',
      status: 200,
      body: buildHandshake({
        context: handshake,
        ...(typeof requested === 'string' ? { requested } : {}),
        ...(typeof fingerprint === 'string' ? { fingerprint } : {}),
      }),
    };
  });
}
