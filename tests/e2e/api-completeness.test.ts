import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { OWNER_ID, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('Work listing, receipts, budget, memory, notifications and deletion are shared through the SDK', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const firstRequest = {
      objective: 'First durable task',
      agent: 'coderax' as const,
      mode: 'cloud' as const,
      requireApproval: true,
    };
    const first = await api.submitWork(firstRequest, { idempotencyKey: 'idem-first' });
    const replay = await api.submitWork(firstRequest, { idempotencyKey: 'idem-first' });
    assert.equal(replay.taskId, first.taskId, 'an idempotent retry returns the original task');

    await assert.rejects(
      () =>
        api.submitWork(
          { ...firstRequest, objective: 'A different objective' },
          { idempotencyKey: 'idem-first' },
        ),
      (error: unknown) =>
        error instanceof CoderaxApiError &&
        error.code === 'conflict' &&
        error.status === 409,
    );

    const second = await api.submitWork({
      objective: 'Second durable task',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });
    const privateTask = await api.submitWork({
      objective: 'Private durable task',
      agent: 'coderax',
      mode: 'private',
      requireApproval: true,
    });

    for (const taskId of [first.taskId, second.taskId, privateTask.taskId]) {
      await waitFor(async () => {
        const status = await api.task(taskId);
        return status.state === 'completed' ? status : null;
      });
    }

    // Both clients read the same authoritative page; pagination does not repeat.
    const cloudPage = await api.tasks({ mode: 'cloud', limit: 1 });
    assert.equal(cloudPage.total, 2);
    assert.equal(cloudPage.tasks.length, 1);
    assert.ok(cloudPage.nextCursor);
    const cloudNext = await api.tasks({
      mode: 'cloud',
      limit: 1,
      cursor: cloudPage.nextCursor,
    });
    assert.equal(cloudNext.tasks.length, 1);
    assert.notEqual(cloudNext.tasks[0]?.taskId, cloudPage.tasks[0]?.taskId);
    assert.equal(cloudNext.nextCursor, undefined);

    const filtered = await api.tasks({ state: 'completed', mode: 'cloud' });
    assert.equal(filtered.total, 2);
    assert.equal(
      (await api.tasks({ mode: 'private' })).tasks[0]?.taskId,
      privateTask.taskId,
    );

    const conversations = await api.conversations({ isWork: 'true', limit: 2 });
    assert.equal(conversations.total, 3);
    assert.equal(conversations.conversations.length, 2);
    assert.ok(conversations.nextCursor);

    // A second client sees the same tasks and history.
    const cli = client(started.url);
    assert.equal((await cli.task(first.taskId)).state, 'completed');
    assert.equal(
      (await cli.conversation(first.conversationId)).messages.length,
      2,
    );

    const receipts = await api.receipts(first.taskId, { limit: 1 });
    assert.ok(receipts.total >= 2);
    assert.equal(receipts.receipts.length, 1);
    assert.ok(receipts.nextCursor);
    const receiptActions = (await api.receipts(first.taskId)).receipts.map(
      (receipt) => receipt.action,
    );
    assert.ok(receiptActions.includes('work.completed'));

    const budget = await api.budget();
    assert.equal(budget.period, 'day');
    assert.ok(budget.used.requests >= 3);
    assert.equal(budget.remaining.requests, budget.budget.maxRequests - budget.used.requests);

    // Memory is owner-scoped and partitioned by data mode.
    const written = await api.writeMemory('release-notes', 'ready', 'private');
    assert.equal(written.value, 'ready');
    assert.equal(
      (await api.memory('private')).entries.find((entry) => entry.key === 'release-notes')?.value,
      'ready',
    );
    assert.equal(
      (await api.memory('cloud')).entries.some((entry) => entry.key === 'release-notes'),
      false,
    );
    assert.equal((await api.deleteMemory('release-notes', 'private')).deleted, true);
    assert.equal(
      (await api.memory('private')).entries.some((entry) => entry.key === 'release-notes'),
      false,
    );

    // Unread completion indicators survive beyond one client's page.
    const unread = await api.notifications({ unreadOnly: 'true', limit: 2 });
    assert.equal(unread.total, 3);
    assert.equal(unread.unread, 3);
    assert.equal(unread.notifications.length, 2);
    assert.ok(unread.nextCursor);

    const marked = await api.markNotificationsRead([first.taskId]);
    assert.equal(marked.unread, 2);
    const stillUnread = await api.notifications({ unreadOnly: 'true' });
    assert.equal(stillUnread.total, 2);
    assert.equal(
      stillUnread.notifications.some((notification) => notification.taskId === first.taskId),
      false,
    );

    // Permission requests are listed with a bounded page and decision filter.
    await started.app.dependencies.permissions.request({
      ownerId: OWNER_ID,
      taskId: first.taskId,
      agent: 'coderax',
      scope: 'workspace.write',
      description: 'Write outside the workspace',
      resource: '/tmp/other',
    });
    const pending = await api.permissions(first.taskId, { decision: 'pending', limit: 1 });
    assert.equal(pending.total, 1);
    assert.equal(pending.requests[0]?.decision, 'pending');
    const decided = await api.decidePermission(first.taskId, {
      requestId: pending.requests[0]!.requestId,
      decision: 'denied',
      reason: 'not needed',
    });
    assert.equal(decided.requests[0]?.decision, 'denied');
    assert.equal(
      (await api.permissions(first.taskId, { decision: 'approved' })).total,
      0,
    );

    await assert.rejects(
      () => api.tasks({ cursor: 'not-a-cursor' }),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.code === 'validation_failed',
    );

    // Authorized deletion removes dependent records and refuses a live task.
    const removed = await api.deleteConversation(second.conversationId);
    assert.equal(removed.deleted, true);
    assert.ok(removed.messagesDeleted >= 2);
    assert.equal(removed.tasksDeleted, 1);
    await assert.rejects(
      () => api.task(second.taskId),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
    );
    await assert.rejects(
      () => api.receipts(second.taskId),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
    );
    assert.equal((await api.tasks({ mode: 'cloud' })).total, 1);
    assert.equal((await api.notifications()).total, 2);
  } finally {
    await started.close();
  }
});
