import { createModelCatalog } from '../../src/models/catalog.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createModelRouter } from '../../src/models/router.js';
import {
  baseConfig,
  createWorkspaces,
  fakeProvider,
  startTestApp,
  testProviderPolicy,
} from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
/** A router over one fixture provider: the only place a route is decided. */
async function routerWith(provider: ReturnType<typeof fakeProvider>) {
  const router = createModelRouter({
    providers: [
      {
        adapter: provider,
        settings: {
          requestsPerMinute: 60,
          tokensPerMinute: 100_000,
          maxConcurrency: 2,
          requestTimeoutMs: 1_000,
          discoveryIntervalMs: 60_000,
        },
      },
    ],
    policy: { evaluate: () => ({ allowed: true, providerId: provider.id, operation: 'chat', mode: 'cloud', retention: 'transient', location: 'owner-region' }), get: () => testProviderPolicy(provider.id), list: () => [testProviderPolicy(provider.id)] },
    attestations: [],
    benchmarks: [],
    preferredRoute: [],
    budget: createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 100_000 }),
    maxCandidates: 4,
    maxFallbacks: 2,
    failureThreshold: 3,
    cooldownMs: 1_000,
    discoveryIntervalMs: 60_000,
    defaultMaxOutputTokens: 512,
    contextMarginTokens: 256,
    now: () => new Date('2026-11-26T00:00:00.000Z'),
  });
  await router.refresh();
  return router;
}

test('a paid model is refused even when the provider advertises it', async () => {
  const provider = fakeProvider();
  const paidRef = { providerId: 'free', modelId: 'premium' };
  const discovered = provider.discover;
  provider.discover = async () => [
    ...(await discovered()),
    {
      ref: paidRef,
      label: 'Paid fixture',
      contextTokens: 8_192,
      maxOutputTokens: 1_024,
      capabilities: { vision: false, toolCalling: true, reasoning: true, streaming: true },
      pricing: { prompt: '0.00001', completion: '0.00002' },
    },
  ];
  const router = await routerWith(provider);
  const requested = router.resolve(paidRef, 'cloud', { operation: 'chat' });
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');
  // The ordered route contains only a verified free model.
  const automatic = router.resolve(null, 'cloud', { operation: 'chat' });
  assert.equal(automatic.ok, true);
  assert.notDeepEqual(automatic.ok && automatic.value.ref, paidRef);
});

test('an unavailable provider leaves no routable model', async () => {
  const provider = fakeProvider();
  provider.discover = async () => [];
  const router = await routerWith(provider);
  const resolved = router.resolve(null, 'cloud', { operation: 'chat' });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'model_missing');
});

test('the token budget fails closed before the next request is sent', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 10 });
  const now = new Date('2026-11-26T00:00:00.000Z');
  const first = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 6, outputTokens: 4 });
  assert.equal(first.allowed, true);
  if (first.allowed) await ledger.settle(first.reservation.id, { inputTokens: 6, outputTokens: 4 });
  const second = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 6, outputTokens: 4 });
  assert.equal(second.allowed, false);
  assert.equal(
    (await ledger.reserve({ ownerId: 'another-owner', at: now, inputTokens: 1, outputTokens: 1 })).allowed,
    true,
  );
});

test('configuration cannot enable paid routing', () => {
  const workspace = createWorkspaces();
  try {
    assert.throws(
      () =>
        baseConfig(workspace, {
          models: {
            allowPaid: true,
            route: [{ providerId: 'openai', modelId: 'premium' }],
          },
        }),
      /allowPaid|literal|Invalid input/i,
    );
  } finally {
    workspace.cleanup();
  }
});

test('the composed engine advertises allowPaid false and one zero-cost route', async () => {
  const started = await startTestApp();
  try {
    const models = started.app.service.models();
    assert.equal(models.allowPaid, false);
    assert.ok(models.route.length > 0);
    for (const ref of models.route) {
      const resolved = started.app.dependencies.models.resolve(ref, 'cloud', { operation: 'chat' });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.ok && resolved.value.costClass, 'free');
    }
    const corrupt = await started.app.service.submitWork(
      { ownerId: 'owner-test', isOwner: true },
      {
        objective: 'Paid request must be refused',
        mode: 'cloud',
        model: { providerId: 'openai', modelId: 'premium' },
        requireApproval: true,
      },
    );
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.ok === false && corrupt.code, 'engine_not_configured');
  } finally {
    await started.close();
  }
});

// Reconciled from ci/permanent-quality-gate: private mode is not a paid bypass,
// the request budget fails closed at the service boundary, and a refused model
// creates neither a task nor a conversation.
test('a paid model is not usable for private execution either', () => {
  const paid = { ref: { providerId: 'openai', modelId: 'premium' }, label: 'Premium', costClass: 'paid' as const,
    toolCalling: false, streaming: false, availability: { available: true, reason: 'ready' as const } };
  const catalog = createModelCatalog({
    descriptors: [paid],
    route: [paid.ref],
    allowPaid: false,
  });
  const requested = catalog.resolve(paid.ref, 'private');
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');
  const routed = catalog.resolve(null, 'private');
  assert.equal(routed.ok, false);
});

test('the daily request budget fails closed at the service boundary', async () => {
  const started = await startTestApp({
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        dailyRequestBudget: 1,
      },
    },
  });
  try {
    const first = await started.app.service.submitWork(
      { ownerId: 'owner-test', isOwner: true },
      { objective: 'first request', mode: 'cloud', requireApproval: true },
    );
    assert.ok(first.ok);
    const second = await started.app.service.submitWork(
      { ownerId: 'owner-test', isOwner: true },
      { objective: 'second request', mode: 'cloud', requireApproval: true },
    );
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.code, 'budget_exhausted');
    await started.app.service.cancelTask(
      { ownerId: 'owner-test', isOwner: true },
      first.value.taskId,
      'test cleanup',
    );
  } finally {
    await started.close();
  }
});

test('an unknown model is refused before a task or a conversation is created', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(
      { ownerId: 'owner-test', isOwner: true },
      {
        objective: 'unknown model',
        model: { providerId: 'paid', modelId: 'premium' },
        mode: 'cloud',
        requireApproval: true,
      },
    );
    assert.equal(submitted.ok, false);
    assert.equal(submitted.ok === false && submitted.code, 'engine_not_configured');
    assert.equal(
      (await started.app.dependencies.tasks.listByOwner('owner-test')).length,
      0,
    );
    assert.equal(
      (await started.app.service.conversations({ ownerId: 'owner-test', isOwner: true }))
        .conversations.length,
      0,
    );
  } finally {
    await started.close();
  }
});

test('no source path can switch paid routing on', () => {
  const offenders: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(absolute, 'utf8');
        // The verifier classifies unproven providers as paid; that classification
        // is how a paid route is refused. It is the only place the literal may
        // appear, and allowPaid can never be switched on anywhere.
        const verifier = path.relative(root, absolute).split(path.sep).join('/') === 'src/models/verify.ts';
        if (/allowPaid\s*:\s*true/.test(text) || (!verifier && /costClass\s*:\s*['"]paid['"]/.test(text))) {
          offenders.push(path.relative(root, absolute));
        }
      }
    }
  }
  walk(path.join(root, 'src'));
  walk(path.join(root, 'packages'));
  assert.deepEqual(offenders, []);
});
