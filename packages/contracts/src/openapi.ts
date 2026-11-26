import { Problem } from './errors.js';
import { toJsonSchema } from './json-schema.js';
import { CONTRACT_VERSION } from './primitives.js';
import { ROUTES, type RouteSpec } from './routes.js';

/**
 * The OpenAPI document is derived from the route catalogue and the zod schemas.
 * Regenerating it is deterministic: `npm run openapi:check` fails when the
 * committed `openapi.json` differs from what the code produces.
 */

type OpenApiOperation = {
  operationId: string;
  summary: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
};

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

const ERROR_RESPONSE = {
  description: 'Problem',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
};

function pathParameters(route: RouteSpec): Array<Record<string, unknown>> | undefined {
  const names = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (names.length === 0) return undefined;
  const properties =
    route.params && 'shape' in route.params
      ? (route.params as unknown as { shape: Record<string, unknown> }).shape
      : {};
  return names.map((name) => {
    const schema = properties[name];
    const json = schema ? toJsonSchema(schema as never) : { type: 'string' };
    return { name, in: 'path', required: true, schema: json };
  });
}

function queryParameters(route: RouteSpec): Array<Record<string, unknown>> | undefined {
  if (!route.query) return undefined;
  const json = toJsonSchema(route.query);
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema,
  }));
}

export function buildOpenApiDocument(routes: readonly RouteSpec[] = ROUTES): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const schemas: Record<string, unknown> = { Problem: toJsonSchema(Problem) };

  for (const route of routes) {
    const operation: OpenApiOperation = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      security: route.auth === 'owner' ? [{ bearerAuth: [] }] : [],
      responses: {
        [String(route.response.status)]: route.stream
          ? {
              description: route.response.description,
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            }
          : {
              description: route.response.description,
              content: {
                [route.response.contentType ?? 'application/json']: {
                  schema: toJsonSchema(route.response.schema),
                },
              },
            },
        '4XX': ERROR_RESPONSE,
        '5XX': ERROR_RESPONSE,
      },
    };

    const parameters = [
      ...(pathParameters(route) ?? []),
      ...(queryParameters(route) ?? []),
    ];
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(route.body) } },
      };
    }

    const key = route.path.replace(/\{([^}]+)\}/g, '{$1}');
    paths[key] = { ...(paths[key] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Coderax WorkflowEngine API',
      version: CONTRACT_VERSION,
      description:
        'Authoritative HTTP surface for Coderax Native intelligence, agent orchestration and durable Work execution. Every operation is generated from the versioned route catalogue.',
    },
    servers: [{ url: 'https://workflow.coderax.internal' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      },
      schemas,
    },
    paths,
  };
}
