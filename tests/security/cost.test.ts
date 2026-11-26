import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createModelCatalog } from '../../src/models/catalog.js';
import { createBudgetLedger } from '../../src/models/budget.js';
import { baseConfig, createWorkspaces, fakeGateway, startTestApp } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };
const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function descriptor(
  ref: ModelDescriptor['ref'],
  costClass: 'free' | 'paid',
): ModelDescriptor {
  return {
    ref,
    label: `${ref.providerId} ${ref.modelId}`,
    costClass,
    toolCalling: false,
    streaming: true,
    availability: ready,
  };
}

const free = descriptor({ providerId: 'free', modelId: 'coderax-small' }, 'free');
const paid = descriptor({ providerId: 'paid', modelId: 'premium' }, 'paid');

test('paid routing is not representable in configuration', () => {
  const workspace = createWorkspaces();
  try {
    assert.throws(() =>
      baseConfig(workspace, {
        models: {
          route: [{ providerId: 'free', modelId: 'coderax-small' }],
          allowPaid: true,
        },
      }),
    );
  } finally {
    workspace.cleanup();
  }
});

test('the catalogue refuses a paid model rather than substituting a free one', () => {
  const catalog = createModelCatalog({
    descriptors: [free, paid],
    route: [free.ref],
    allowPaid: false,
  });
  const requested = catalog.resolve(paid.ref, 'cloud');
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');
  assert.equal(catalog.list().allowPaid, false);
});

test('a paid model is not usable for private execution either', () => {
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
    const first = await started.app.service.submitWork(principal, {
      objective: 'first request',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(first.ok);
    const second = await started.app.service.submitWork(principal, {
      objective: 'second request',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.code, 'budget_exhausted');
    await started.app.service.cancelTask(principal, first.value.taskId, 'test cleanup');
  } finally {
    await started.close();
  }
});

test('an unknown model is refused before a task or a conversation is created', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'unknown model',
      model: { providerId: 'paid', modelId: 'premium' },
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.ok === false && submitted.code, 'engine_not_configured');
    assert.equal((await started.app.dependencies.tasks.listByOwner(principal.ownerId)).length, 0);
    assert.equal((await started.app.service.conversations(principal)).conversations.length, 0);
  } finally {
    await started.close();
  }
});

test('the ledger resets on the UTC day boundary', () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 1, maxTokensPerDay: 100 });
  const now = new Date('2026-11-26T10:00:00.000Z');
  assert.equal(ledger.reserve('owner', now).allowed, true);
  assert.equal(ledger.reserve('owner', now).allowed, false);
  assert.equal(ledger.reserve('owner', new Date('2026-11-27T00:00:00.000Z')).allowed, true);
});

test('a fake gateway is not a capability claim: discovery stays truthful', async () => {
  const started = await startTestApp({ gateway: fakeGateway() });
  try {
    const models = started.app.service.models();
    assert.equal(models.allowPaid, false);
    assert.ok(models.models.every((model) => model.costClass === 'free'));
  } finally {
    await started.close();
  }
});
