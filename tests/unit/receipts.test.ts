import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReceipt } from '../../src/execution/receipt.js';
import { taskRecord } from '../helpers.js';

test('a receipt is a bounded projection of engine-owned facts', () => {
  const steps = Array.from({ length: 140 }, (_, index) => ({
    id: `step-${index + 1}`,
    title: `Step ${index + 1}`,
    state: (index % 2 === 0 ? 'completed' : 'queued') as 'completed' | 'queued',
  }));
  const toolCalls = Array.from({ length: 300 }, (_, index) => ({
    callId: `call-${index}`,
    tool: 'fs.write',
    ok: index % 3 !== 0,
    digest: 'a'.repeat(32),
  }));
  const receipt = createReceipt({
    receiptId: 'receipt-1',
    task: taskRecord({ taskId: 'task-1', generation: 3 }),
    state: 'completed',
    startedAt: '2026-11-26T10:00:00.000Z',
    finishedAt: '2026-11-26T10:01:00.000Z',
    steps,
    toolCalls,
    planDigest: 'plan-digest',
    usage: { inputTokens: 12, outputTokens: 8 },
    requests: 2,
  });

  assert.equal(receipt.receiptId, 'receipt-1');
  assert.equal(receipt.generation, 3);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.steps.length, 128);
  assert.equal(receipt.toolCalls.length, 256);
  assert.equal(receipt.planDigest, 'plan-digest');
  assert.deepEqual(receipt.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(receipt.requests, 2);
  // No model-authored text is accepted by the receipt constructor at all.
  assert.equal('summary' in receipt, false);
});
