import type { RouteSpec } from '@coderax/contracts';
import { HTTP_STATUS_FOR_CODE, ROUTE_INDEX } from '@coderax/contracts';
import { buildOpenApiDocument, type OpenApiDocument } from '@coderax/contracts';
import type { ProblemCode } from '@coderax/contracts';
import type { AuthService, Principal } from '../security/auth.js';

export type RequestContext = {
  principal: Principal;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  requestId: string;
  signal?: AbortSignal;
  /** The raw Accept header, so a negotiated stream can answer JSON too. */
  accept: string;
  lastEventId?: string | undefined;
};

/**
 * One server-sent frame. A `comment` is written as a `:` line, which is valid
 * SSE that every client must ignore; carrying metadata that way lets the stream
 * report its own log bounds without changing the event contract.
 */
export type SseFrame =
  | { kind: 'event'; event: unknown }
  | { kind: 'comment'; comment: string };

export type HandlerResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; contentType: string; body: string }
  | { kind: 'sse'; status: number; events: AsyncIterable<SseFrame> };

export type RouteHandler = (context: RequestContext) => Promise<HandlerResult>;

export type RegisteredRoute = { spec: RouteSpec; handler: RouteHandler };

export type RawRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  bodyText: string;
  signal?: AbortSignal;
  accept?: string;
  lastEventId?: string | undefined;
};

export type RouterResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; contentType: string; body: string }
  | { kind: 'sse'; status: number; events: AsyncIterable<SseFrame> };

export type RouteRegistry = {
  register: (operationId: string, handler: RouteHandler) => void;
  list: () => RegisteredRoute[];
  /** Operation ids in the catalogue that have no handler. */
  missing: () => string[];
  openapi: () => OpenApiDocument;
};

export class RouterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterConfigurationError';
  }
}

/**
 * Centralized route registration.
 *
 * A handler can only be registered for an operation that exists in the contracts
 * catalogue, and an operation may be registered once. Duplicate or unknown
 * registrations fail at startup, which is how the engine avoids two owners for
 * one path. The OpenAPI document is generated from the same table.
 */
export function createRouteRegistry(): RouteRegistry {
  const handlers = new Map<string, RouteHandler>();

  return {
    register: (operationId, handler) => {
      const spec = ROUTE_INDEX.get(operationId);
      if (!spec) {
        throw new RouterConfigurationError(
          `operation ${operationId} is not part of the contracts catalogue`,
        );
      }
      if (handlers.has(operationId)) {
        throw new RouterConfigurationError(`operation ${operationId} is registered twice`);
      }
      handlers.set(operationId, handler);
    },
    list: () =>
      [...handlers.entries()].map(([operationId, handler]) => ({
        spec: ROUTE_INDEX.get(operationId) as RouteSpec,
        handler,
      })),
    missing: () => [...ROUTE_INDEX.keys()].filter((operationId) => !handlers.has(operationId)),
    openapi: () =>
      buildOpenApiDocument(
        [...ROUTE_INDEX.keys()]
          .filter((operationId) => handlers.has(operationId))
          .map((operationId) => ROUTE_INDEX.get(operationId) as RouteSpec),
      ),
  };
}

function problem(
  code: ProblemCode,
  detail: string,
  requestId: string,
  retryable = false,
): { kind: 'json'; status: number; body: unknown } {
  // One table decides the status for both the router and any handler, so a new
  // failure code cannot mean two different HTTP statuses in two places.
  const status = HTTP_STATUS_FOR_CODE[code];
  return {
    kind: 'json',
    status,
    body: {
      type: `https://coderax.dev/problems/${code}`,
      title: code.replace(/_/g, ' '),
      status,
      code,
      detail,
      requestId,
      retryable,
    },
  };
}

/**
 * Request bodies are bounded before schema validation.
 *
 * A JSON array is the one input shape that can cost an unbounded amount of work
 * per byte: a validator that reports an issue per element allocates for every
 * element, and this engine's schemas are not the only thing that could do it.
 * The transport already caps the body at 1 MiB; this caps the amplification, so a
 * body of half a million array entries is refused instead of parsed element by
 * element. Legitimate request arrays (at most 100 task ids) are far below it.
 */
const MAX_JSON_ARRAY = 256;
const MAX_JSON_DEPTH = 8;

function oversizedJson(value: unknown, path: string, depth = 0): string | null {
  if (depth > MAX_JSON_DEPTH) return path === '' ? 'body' : path;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) return path === '' ? 'body' : path;
    for (let index = 0; index < value.length; index += 1) {
      const found = oversizedJson(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const found = oversizedJson(entry, path === '' ? key : `${path}.${key}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function compilePath(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((segment) => {
      const match = /^\{([^}]+)\}$/.exec(segment);
      return match ? `(?<${match[1]}>[^/]+)` : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${escaped}$`);
}

/** Exported so a route can answer with the problem body without restating statuses. */
export const problemResult = problem;

export type Router = {
  handle: (request: RawRequest) => Promise<RouterResult>;
  registry: RouteRegistry;
  /**
   * The body ceiling for the operation that matches this method and path, or
   * `undefined` for the transport default. The server reads the body before a
   * handler runs, so only the route that carries file content may raise it.
   */
  bodyLimit: (method: string, path: string, authorization?: string) => number | undefined;
};

export function createRouter(input: {
  registry: RouteRegistry;
  auth: AuthService;
  requestId: () => string;
  now: () => number;
}): Router {
  const routes = input.registry.list().map((route) => ({
    ...route,
    matcher: compilePath(route.spec.path),
  }));

  return {
    registry: input.registry,
    bodyLimit: (method, path, authorization) => {
      const [pathname = ''] = path.split('?');
      const upper = method.toUpperCase();
      for (const route of routes) {
        if (route.spec.method !== upper) continue;
        if (!route.matcher.test(pathname)) continue;
        return input.auth.authenticate(authorization) ? route.spec.maxBodyBytes : undefined;
      }
      return undefined;
    },
    handle: async (raw) => {
      const requestId = input.requestId();
      const [pathname, search = ''] = raw.path.split('?');
      const rawQuery = Object.fromEntries(new URLSearchParams(search).entries());
      const method = raw.method.toUpperCase();

      for (const route of routes) {
        if (route.spec.method !== method) continue;
        const match = route.matcher.exec(pathname ?? '');
        if (!match) continue;

        const principal = input.auth.authenticate(raw.authorization);
        if (route.spec.auth === 'owner' && !principal) {
          return problem('unauthorized', 'A valid owner token is required.', requestId);
        }

        let params = (match.groups ?? {}) as Record<string, string>;
        if (route.spec.params) {
          const parsed = route.spec.params.safeParse(params);
          if (!parsed.success) {
            return problem('validation_failed', 'A path parameter is invalid.', requestId);
          }
          params = parsed.data as Record<string, string>;
        }
        // Handlers receive the coerced data, not the raw query string: a numeric
        // `after` or `limit` must be a number before any service sees it.
        let query: Record<string, unknown> = rawQuery;
        if (route.spec.query) {
          const parsed = route.spec.query.safeParse(rawQuery);
          if (!parsed.success) {
            return problem('validation_failed', 'A query parameter is invalid.', requestId);
          }
          query = parsed.data as Record<string, unknown>;
        }

        let body: unknown = undefined;
        if (route.spec.body) {
          if (raw.bodyText.trim() === '') {
            return problem('validation_failed', 'A request body is required.', requestId);
          }
          let json: unknown;
          try {
            json = JSON.parse(raw.bodyText);
          } catch {
            return problem('validation_failed', 'The request body is not valid JSON.', requestId);
          }
          const oversized = oversizedJson(json, '');
          if (oversized !== null) {
            return problem(
              'validation_failed',
              `${oversized}: the body contains too many entries or nests too deeply.`,
              requestId,
            );
          }
          const parsed = route.spec.body.safeParse(json);
          if (!parsed.success) {
            const first = parsed.error.issues[0];
            const where = first && first.path.length > 0 ? first.path.join('.') : 'body';
            return problem(
              'validation_failed',
              `${where}: ${first?.message ?? 'invalid request body'}`,
              requestId,
            );
          }
          body = parsed.data;
        }

        let result: HandlerResult;
        try {
          result = await route.handler({
            principal: principal ?? { ownerId: input.auth.ownerId, isOwner: true },
            params,
            query,
            body,
            requestId,
            signal: raw.signal,
            accept: raw.accept ?? '',
            lastEventId: raw.lastEventId,
          });
        } catch {
          return problem('internal_error', 'The request could not be completed.', requestId);
        }

        if (result.kind === 'json') {
          // Non-success bodies are the shared Problem contract; success bodies are
          // validated against the same schema the client uses, so a handler that
          // violates its own contract fails loudly instead of teaching a client a
          // shape the catalogue does not describe.
          if (result.status >= 400) {
            return { kind: 'json', status: result.status, body: result.body };
          }
          const parsed = route.spec.response.schema.safeParse(result.body);
          if (!parsed.success) {
            return problem('internal_error', 'The response did not match its contract.', requestId);
          }
          return { kind: 'json', status: result.status, body: parsed.data };
        }
        if (result.kind === 'text') {
          return result;
        }
        return { kind: 'sse', status: result.status, events: result.events };
      }

      return problem('not_found', 'No operation matches that method and path.', requestId);
    },
  };
}
