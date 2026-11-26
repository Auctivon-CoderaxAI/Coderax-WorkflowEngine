import { buildOpenApiDocument, ROUTES, type RouteSpec } from '@coderax/contracts';
import type { ApplicationService } from '../../src/orchestration/service.js';
import { registerRoutes } from '../../src/api/routes.js';
import { createRouteRegistry, createRouter } from '../../src/api/router.js';
import { createOwnerAuth } from '../../src/security/auth.js';
import { report, type Finding, type Report } from './files.js';

/**
 * Route-registration completeness gate.
 *
 * The composition root already refuses to start when a documented operation has
 * no handler. This gate proves the same thing without starting a server: it
 * executes the real registration function against the real catalogue, then walks
 * every catalogue path through the real dispatcher. A missing handler, a second
 * registration, a duplicate path or a handler behind the wrong method fails here.
 */

const GATE_TOKEN = 'gate-owner-token-0123456789';

function catalogueFindings(): Finding[] {
  const findings: Finding[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of ROUTES) {
    if (ids.has(route.operationId)) {
      findings.push({ rule: 'route-duplicate-id', detail: route.operationId });
    }
    ids.add(route.operationId);
    const key = `${route.method} ${route.path}`;
    if (paths.has(key)) {
      findings.push({ rule: 'route-duplicate-path', detail: key });
    }
    paths.add(key);
    if (!route.path.startsWith('/v1/')) {
      findings.push({
        rule: 'route-version',
        detail: `${route.operationId} is outside the versioned prefix: ${route.path}`,
      });
    }
    if (route.response.status < 200 || route.response.status > 299) {
      findings.push({
        rule: 'route-response',
        detail: `${route.operationId} declares a non-success status ${route.response.status}`,
      });
    }
  }
  const publicIds = ROUTES.filter((route) => route.auth === 'public')
    .map((route) => route.operationId)
    .sort();
  if (publicIds.join(',') !== 'getHealth,getReadiness') {
    findings.push({
      rule: 'route-public-surface',
      detail: `public operations must be exactly health and readiness, found ${publicIds.join(', ')}`,
    });
  }
  return findings;
}

/** Every handler is registered; calling one is never part of registration. */
function probeService(): ApplicationService {
  return new Proxy({} as ApplicationService, {
    get: () => () => {
      throw new Error('the registration probe must not invoke a service method');
    },
  });
}

function requestPath(spec: RouteSpec): string {
  return spec.path.replace(/\{([^}]+)\}/g, 'probe');
}

export async function checkRegistration(): Promise<Report> {
  const findings = catalogueFindings();
  const registry = createRouteRegistry();
  try {
    registerRoutes(registry, probeService());
  } catch (error) {
    return report([
      ...findings,
      {
        rule: 'route-registration',
        detail: `registration threw: ${(error as Error).message}`,
      },
    ]);
  }

  if (registry.list().length !== ROUTES.length) {
    findings.push({
      rule: 'route-count',
      detail: `registered ${registry.list().length} handlers for ${ROUTES.length} catalogue operations`,
    });
  }
  for (const operationId of registry.missing()) {
    findings.push({ rule: 'route-unregistered', detail: operationId });
  }
  if (JSON.stringify(registry.openapi()) !== JSON.stringify(buildOpenApiDocument())) {
    findings.push({
      rule: 'route-openapi',
      detail: 'the document served by the registered table differs from the published contracts',
    });
  }

  const auth = createOwnerAuth({
    config: { ownerId: 'gate', tokenEnv: 'GATE_OWNER_TOKEN', minTokenLength: 16 },
    env: { GATE_OWNER_TOKEN: GATE_TOKEN },
  });
  const router = createRouter({
    registry,
    auth,
    requestId: () => 'gate-request',
    now: () => 0,
  });

  for (const spec of ROUTES) {
    const path = requestPath(spec);
    const result = await router.handle({
      method: spec.method,
      path: spec.query ? `${path}?after=0` : path,
      authorization: spec.auth === 'owner' ? `Bearer ${GATE_TOKEN}` : undefined,
      bodyText: spec.body ? '{}' : '',
    });
    if (result.kind === 'json' && result.status === 404) {
      findings.push({
        rule: 'route-unmatched',
        detail: `${spec.method} ${spec.path} did not match its own catalogue entry`,
      });
    }
  }

  const control = await router.handle({
    method: 'GET',
    path: '/v1/this-operation-does-not-exist',
    authorization: `Bearer ${GATE_TOKEN}`,
    bodyText: '',
  });
  if (control.kind === 'json' && control.status !== 404) {
    findings.push({
      rule: 'route-control',
      detail: 'an unknown path did not produce a typed not-found',
    });
  }

  return report(findings);
}

export { GATE_TOKEN };
