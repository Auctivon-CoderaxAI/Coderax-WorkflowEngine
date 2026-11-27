import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createBudgetLedger } from '../../src/models/budget.js';
import { baseConfig, createWorkspaces, startTestApp } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

test('the token budget fails closed before the next request is sent', async () => {
  const ledger = createBudgetLedger({ maxRequestsPerDay: 100, maxTokensPerDay: 10 });
  const now = new Date('2026-11-26T00:00:00.000Z');
  const held = await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 6, outputTokens: 4 });
  assert.equal(held.allowed, true);
  if (!held.allowed) assert.fail('expected reservation');
  await ledger.settle(held.reservation.id, { inputTokens: 6, outputTokens: 4 });
  assert.equal(
    (await ledger.reserve({ ownerId: 'owner', at: now, inputTokens: 0, outputTokens: 0 })).allowed,
    false,
  );
  assert.equal(
    (await ledger.reserve({ ownerId: 'another-owner', at: now, inputTokens: 0, outputTokens: 0 }))
      .allowed,
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
      const resolved = started.app.dependencies.models.resolve(ref, 'cloud', {
        operation: 'work',
      });
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
        // The verifier labels unverified models paid precisely to refuse them.
        const isVerifier = absolute === path.join(root, 'src', 'models', 'verify.ts');
        if (/allowPaid\s*:\s*true/.test(text) || (!isVerifier && /costClass\s*:\s*['"]paid['"]/.test(text))) {
          offenders.push(path.relative(root, absolute));
        }
      }
    }
  }
  walk(path.join(root, 'src'));
  walk(path.join(root, 'packages'));
  assert.deepEqual(offenders, []);
});
