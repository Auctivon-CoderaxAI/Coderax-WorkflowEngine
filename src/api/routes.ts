import type {
  ArtifactKind,
  ArtifactModeRequest,
  ArtifactUploadRequest,
  ArtifactVersionRequest,
  DataMode,
} from '@coderax/contracts';
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

  // Registration order follows the catalogue order so the served OpenAPI
  // document is byte-identical to the published one.
  registry.register('listNotifications', async (context) => ({
    kind: 'json',
    status: 200,
    body: await service.notifications(context.principal),
  }));
}
