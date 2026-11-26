import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { ROUTES } from '@coderax/contracts';
import { listFiles, readText, report, toRepoPath, type Finding, type Report } from './files.js';

/**
 * SDK compatibility gate.
 *
 * Both clients consume `@coderax/sdk`, so a client method that calls a path the
 * server does not serve is a production outage discovered at build time. Every
 * catalogue operation is invoked against a recording transport and its method and
 * path are compared with the contract. The SDK source is also checked for a
 * second, hand-written contract: it may import schemas from `@coderax/contracts`
 * and must not declare its own.
 */

const GATE_TOKEN = 'gate-sdk-token-0123456789';

type RecordedCall = { method: string; url: URL; authorization: string | null };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type SdkCall = {
  operationId: string;
  invoke: (client: CoderaxClient) => Promise<unknown>;
  query?: Readonly<Record<string, string>>;
};

const CALLS: readonly SdkCall[] = [
  { operationId: 'getHealth', invoke: (client) => client.health() },
  { operationId: 'getReadiness', invoke: (client) => client.readiness() },
  { operationId: 'listAgents', invoke: (client) => client.agents() },
  { operationId: 'listModels', invoke: (client) => client.models() },
  {
    operationId: 'submitChat',
    invoke: (client) => client.chat({ message: 'gate', agent: 'coderax', mode: 'cloud' }),
  },
  {
    operationId: 'submitWork',
    invoke: (client) =>
      client.submitWork({ objective: 'gate', mode: 'cloud', requireApproval: true }),
  },
  { operationId: 'getTask', invoke: (client) => client.task('probe') },
  { operationId: 'cancelTask', invoke: (client) => client.cancel('probe') },
  { operationId: 'resumeTask', invoke: (client) => client.resume('probe', 1) },
  { operationId: 'retryTask', invoke: (client) => client.retry('probe', 1) },
  {
    operationId: 'streamTaskEvents',
    invoke: async (client) => {
      for await (const event of client.events('probe')) return event;
    },
  },
  { operationId: 'listConversations', invoke: (client) => client.conversations() },
  { operationId: 'getConversation', invoke: (client) => client.conversation('probe') },
  { operationId: 'listMemory', invoke: (client) => client.memory('private'), query: { mode: 'private' } },
  { operationId: 'listPermissions', invoke: (client) => client.permissions('probe') },
  {
    operationId: 'decidePermission',
    invoke: (client) =>
      client.decidePermission('probe', { requestId: 'request', decision: 'approved' }),
  },
  { operationId: 'listNotifications', invoke: (client) => client.notifications() },
];

function recordedFetch(calls: RecordedCall[]): FetchLike {
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({
      method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      url,
      authorization: headers.get('authorization'),
    });
    const problem = {
      type: 'https://coderax.dev/problems/engine_unavailable',
      title: 'engine unavailable',
      status: 503,
      code: 'engine_unavailable',
      detail: 'the SDK compatibility probe stops at the transport boundary',
      requestId: 'gate-sdk',
      retryable: true,
    };
    return new Response(JSON.stringify(problem), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function expectedPath(specPath: string): string {
  return specPath.replace(/\{([^}]+)\}/g, 'probe');
}

function sdkSourceFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const file of listFiles('packages/sdk/src')) {
    const path = toRepoPath(file);
    const text = readText(file);
    for (const match of text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? '';
      if (specifier === '@coderax/contracts' || specifier === 'zod') continue;
      findings.push({
        rule: 'sdk-boundary',
        detail: `${path} imports ${specifier}; the SDK may depend only on @coderax/contracts`,
      });
    }
    if (/\bz\s*\.\s*(?:object|string|number|enum|array|union|literal)\s*\(/.test(text)) {
      findings.push({
        rule: 'sdk-second-contract',
        detail: `${path} declares its own zod schema instead of importing the contract`,
      });
    }
  }
  return findings;
}

export async function checkSdk(): Promise<Report> {
  const findings: Finding[] = [...sdkSourceFindings()];
  const byId = new Map(ROUTES.map((route) => [route.operationId, route]));
  const covered = new Set<string>();

  for (const call of CALLS) {
    const spec = byId.get(call.operationId);
    if (!spec) {
      findings.push({
        rule: 'sdk-unknown-operation',
        detail: `${call.operationId} is not in the contracts catalogue`,
      });
      continue;
    }
    if (covered.has(call.operationId)) {
      findings.push({ rule: 'sdk-duplicate-coverage', detail: call.operationId });
    }
    covered.add(call.operationId);

    const calls: RecordedCall[] = [];
    const client = new CoderaxClient({
      baseUrl: 'https://engine.invalid',
      token: GATE_TOKEN,
      fetchImpl: recordedFetch(calls) as unknown as typeof fetch,
    });
    try {
      await call.invoke(client);
      findings.push({
        rule: 'sdk-transport',
        detail: `${call.operationId} did not reject an unavailable engine`,
      });
    } catch (error) {
      if (!(error instanceof CoderaxApiError)) {
        findings.push({
          rule: 'sdk-error-surface',
          detail: `${call.operationId} threw ${(error as Error).name} instead of CoderaxApiError`,
        });
      }
    }

    const request = calls.at(-1);
    if (!request) {
      findings.push({ rule: 'sdk-no-request', detail: `${call.operationId} sent no request` });
      continue;
    }
    if (request.method !== spec.method) {
      findings.push({
        rule: 'sdk-method',
        detail: `${call.operationId} sent ${request.method}, contract says ${spec.method}`,
      });
    }
    if (request.url.pathname !== expectedPath(spec.path)) {
      findings.push({
        rule: 'sdk-path',
        detail: `${call.operationId} sent ${request.url.pathname}, contract says ${expectedPath(spec.path)}`,
      });
    }
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (request.url.searchParams.get(key) !== value) {
        findings.push({
          rule: 'sdk-query',
          detail: `${call.operationId} did not send ${key}=${value}`,
        });
      }
    }
    if (request.authorization !== `Bearer ${GATE_TOKEN}`) {
      findings.push({
        rule: 'sdk-auth',
        detail: `${call.operationId} did not send the owner bearer token`,
      });
    }
    if (request.url.href.includes(GATE_TOKEN)) {
      findings.push({
        rule: 'sdk-token-in-url',
        detail: `${call.operationId} placed the token in the URL`,
      });
    }
  }

  for (const route of ROUTES) {
    if (!covered.has(route.operationId)) {
      findings.push({
        rule: 'sdk-uncovered-operation',
        detail: `${route.operationId} has no SDK compatibility probe`,
      });
    }
  }

  return report(findings);
}
