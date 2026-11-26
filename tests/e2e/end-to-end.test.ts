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

test('a bounded team is admitted, evidence-verified and observable through the SDK', async () => {
  const gateway = {
    id: 'e2e-team-gateway',
    complete: async () => ({
      text: JSON.stringify({ final: 'Read the assigned resource and reported back.' }),
      usage: { inputTokens: 4, outputTokens: 5 },
    }),
  };
  const started = await startTestApp({
    gateway,
    config: { teams: { maxMembers: 2, maxParallel: 2, maxStepsPerMember: 1 } },
  });
  const api = client(started.url);
  try {
    const accepted = await api.submitTeam({
      objective: 'One bounded member with objective evidence',
      mode: 'cloud',
      members: [
        {
          memberId: 'reader',
          agent: 'coderax',
          objective: 'Read the spec and report the result',
          dependsOn: [],
          resources: [],
        },
      ],
      checks: [{ kind: 'evidence', memberId: 'reader' }],
    });
    assert.equal(accepted.state, 'running');

    const completed = await waitFor(async () => {
      const status = await api.team(accepted.teamId);
      return status.state === 'completed' ? status : null;
    });
    assert.equal(completed.members[0]?.state, 'completed');
    assert.equal(completed.verification?.passed, true);
    assert.deepEqual(
      completed.verification?.checks.map((check) => [check.kind, check.passed]),
      [
        ['evidence', true],
        ['evidence', true],
      ],
    );
    const permissions = await api.teamPermissions(accepted.teamId);
    assert.deepEqual(permissions.requests, []);
  } finally {
    await started.close();
  }
});
