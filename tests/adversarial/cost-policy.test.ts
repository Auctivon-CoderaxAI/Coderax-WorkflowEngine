import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ModelDescriptor } from '@coderax/contracts';
import { createBudgetLedger } from '../../src/models/budget.js';
import { createModelCatalog } from '../../src/models/catalog.js';
import { baseConfig, createWorkspaces, startTestApp } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const ready = { available: true as const, reason: 'ready' as const, detail: 'ready' };

function descriptor(
  providerId: string,
  modelId: string,
  costClass: 'free' | 'paid',
  availability: ModelDescriptor['availability'] = ready,
): ModelDescriptor {
  return {
    ref: { providerId, modelId },
    label: `${providerId} ${modelId}`,
    costClass,
    toolCalling: false,
    streaming: false,
    availability,
  };
}

test('the catalogue refuses a paid model even when it is advertised', () => {
  const paid = descriptor('openai', 'premium', 'paid');
  const free = descriptor('openrouter', 'coderax:free', 'free');
  const catalog = createModelCatalog({
    descriptors: [free, paid],
    route: [paid.ref, free.ref],
    allowPaid: false,
  });

  const requested = catalog.resolve(paid.ref, 'cloud');
  assert.equal(requested.ok, false);
  assert.equal(requested.ok === false && requested.code, 'paid_model_refused');

  // The ordered route skips the paid descriptor rather than silently using it.
  const fallback = catalog.resolve(null, 'cloud');
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.ok && fallback.value.ref, free.ref);
});

test('an unavailable free model is not advertised as usable', () => {
  const unavailable = descriptor('openrouter', 'coderax:free', 'free', {
    available: false,
    reason: 'not_configured',
    detail: 'No endpoint.',
  });
  const catalog = createModelCatalog({
    descriptors: [unavailable],
    route: [unavailable.ref],
    allowPaid: false,
  });
  const resolved = catalog.resolve(null, 'cloud');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.code, 'model_missing');
});

test('the token budget fails closed before the next request is sent', () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 10 });
  const now = new Date('2026-11-26T00:00:00.000Z');
  assert.equal(ledger.reserve('owner', now).allowed, true);
  ledger.consume('owner', { inputTokens: 6, outputTokens: 4 }, now);
  assert.equal(ledger.reserve('owner', now).allowed, false);
  assert.equal(ledger.reserve('another-owner', now).allowed, true);
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
      const resolved = started.app.dependencies.models.resolve(ref, 'cloud');
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

test('no source path can switch paid routing on', () => {
  const offenders: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(absolute, 'utf8');
        if (/allowPaid\s*:\s*true/.test(text) || /costClass\s*:\s*['"]paid['"]/.test(text)) {
          offenders.push(path.relative(root, absolute));
        }
      }
    }
  }
  walk(path.join(root, 'src'));
  walk(path.join(root, 'packages'));
  assert.deepEqual(offenders, []);
});
