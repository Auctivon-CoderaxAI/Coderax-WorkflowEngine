import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeStore } from '../../src/knowledge/store.js';
import { createRouterEmbeddings } from '../../src/models/embedding.js';
import { createProviderPolicyRegistry, type ProcessingOperation } from '../../src/models/policy.js';
import { createModelRouter, type ModelRouter } from '../../src/models/router.js';
import {
  ModelRoutingError,
  ProviderError,
  type DiscoveredModel,
  type EmbeddingRequest,
  type ProviderAdapter,
  type ProviderSettings,
} from '../../src/models/types.js';
import { estimateTokens } from '../../src/models/verify.js';
import { createIdGenerator } from '../../src/support/clock.js';
import { testBudget } from '../helpers.js';

/**
 * The embeddings path is a data-transfer path. These tests exist because a
 * boolean config label and an API key once stood in for a cost verdict, an
 * operation grant and a budget reservation, so document text could leave the
 * process with none of the three. Each refusal asserts zero provider calls: a
 * request that is rejected after dispatch is not a refusal.
 */

const NOW = new Date('2026-11-27T00:00:00.000Z');

const SETTINGS: ProviderSettings = {
  requestsPerMinute: 100,
  tokensPerMinute: 1_000_000,
  maxConcurrency: 4,
  requestTimeoutMs: 1_000,
  discoveryIntervalMs: 60_000,
};

type Pricing = Record<string, unknown> | null;

function model(id: string, pricing: Pricing = { prompt: '0', completion: '0', request: '0' }): DiscoveredModel {
  return {
    ref: { providerId: 'p', modelId: id },
    label: id,
    contextTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { vision: false, toolCalling: false, reasoning: false, streaming: false },
    pricing,
  };
}

type Fixture = {
  router: ModelRouter;
  calls: () => number;
  batches: string[][];
  ledger: ReturnType<typeof testBudget>;
};

async function fixture(
  input: {
    grants?: ProcessingOperation[];
    models?: DiscoveredModel[];
    embed?: (texts: string[]) => Promise<number[][]>;
  } = {},
): Promise<Fixture> {
  const batches: string[][] = [];
  let calls = 0;
  const adapter: ProviderAdapter = {
    id: 'p',
    kind: 'openai',
    discover: async () => input.models ?? [model('embed-small')],
    complete: async () => {
      throw new ProviderError('invalid', 'completion is not used in this fixture.', {
        retryable: false,
      });
    },
    embed: async (request) => {
      calls += 1;
      batches.push([...request.texts]);
      if (input.embed) return input.embed(request.texts);
      return request.texts.map(() => [1, 0, 0]);
    },
  };
  const grants = (input.grants ?? ['embeddings']).map((operation) => ({
    operation,
    mode: 'cloud' as const,
    location: 'owner-region' as const,
  }));
  const policy = createProviderPolicyRegistry([
    {
      providerId: 'p',
      retention: 'transient',
      training: 'prohibited',
      location: 'owner-region',
      credentials: 'owner-managed',
      modes: ['cloud', 'private'],
      grants,
      evidenceUrl: 'https://provider.example/terms',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ]);
  const ledger = testBudget();
  const router = createModelRouter({
    providers: [{ adapter, settings: SETTINGS }],
    policy,
    budget: ledger,
    now: () => NOW,
    maxFallbacks: 0,
    maxCandidates: 4,
    failureThreshold: 3,
    cooldownMs: 30_000,
  });
  await router.refresh();
  return { router, calls: () => calls, batches, ledger };
}

function embed(router: ModelRouter, input: EmbeddingRequest): Promise<unknown> {
  const run = router.embed;
  assert.ok(run, 'the router must implement governed embeddings');
  return run(input);
}

const PINNED = { providerId: 'p', modelId: 'embed-small' } as const;

test('an embedding without an owner grant makes zero provider calls', async () => {
  const f = await fixture({ grants: ['chat'] });
  await assert.rejects(
    () => embed(f.router, { ownerId: 'owner', mode: 'cloud', texts: ['board notes'] }),
    (error: unknown) => error instanceof ModelRoutingError,
  );
  assert.equal(f.calls(), 0);
  const snapshot = await f.ledger.snapshot('owner', NOW);
  assert.equal(snapshot.requests, 0);
  assert.equal(snapshot.inputTokens + snapshot.reservedTokens, 0);
});

test('a priced embedding model makes zero provider calls', async () => {
  const f = await fixture({
    models: [model('embed-small', { prompt: '0.0001', completion: '0', request: '0' })],
  });
  await assert.rejects(
    () => embed(f.router, { ownerId: 'owner', mode: 'cloud', texts: ['board notes'] }),
    (error: unknown) => error instanceof ModelRoutingError,
  );
  assert.equal(f.calls(), 0);
});

test('a cloud-only grant is refused for private mode', async () => {
  const f = await fixture();
  await assert.rejects(
    () => embed(f.router, { ownerId: 'owner', mode: 'private', texts: ['board notes'] }),
    (error: unknown) => error instanceof ModelRoutingError,
  );
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.batches, []);
});

test('an authorized batch dispatches once and settles the ledger', async () => {
  const f = await fixture();
  const result = (await embed(f.router, {
    ownerId: 'owner',
    mode: 'cloud',
    texts: ['alpha', 'beta'],
    requested: PINNED,
  })) as { vectors: number[][]; attempts: unknown[] };
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.batches, [['alpha', 'beta']]);
  assert.equal(result.vectors.length, 2);
  assert.equal(result.attempts.length, 1);
  const snapshot = await f.ledger.snapshot('owner', NOW);
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.inputTokens, estimateTokens(['alpha', 'beta']));
});

test('a failed batch is charged, never refunded', async () => {
  const f = await fixture({
    embed: async () => {
      throw new ProviderError('network', 'the provider timed out', { retryable: true });
    },
  });
  await assert.rejects(
    () => embed(f.router, { ownerId: 'owner', mode: 'cloud', texts: ['alpha'], requested: PINNED }),
    (error: unknown) => error instanceof ModelRoutingError,
  );
  assert.equal(f.calls(), 1);
  const snapshot = await f.ledger.snapshot('owner', NOW);
  // Dispatch happened, so the reservation becomes the charge even though no
  // usage came back. Refunding here would under-count a real transfer.
  assert.equal(snapshot.inputTokens, estimateTokens(['alpha']));
});

test('a store whose router refuses reports lexical and transfers nothing', async () => {
  const f = await fixture({ grants: ['chat'] });
  const embeddings = createRouterEmbeddings({
    router: f.router,
    ownerId: 'owner',
    model: PINNED,
  });
  const store = createKnowledgeStore({
    clock: { now: () => NOW, iso: () => NOW.toISOString() },
    ids: createIdGenerator(),
    embeddings,
  });

  const ingested = await store.ingest({
    ownerId: 'owner',
    mode: 'cloud',
    title: 'notes',
    text: 'The router refuses semantic retrieval for this operation.',
  });
  assert.equal(ingested.ok, true);
  if (!ingested.ok) return;
  assert.equal(ingested.value.embedding, 'lexical');

  const found = await store.search({ ownerId: 'owner', mode: 'cloud', query: 'router', k: 3 });
  assert.equal(found.embedding, 'lexical');
  assert.equal(f.calls(), 0);
});

test('the governed adapter refuses a router that cannot embed', () => {
  assert.throws(
    () =>
      createRouterEmbeddings({
        router: { id: 'not-a-router' } as unknown as ModelRouter,
        ownerId: 'owner',
        model: PINNED,
      }),
    /governed embeddings/,
  );
});
