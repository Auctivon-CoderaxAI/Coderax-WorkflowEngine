import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataMode } from '@coderax/contracts';
import { createBudgetLedger } from '../../src/models/budget.js';
import {
  createProviderPolicyRegistry,
  PROCESSING_OPERATIONS,
  ProviderPolicyError,
  type ProcessingOperation,
  type ProviderPolicy,
  type ProviderPolicyRegistry,
} from '../../src/models/policy.js';
import { createModelRouter, type ModelRouter } from '../../src/models/router.js';
import type {
  DiscoveredModel,
  GatewayRequest,
  ProviderAdapter,
  ProviderCompletion,
  ProviderCompletionRequest,
  ProviderSettings,
} from '../../src/models/types.js';
import { ModelRoutingError, ProviderError } from '../../src/models/types.js';

const SETTINGS: ProviderSettings = {
  requestsPerMinute: 100,
  tokensPerMinute: 1_000_000,
  maxConcurrency: 4,
  requestTimeoutMs: 1_000,
  discoveryIntervalMs: 60_000,
};

function freeModel(id: string, providerId = 'hosted'): DiscoveredModel {
  return {
    ref: { providerId, modelId: id },
    label: id,
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: false, toolCalling: true, reasoning: true, streaming: true },
    pricing: { prompt: '0', completion: '0', request: '0' },
  };
}

type CapturingAdapter = ProviderAdapter & {
  calls: number;
  requests: ProviderCompletionRequest[];
};

function adapter(input: {
  id?: string;
  modelId?: string;
  fails?: boolean;
}): CapturingAdapter {
  const id = input.id ?? 'hosted';
  const model = freeModel(input.modelId ?? 'free-model', id);
  const capturing: CapturingAdapter = {
    id,
    kind: 'openai',
    calls: 0,
    requests: [],
    discover: async () => [model],
    complete: async (request: ProviderCompletionRequest): Promise<ProviderCompletion> => {
      capturing.calls += 1;
      capturing.requests.push(request);
      if (input.fails) {
        throw new ProviderError('server', 'The provider failed.', { retryable: true });
      }
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return capturing;
}

function grant(
  operation: ProcessingOperation,
  mode: DataMode,
  location: ProviderPolicy['location'] = 'owner-region',
) {
  return { operation, mode, location };
}

function policyFor(
  providerId: string,
  overrides: Partial<ProviderPolicy> = {},
): ProviderPolicy {
  return {
    providerId,
    retention: 'transient',
    training: 'prohibited',
    location: 'owner-region',
    credentials: 'owner-managed',
    modes: ['cloud', 'private'],
    grants: [grant('chat', 'private'), grant('chat', 'cloud')],
    evidenceUrl: 'https://provider.example/terms',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

function cloudOnly(providerId: string): ProviderPolicy {
  return policyFor(providerId, {
    credentials: 'deployment-managed',
    grants: PROCESSING_OPERATIONS.map((operation) => grant(operation, 'cloud')),
  });
}

function router(input: {
  adapters: ProviderAdapter[];
  policies: ProviderPolicy[];
  policy?: ProviderPolicyRegistry;
}): ModelRouter {
  return createModelRouter({
    providers: input.adapters.map((entry) => ({ adapter: entry, settings: SETTINGS })),
    policy: input.policy ?? createProviderPolicyRegistry(input.policies),
    budget: createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 1_000_000 }),
    maxFallbacks: 2,
    maxCandidates: 4,
    failureThreshold: 10,
    cooldownMs: 30_000,
  });
}

function gateway(
  mode: DataMode,
  operation: ProcessingOperation,
  overrides: Partial<GatewayRequest> = {},
): GatewayRequest {
  return {
    ownerId: 'owner',
    model: { providerId: 'hosted', modelId: 'free-model' },
    mode,
    operation,
    routing: 'auto',
    allowFallback: false,
    system: 'system',
    prompt: 'PRIVATE-RETRIEVAL-CHUNK-4871',
    signal: new AbortController().signal,
    ...overrides,
  };
}

const at = new Date('2026-11-26T12:00:00.000Z');

/**
 * The independently reproduced finding: the previous resolve discarded the data
 * mode, so a private request could be sent to any verified-free hosted model. A
 * free price is not a privacy guarantee.
 */
test('private mode refuses a hosted free model without an approved private policy', async () => {
  const hosted = adapter({});
  const engine = router({ adapters: [hosted], policies: [cloudOnly('hosted')] });
  await engine.refresh();

  const resolved = engine.resolve(null, 'private', { operation: 'chat' });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'model_missing');
  assert.match(resolved.ok === false ? resolved.detail : '', /private/i);
  assert.match(resolved.ok === false ? resolved.detail : '', /fails closed/i);

  await assert.rejects(
    () => engine.complete(gateway('private', 'chat', { allowFallback: true })),
    (error: unknown) =>
      error instanceof ModelRoutingError &&
      error.code === 'model_missing' &&
      !error.message.includes('PRIVATE-RETRIEVAL-CHUNK-4871'),
  );

  // Nothing left the process: no completion, no captured request body.
  assert.equal(hosted.calls, 0);
  assert.equal(hosted.requests.length, 0);

  // The same provider is usable in cloud mode, which is the mode it was approved for.
  assert.equal(engine.resolve(null, 'cloud', { operation: 'chat' }).ok, true);
  assert.equal(engine.route().length, 1);
});

test('a pinned hosted model is refused in private mode even when it is free and healthy', async () => {
  const hosted = adapter({});
  const engine = router({ adapters: [hosted], policies: [cloudOnly('hosted')] });
  await engine.refresh();

  const resolved = engine.resolve(
    { providerId: 'hosted', modelId: 'free-model' },
    'private',
    { operation: 'chat' },
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'model_missing');
  await assert.rejects(() =>
    engine.complete(
      gateway('private', 'chat', {
        model: { providerId: 'hosted', modelId: 'free-model' },
      }),
    ),
  );
  assert.equal(hosted.calls, 0);
});

test('an explicit private grant permits exactly the approved operation', () => {
  const registry = createProviderPolicyRegistry([policyFor('hosted')]);

  for (const operation of PROCESSING_OPERATIONS) {
    const decision = registry.evaluate({
      providerId: 'hosted',
      operation,
      mode: 'private',
      at,
    });
    assert.equal(
      decision.allowed,
      operation === 'chat',
      `private ${operation} authorization must follow the exact grant`,
    );
    if (!decision.allowed && operation !== 'chat') {
      assert.equal(decision.dimension, 'authorization');
    }
  }

  for (const operation of PROCESSING_OPERATIONS) {
    const decision = registry.evaluate({ providerId: 'hosted', operation, mode: 'cloud', at });
    assert.equal(decision.allowed, operation === 'chat');
  }
});

test('each eligibility dimension is reported separately and cannot be inferred', () => {
  const registry = createProviderPolicyRegistry([
    policyFor('hosted'),
    policyFor('mode-limited', { modes: ['cloud'] }),
    policyFor('stored', { retention: 'stored' }),
    policyFor('training', { training: 'opt-out' }),
    policyFor('elsewhere', { location: 'eu' }),
    policyFor('global', { grants: [grant('chat', 'private', 'global')], location: 'global' }),
    policyFor('shared-key', { credentials: 'deployment-managed' }),
    policyFor('undeclared', { location: 'unknown' }),
  ]);

  const dimension = (providerId: string, operation: ProcessingOperation = 'chat') => {
    const decision = registry.evaluate({ providerId, operation, mode: 'private', at });
    return decision.allowed ? 'allowed' : decision.dimension;
  };

  assert.equal(dimension('missing'), 'authorization');
  assert.equal(dimension('mode-limited'), 'execution_mode');
  assert.equal(dimension('hosted', 'rag'), 'authorization');
  assert.equal(dimension('stored'), 'retention');
  assert.equal(dimension('training'), 'training');
  assert.equal(dimension('elsewhere'), 'location');
  assert.equal(dimension('global'), 'location');
  assert.equal(dimension('shared-key'), 'credential');
  assert.equal(dimension('undeclared'), 'location');
  assert.equal(dimension('hosted'), 'allowed');
});

test('an expired or invalid provider policy is not evidence', () => {
  const expired = createProviderPolicyRegistry([
    policyFor('hosted', { expiresAt: '2026-11-25T12:00:00.000Z' }),
  ]);
  const decision = expired.evaluate({
    providerId: 'hosted',
    operation: 'chat',
    mode: 'private',
    at,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.dimension, 'authorization');

  assert.throws(
    () => createProviderPolicyRegistry([policyFor('hosted'), policyFor('hosted')]),
    (error: unknown) => error instanceof ProviderPolicyError,
  );
  assert.throws(
    () =>
      createProviderPolicyRegistry([
        policyFor('hosted', { evidenceUrl: 'http://provider.example/terms' }),
      ]),
    (error: unknown) => error instanceof ProviderPolicyError,
  );
});

test('cloud execution also requires an owner authorization record', async () => {
  const hosted = adapter({});
  // Free cost is verified by the router, but no policy record exists.
  const engine = router({ adapters: [hosted], policies: [] });
  await engine.refresh();
  assert.equal(engine.resolve(null, 'cloud', { operation: 'chat' }).ok, false);
  assert.equal(engine.route().length, 0);
  assert.equal(engine.hasVerifiedFreeRoute(), false);
  await assert.rejects(() => engine.complete(gateway('cloud', 'chat')));
  assert.equal(hosted.calls, 0);
});

test('fallback cannot widen the policy to an unauthorized provider', async () => {
  const approved = adapter({ id: 'approved', modelId: 'approved', fails: true });
  const unapproved = adapter({ id: 'unapproved', modelId: 'unapproved' });
  const engine = router({
    adapters: [approved, unapproved],
    policies: [policyFor('approved'), cloudOnly('unapproved')],
  });
  await engine.refresh();

  await assert.rejects(
    () =>
      engine.complete(
        gateway('private', 'chat', {
          model: { providerId: 'approved', modelId: 'approved' },
          allowFallback: true,
        }),
      ),
    (error: unknown) => error instanceof ModelRoutingError && error.code === 'engine_unavailable',
  );

  assert.equal(approved.calls, 1);
  // The unapproved provider never received the private prompt.
  assert.equal(unapproved.calls, 0);
  assert.equal(unapproved.requests.length, 0);
});

test('fallback between two approved providers stays inside the private policy', async () => {
  const approved = adapter({ id: 'approved', modelId: 'approved', fails: true });
  const alsoApproved = adapter({ id: 'also-approved', modelId: 'also-approved' });
  const engine = router({
    adapters: [approved, alsoApproved],
    policies: [policyFor('approved'), policyFor('also-approved')],
  });
  await engine.refresh();

  const completed = await engine.complete(
    gateway('private', 'chat', {
      model: { providerId: 'approved', modelId: 'approved' },
      allowFallback: true,
    }),
  );
  assert.deepEqual(completed.model, { providerId: 'also-approved', modelId: 'also-approved' });
  assert.equal(alsoApproved.calls, 1);
});

test('a policy withdrawn between planning and dispatch stops the provider call', async () => {
  const hosted = adapter({});
  const base = createProviderPolicyRegistry([policyFor('hosted')]);
  let evaluations = 0;
  const flaky: ProviderPolicyRegistry = {
    ...base,
    evaluate: (input) => {
      evaluations += 1;
      // Planning consults policy once; the dispatch revalidation must be the
      // call that observes the withdrawal.
      if (evaluations > 1) {
        return {
          allowed: false,
          dimension: 'authorization',
          detail: 'The owner withdrew the private grant.',
        };
      }
      return base.evaluate(input);
    },
  };
  const engine = router({ adapters: [hosted], policies: [], policy: flaky });
  await engine.refresh();

  await assert.rejects(() => engine.complete(gateway('private', 'chat')));
  assert.equal(hosted.calls, 0);
  assert.equal(hosted.requests.length, 0);
});

test('multimodal, retrieval and tool-result operations need their own private grants', () => {
  const registry = createProviderPolicyRegistry([
    policyFor('hosted', {
      grants: [
        grant('chat', 'private'),
        grant('rag', 'private'),
        grant('multimodal', 'private'),
      ],
    }),
  ]);

  const allowed = (operation: ProcessingOperation) =>
    registry.evaluate({ providerId: 'hosted', operation, mode: 'private', at }).allowed;

  assert.equal(allowed('chat'), true);
  assert.equal(allowed('rag'), true);
  assert.equal(allowed('multimodal'), true);
  // Conversation history, memory, MCP tool results and external-agent content
  // are not covered by a chat or retrieval grant.
  assert.equal(allowed('memory'), false);
  assert.equal(allowed('mcp'), false);
  assert.equal(allowed('external_agent'), false);
  assert.equal(allowed('document'), false);
  assert.equal(allowed('multi_agent'), false);
  assert.equal(allowed('native_reasoning'), false);
  assert.equal(allowed('work'), false);
});

test('a private grant requires no stored retention, no training and a declared location', () => {
  const cases: Array<{ overrides: Partial<ProviderPolicy>; dimension: string }> = [
    { overrides: { retention: 'stored' }, dimension: 'retention' },
    { overrides: { training: 'opt-out' }, dimension: 'training' },
    { overrides: { training: 'permitted' }, dimension: 'training' },
    { overrides: { location: 'unknown' }, dimension: 'location' },
    { overrides: { credentials: 'none' }, dimension: 'credential' },
  ];
  for (const entry of cases) {
    const registry = createProviderPolicyRegistry([policyFor('hosted', entry.overrides)]);
    const decision = registry.evaluate({
      providerId: 'hosted',
      operation: 'chat',
      mode: 'private',
      at,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.dimension, entry.dimension);
  }
});

test('a private-approved provider actually completes without leaking to the error path', async () => {
  const hosted = adapter({});
  const engine = router({ adapters: [hosted], policies: [policyFor('hosted')] });
  await engine.refresh();
  const completed = await engine.complete(gateway('private', 'chat'));
  assert.equal(completed.text, 'ok');
  assert.equal(hosted.calls, 1);
  assert.equal(hosted.requests[0]?.prompt, 'PRIVATE-RETRIEVAL-CHUNK-4871');
});
