import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Architecture guard for the one inference boundary.
 *
 * Behavior tests prove that today's callers pass through the router. They cannot
 * stop a future subsystem from importing a provider adapter, calling a vendor SDK
 * or constructing a second router, which is how a paid or privacy-incompatible
 * path would appear silently. These assertions read the source tree instead:
 * only provider adapters may perform network I/O, only the composition root may
 * construct an adapter, the router or the policy registry, and provider
 * endpoints stay inside the adapter and composition modules.
 *
 * A legitimate new provider adds an adapter under `src/models/providers` and a
 * registration in `src/bootstrap/compose.ts`; it does not need to weaken this
 * test. A new inference surface receives a `ModelGateway` from the composition
 * root and names its exact processing operation.
 */

const sourceRoot = fileURLToPath(new URL('../../../src', import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = walk(sourceRoot);

/** The path below `src`, always with `/`, so assertions are host-independent. */
function pathOf(file: string): string {
  return relative(sourceRoot, file).split(sep).join('/');
}

/** Source without comments, so prose about an endpoint is not a provider call. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function offenders(pattern: RegExp, allowed: (path: string) => boolean): string[] {
  return files.filter((file) => !allowed(pathOf(file)) && pattern.test(codeOf(file))).map(pathOf);
}

const isAdapter = (path: string): boolean => path.startsWith('models/providers/');
/** The single inference gateway main composes; providers are reached through it. */
const isGateway = (path: string): boolean => path === 'agents/native/gateway.ts';

/**
 * Egress that is not inference. The external-agent transport and the MCP client
 * each reach an endpoint the owner configured separately, under their own scope
 * and origin checks; neither can select or call an inference model, so neither
 * can bypass the router, its policy or its budget. They are named here rather
 * than pattern-matched, so a new egress path still fails this guard until
 * someone justifies it.
 *
 * Embeddings are deliberately absent. Retrieval used to hold its own client and
 * was allowed here on the reasoning that it "cannot select a model"; it could
 * still transmit document text with no cost verdict, no operation grant and no
 * reservation. It now reaches a provider only through the router.
 */
const nonInferenceTransport = new Set([
  'agents/adapters/opencode.ts',
  'mcp/client.ts',
  // Owner-scoped egress seams: an allowed tool, a browser fetch, a media
  // provider, an artifact download and the guarded network primitive. None of
  // them selects an inference model, so none bypasses router policy or budget.
  'security/network.ts',
]);
const nonInferencePrefixes = ['tools/', 'browser/', 'media/', 'artifacts/'];

const mayEgress = (path: string): boolean =>
  isAdapter(path) ||
  isGateway(path) ||
  nonInferenceTransport.has(path) ||
  nonInferencePrefixes.some((prefix) => path.startsWith(prefix));

/**
 * The one guarded outbound transport: scheme validation, DNS resolution, a
 * refusal of every non-public address and a pinned connection. It is a security
 * primitive shared by the non-inference transports above, not an inference
 * client, and it never selects a model.
 */
const guardedTransport = 'security/network.ts';
const mayOpenSocket = (path: string): boolean =>
  isAdapter(path) ||
  isGateway(path) ||
  path === guardedTransport ||
  path === 'agents/adapters/opencode.ts';

test('only a provider adapter performs network I/O', () => {
  // The adapter receives `fetchImpl` from the composition root; it is the only
  // module allowed to invoke it. Nothing else reaches a provider directly.
  // `node:http` is excluded because the API server uses it for ingress, not egress.
  const egress = /\bfetchImpl\s*\(|\bfetch\s*\(/;
  assert.deepEqual(
    offenders(egress, mayEgress),
    [],
    'network I/O outside src/models/providers bypasses the router, its policy and its budget',
  );

  const outboundTransport = /from\s+['"](?:node:https|node:net|node:tls|node:dns|undici|axios|node-fetch)['"]/;
  assert.deepEqual(offenders(outboundTransport, mayOpenSocket), []);
});

test('no vendor inference SDK is imported anywhere', () => {
  // An SDK would open its own transport, its own retry policy and its own
  // endpoint, outside the redirect, timeout, quota and privacy boundaries.
  const vendorSdk =
    /from\s+['"](?:openai|@google\/genai|@google\/generative-ai|@anthropic-ai\/sdk|cohere-ai|mistralai|groq-sdk|@mistralai\/mistralai)['"]/;
  assert.deepEqual(offenders(vendorSdk, () => false), []);
});

test('provider adapters are constructed only at the composition root', () => {
  const factory = /from\s+['"][^'"]*\/models\/providers\/(?:openai|gemini)\.js['"]/;
  assert.deepEqual(
    offenders(factory, (path) => path === 'bootstrap/compose.ts'),
    [],
    'an adapter constructed elsewhere is a second routing path',
  );
});

test('the router and the policy registry are constructed only at the composition root', () => {
  const router = /\bcreateModelRouter\s*\(/;
  assert.deepEqual(
    offenders(router, (path) => path === 'models/router.ts' || path === 'bootstrap/compose.ts'),
    [],
  );

  const registry = /\bcreateProviderPolicyRegistry\s*\(/;
  assert.deepEqual(
    offenders(registry, (path) => path === 'models/policy.ts' || path === 'bootstrap/compose.ts'),
    [],
    'a second policy registry would let two authorities disagree',
  );
});

test('provider endpoints are declared only by the adapters and their registrations', () => {
  const endpoint = /https:\/\/(?:openrouter\.ai|generativelanguage\.googleapis\.com)/;
  assert.deepEqual(
    offenders(endpoint, (path) => isAdapter(path) || path === 'bootstrap/compose.ts'),
    [],
    'an endpoint literal elsewhere is an unregistered egress',
  );
});

test('embeddings reach a provider only through the router', () => {
  // Only an adapter may name the embeddings route. A second client is how
  // document text escaped cost verification, the operation grant and the ledger.
  const embeddingsEndpoint = /\/embeddings\b/;
  assert.deepEqual(
    offenders(embeddingsEndpoint, isAdapter),
    [],
    'an embeddings client outside src/models/providers bypasses cost, policy and budget',
  );

  const store = codeOf(join(sourceRoot, 'knowledge', 'store.ts'));
  assert.doesNotMatch(store, /\bapiKey\b|\bbaseURL\b|\bauthorization\b/);
});

test('paid routing cannot be switched on in source', () => {
  const paid = /\ballowPaid\s*:\s*true/;
  assert.deepEqual(offenders(paid, () => false), []);
});
