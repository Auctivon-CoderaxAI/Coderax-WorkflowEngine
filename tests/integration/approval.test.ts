import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeGateway, startTestApp, waitFor } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * A complex plan whose first action needs a scoped workspace read and whose
 * second action consumes that read. It is the smallest honest case that crosses
 * the permission boundary and then has to resume with the real grant.
 */
const READ_PLAN = {
  steps: [
    {
      id: 'read-notes',
      title: 'Read the notes',
      kind: 'read',
      dependsOn: [],
      resource: 'notes.txt',
      acceptance: 'Read the confined workspace file.',
    },
    {
      id: 'answer',
      title: 'Answer from the notes',
      kind: 'reason',
      dependsOn: ['read-notes'],
      acceptance: 'Use the read content to answer the objective.',
    },
  ],
};

function configWithScopedRead() {
  return {
    engines: {
      native: {
        maxStepAttempts: 1,
        maxParallelSteps: 2,
      },
    },
  };
}

test('a scoped read suspends for owner approval, then resumes with the real grant', async () => {
  const started = await startTestApp({
    gateway: fakeGateway({ plan: READ_PLAN }),
    config: configWithScopedRead(),
  });
  try {
    writeFileSync(
      path.join(started.workspace.cloudRoot, 'notes.txt'),
      'alpha beta gamma',
      'utf8',
    );
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Read the notes and answer from them',
      mode: 'cloud',
      requireApproval: true,
      reasoning: 'complex',
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const { taskId, generation } = submitted.value;

    const awaiting = await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    assert.equal(awaiting.reasoning, 'complex');
    assert.equal(awaiting.failure?.code, 'approval_required');
    assert.equal(awaiting.result, undefined);
    // The planning call already spent tokens; suspension must not erase them.
    assert.deepEqual(awaiting.usage, { inputTokens: 11, outputTokens: 13 });
    assert.deepEqual(
      awaiting.steps.map((entry) => [entry.id, entry.state]),
      [
        ['read-notes', 'queued'],
        ['answer', 'queued'],
      ],
    );
    assert.deepEqual(awaiting.steps[1]?.dependsOn, ['read-notes']);

    const pending = await started.app.service.permissions(principal, taskId);
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const request = pending.value.requests[0];
    assert.ok(request);
    assert.equal(request.scope, 'workspace.read');
    assert.equal(request.resource, 'notes.txt');
    assert.equal(request.decision, 'pending');

    const decided = await started.app.service.decidePermission(principal, taskId, {
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(decided.ok, true);

    const resumed = await started.app.service.resumeTask(principal, taskId, generation);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.value.outcome, 'accepted');
    assert.equal(resumed.value.generation, 2);

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.equal(completed.generation, 2);
    assert.ok(completed.steps.every((entry) => entry.state === 'completed'));
    assert.equal(completed.result?.verification?.passed, true);
    // Plan (1) + resumed reason step + verification, cumulative across the pause.
    assert.deepEqual(completed.usage, { inputTokens: 33, outputTokens: 39 });
    assert.ok(
      completed.result?.verification?.evidence.some((entry) => entry.includes('read notes.txt')),
      `evidence was ${JSON.stringify(completed.result?.verification?.evidence)}`,
    );

    const replay = started.app.dependencies.events.replay(taskId, 0);
    assert.ok(replay.events.some((event) => event.type === 'approval.required'));
    assert.ok(replay.events.some((event) => event.type === 'task.completed'));

    const conversation = await started.app.service.conversation(
      principal,
      submitted.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    if (conversation.ok) {
      assert.deepEqual(
        conversation.value.messages.map((message) => message.role),
        ['user', 'assistant'],
      );
    }
  } finally {
    await started.close();
  }
});

test('a denied scoped action fails the run instead of re-asking on resume', async () => {
  const started = await startTestApp({
    gateway: fakeGateway({ plan: READ_PLAN }),
    config: configWithScopedRead(),
  });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Read the notes and answer from them',
      mode: 'cloud',
      requireApproval: true,
      reasoning: 'complex',
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const { taskId, generation } = submitted.value;

    await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    const pending = await started.app.service.permissions(principal, taskId);
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const request = pending.value.requests[0];
    assert.ok(request);
    await started.app.service.decidePermission(principal, taskId, {
      requestId: request.requestId,
      decision: 'denied',
    });

    const resumed = await started.app.service.resumeTask(principal, taskId, generation);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.value.outcome, 'accepted');

    const failed = await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'failed' ? status.value : null;
    });
    assert.equal(failed.failure?.code, 'workspace_denied');
    assert.equal(failed.result, undefined);
    assert.ok(failed.steps.every((entry) => entry.state !== 'completed'));
  } finally {
    await started.close();
  }
});

test('a task waiting for approval can still be cancelled', async () => {
  const started = await startTestApp({
    gateway: fakeGateway({ plan: READ_PLAN }),
    config: configWithScopedRead(),
  });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Read the notes and answer from them',
      mode: 'cloud',
      requireApproval: true,
      reasoning: 'complex',
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const { taskId } = submitted.value;

    await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });

    const cancelled = await started.app.service.cancelTask(principal, taskId, 'owner stopped');
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.value.outcome, 'accepted');
    assert.equal(cancelled.value.state, 'cancelled');
  } finally {
    await started.close();
  }
});
