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
  /** Raw `Accept` header, so a negotiated operation can pick SSE or JSON. */
  accept: string | undefined;
};

export type HandlerResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'sse'; status: number; events: AsyncIterable<unknown> };

export type RouteHandler = (context: RequestContext) => Promise<HandlerResult>;

export type RegisteredRoute = { spec: RouteSpec; handler: RouteHandler };

export type RawRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  bodyText: string;
};

export type RouterResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'sse'; status: number; events: AsyncIterable<unknown> };

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
        [...handlers.keys()].map((operationId) => ROUTE_INDEX.get(operationId) as RouteSpec),
      ),
  };
}

function problem(
  code: ProblemCode,
  detail: string,
  requestId: string,
  retryable = false,
): { kind: 'json'; status: number; body: unknown } {
  // One mapping, in the contracts, so a client never has to guess a status for a
  // code and the router cannot drift from the published table.
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

function decodeParams(groups: Record<string, string>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    try {
      decoded[key] = decodeURIComponent(value);
    } catch {
      decoded[key] = value;
    }
  }
  return decoded;
}

/** Exported so a route can answer with the problem body without restating statuses. */
export const problemResult = problem;

export type Router = {
  handle: (request: RawRequest) => Promise<RouterResult>;
  registry: RouteRegistry;
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
    handle: async (raw) => {
      const requestId = input.requestId();
      const [pathname, search = ''] = raw.path.split('?');
      const query = Object.fromEntries(new URLSearchParams(search).entries());
      const method = raw.method.toUpperCase();

      for (const route of routes) {
        if (route.spec.method !== method) continue;
        const match = route.matcher.exec(pathname ?? '');
        if (!match) continue;

        const principal = input.auth.authenticate(raw.authorization);
        if (route.spec.auth === 'owner' && !principal) {
          return problem('unauthorized', 'A valid owner token is required.', requestId);
        }

        const params = decodeParams((match.groups ?? {}) as Record<string, string>);
        let parsedParams: Record<string, string> = params;
        if (route.spec.params) {
          const parsed = route.spec.params.safeParse(params);
          if (!parsed.success) {
            return problem('validation_failed', 'A path parameter is invalid.', requestId);
          }
          parsedParams = parsed.data as Record<string, string>;
        }

        let parsedQuery: Record<string, unknown> = query;
        if (route.spec.query) {
          // The parsed value is what the handler receives: handing it the raw
          // string map would silently defeat every coercion in the schema, which
          // is exactly how an event cursor collapsed to zero.
          const parsed = route.spec.query.safeParse(query);
          if (!parsed.success) {
            return problem('validation_failed', 'A query parameter is invalid.', requestId);
          }
          parsedQuery = parsed.data as Record<string, unknown>;
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
            params: parsedParams,
            query: parsedQuery,
            body,
            requestId,
            accept: raw.accept,
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
        return { kind: 'sse', status: result.status, events: result.events };
      }

      return problem('not_found', 'No operation matches that method and path.', requestId);
    },
  };
}
