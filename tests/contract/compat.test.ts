import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatRequest,
  ModelList,
  Problem,
  TaskStatus,
  WorkSubmitRequest,
} from '@coderax/contracts';

/**
 * A cross-repository compatibility gate.
 *
 * Coderax (web) and CoderaxCLI consume the same contracts. Media support was
 * added with optional fields only, so a payload written against 1.0 must still
 * parse here and an older client must still parse a response that omits the new
 * fields. The strict object schemas make an accidental required addition fail
 * this test instead of shipping a breaking wire change.
 */

const model = { providerId: 'free', modelId: 'coderax-small' } as const;

test('a 1.0 Chat request remains valid without attachments', () => {
  const parsed = ChatRequest.safeParse({ message: 'hello', mode: 'cloud' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.attachments, undefined);
  assert.equal(parsed.data.agent, 'coderax');
});

test('a 1.0 Work request remains valid without media or a creative deliverable', () => {
  const parsed = WorkSubmitRequest.safeParse({ objective: 'do work', mode: 'cloud' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.attachments, undefined);
  assert.equal(parsed.data.creative, undefined);
  assert.equal(parsed.data.requireApproval, true);
});

test('a ModelList from before media support still parses', () => {
  const legacy = {
    models: [
      {
        ref: model,
        label: 'Legacy',
        costClass: 'free',
        toolCalling: false,
        streaming: true,
        availability: { available: true, reason: 'ready', detail: 'ready' },
      },
    ],
    route: [model],
    allowPaid: false,
  };
  const parsed = ModelList.safeParse(legacy);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.media, undefined);
  assert.equal(parsed.data.models[0]?.inputModalities, undefined);
});

test('a TaskStatus from before media support still parses', () => {
  const legacy = {
    taskId: 'task-1',
    conversationId: 'conversation-1',
    state: 'completed',
    agent: 'coderax',
    mode: 'cloud',
    generation: 1,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    cancelRequested: false,
    steps: [],
    result: { summary: 'done', artifacts: [{ path: 'report.txt', digest: 'sha256:abc' }] },
  };
  const parsed = TaskStatus.safeParse(legacy);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.media, undefined);
  assert.equal(parsed.data.result?.artifacts[0]?.content, undefined);
});

test('the shared Problem body is still the only error shape', () => {
  const parsed = Problem.safeParse({
    type: 'https://coderax.dev/problems/validation_failed',
    title: 'validation failed',
    status: 400,
    code: 'validation_failed',
    detail: 'An attachment is malformed.',
    requestId: 'req-1',
    retryable: false,
  });
  assert.equal(parsed.success, true);
});
