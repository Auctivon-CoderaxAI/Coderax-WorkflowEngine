import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('Work runs to completion, persists its transcript and notifies once', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Summarize the repository',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    assert.equal(completed.steps.length, 3);
    assert.ok(completed.steps.every((step) => step.state === 'completed'));
    // Native runs three planned steps; each step returns the gateway's text.
    assert.ok(completed.result?.summary?.startsWith('A verified result.'));
    // Usage accumulates across the three planned steps (11/13 each).
    assert.deepEqual(completed.usage, { inputTokens: 33, outputTokens: 39 });

    const conversation = await started.app.service.conversation(
      principal,
      submitted.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    if (conversation.ok) {
      assert.equal(conversation.value.messages.length, 2);
      assert.equal(conversation.value.messages[0]?.role, 'user');
      assert.equal(conversation.value.messages[1]?.role, 'assistant');
    }

    const notifications = await started.app.service.notifications(principal);
    assert.equal(notifications.unread, 1);
    assert.equal(notifications.notifications[0]?.state, 'completed');

    const events = started.app.dependencies.events.replay(submitted.value.taskId, 0);
    const types = events.events.map((event) => event.type);
    assert.deepEqual(types.slice(0, 2), ['task.queued', 'task.started']);
    assert.equal(types.at(-1), 'task.completed');
    assert.ok(types.includes('text.delta'));

    const receipts = started.app.dependencies.audit.list();
    assert.ok(receipts.some((entry) => entry.action === 'work.accepted'));
    assert.ok(receipts.some((entry) => entry.action === 'work.completed'));
  } finally {
    await started.close();
  }
});

test('a submitted task completes without any client connection', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Durable execution',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    // The submitting caller is gone: nothing polls, and no connection is held.
    await started.app.dependencies.scheduler.idle();

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.equal(status.ok, true);
    assert.equal(status.ok && status.value.state, 'completed');
  } finally {
    await started.close();
  }
});

test('a second task in the same conversation is refused while one is live', async () => {
  const started = await startTestApp({
    gateway: {
      id: 'slow',
      complete: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
  });
  try {
    const first = await started.app.service.submitWork(principal, {
      objective: 'First task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = await started.app.service.submitWork(principal, {
      objective: 'Second task',
      conversationId: first.value.conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.code, 'busy');

    await started.app.service.cancelTask(principal, first.value.taskId, 'test cleanup');
  } finally {
    await started.close();
  }
});
