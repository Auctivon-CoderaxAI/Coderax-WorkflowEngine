import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, slowProvider, startTestApp, waitFor } from '../helpers.js';

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
  const started = await startTestApp({ provider: slowProvider(60_000) });
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

test('a failure the adapter marked retryable is retried on the same agent with a new generation', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    // The retry precondition is the adapter's own proof that nothing dispatched.
    // A provider error after a step started is deliberately not retryable.
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    const nativeRun = agent.run;
    let attempts = 0;
    agent.run = async (request, report) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          code: 'server_unavailable',
          detail: 'The endpoint refused the connection before dispatch.',
          retryable: true,
          preDispatch: true,
        };
      }
      return nativeRun(request, report);
    };

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
    assert.equal(failed.failure?.code, 'server_unavailable');

    const retried = await api.retry(accepted.taskId, failed.generation);
    assert.equal(retried.outcome, 'accepted');
    assert.equal(retried.generation, 2);

    const completed = await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.equal(completed.generation, 2);
    assert.ok(completed.result?.summary?.startsWith('A verified result.'));
  } finally {
    await started.close();
  }
});
