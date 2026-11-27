import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxClient } from '@coderax/sdk';
import { failingGateway, OWNER_TOKEN, slowGateway, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('submit, stream, status, notifications and history complete end to end', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const health = await api.health();
    assert.equal(health.status, 'ok');

    const agents = await api.agents();
    assert.equal(agents.agents.length, 3);
    const models = await api.models();
    assert.equal(models.allowPaid, false);

    const accepted = await api.submitWork({
      objective: 'Prepare the release checklist',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(accepted.state, 'queued');

    const seen: string[] = [];
    for await (const event of api.events(accepted.taskId)) {
      seen.push(event.type);
      if (event.type.startsWith('task.') && event.type !== 'task.queued' && event.type !== 'task.started') {
        break;
      }
    }
    assert.ok(seen.includes('task.completed'), `events were ${seen.join(', ')}`);

    const status = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(status.generation, 1);
    assert.ok(status.result?.summary?.startsWith('A verified result.'));

    const notifications = await api.notifications();
    assert.equal(notifications.unread, 1);

    // A second client (the CLI, or another browser tab) sees the same truth.
    const second = client(started.url);
    const sharedTask = await second.task(accepted.taskId);
    assert.equal(sharedTask.state, 'completed');
    const sharedConversation = await second.conversation(accepted.conversationId);
    assert.equal(sharedConversation.messages.length, 2);
    const history = await second.conversations();
    assert.equal(history.conversations[0]?.conversationId, accepted.conversationId);
  } finally {
    await started.close();
  }
});

test('a cancelled task settles as cancelled and is not left running', async () => {
  const started = await startTestApp({ gateway: slowGateway(60_000) });
  const api = client(started.url);
  try {
    const accepted = await api.submitWork({
      objective: 'Long running work',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });

    await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'running' ? status : null;
    });

    const cancelled = await api.cancel(accepted.taskId, 'owner cancelled');
    assert.equal(cancelled.outcome, 'accepted');

    const settled = await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'cancelled' ? status : null;
    });
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.generation, 1);
  } finally {
    await started.close();
  }
});

test('a failed task can be retried on the same agent with a new generation', async () => {
  // The first call is the model-assisted plan; the run's first action is the
  // second call, which is the one that must fail here.
  const started = await startTestApp({ gateway: failingGateway(2) });
  const api = client(started.url);
  try {
    const accepted = await api.submitWork({
      objective: 'Retryable work',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });

    const failed = await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'failed' ? status : null;
    });
    assert.equal(failed.generation, 1);
    assert.equal(failed.failure?.code, 'provider_error');

    const retried = await api.retry(accepted.taskId, failed.generation);
    assert.equal(retried.outcome, 'accepted');
    assert.equal(retried.generation, 2);

    const completed = await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.equal(completed.generation, 2);
    assert.ok(completed.result?.summary?.startsWith('Recovered result.'));
  } finally {
    await started.close();
  }
});

test('shutdown ends a stream for a task awaiting approval', { timeout: 5_000 }, async () => {
  const started = await startTestApp();
  const api = client(started.url);
  const abort = new AbortController();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({ ok: false, code: 'approval_required', detail: 'Approval required', retryable: true });
    const task = await api.submitWork({
      objective: 'Wait for approval', mode: 'cloud', requireApproval: true,
    });
    await waitFor(async () => (await api.task(task.taskId)).state === 'awaiting_approval' || null);
    const response = await fetch(`${started.url}/v1/work/${task.taskId}/events`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);

    const shutdown = started.app.stop();
    try {
      await Promise.race([
        shutdown,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('shutdown was blocked by the event stream')), 1_000);
          timer.unref();
        }),
      ]);
      while (!(await reader.read()).done) { /* Drain retained events through EOF. */ }
      assert.equal((await started.app.dependencies.tasks.get(task.taskId))?.state, 'awaiting_approval');
    } finally {
      abort.abort();
      await shutdown;
    }
  } finally {
    abort.abort();
    await started.close();
  }
});
