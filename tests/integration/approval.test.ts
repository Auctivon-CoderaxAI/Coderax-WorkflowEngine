import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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

    // Each Work generation runs in its own confined directory under the mode
    // root, so the file the plan reads is seeded for both generations.
    for (const gen of [1, 2]) {
      const dir = path.join(
        started.workspace.cloudRoot,
        '.coderax-runs',
        `${taskId}-g${gen}`,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'notes.txt'), 'alpha beta gamma', 'utf8');
    }

    const awaiting = await waitFor(async () => {
      const status = await started.app.service.task(principal, taskId);
      return status.ok && status.value.state === 'awaiting_approval' ? status.value : null;
    });
    assert.equal(awaiting.reasoning, 'complex');
    assert.equal(awaiting.failure?.code, 'approval_required');
    assert.equal(awaiting.result, undefined);
    // The planning call already spent tokens and an iteration; suspension must
    // not erase either, and the resumed generation continues the same bound.
    assert.deepEqual(awaiting.usage, { inputTokens: 11, outputTokens: 13 });
    const suspended = await started.app.dependencies.tasks.get(taskId);
    assert.equal(suspended?.checkpoint.iterations, 1);
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
    // Plan (1) + read + reason + verification: cumulative across the pause.
    assert.deepEqual(completed.usage, { inputTokens: 33, outputTokens: 39 });
    const settled = await started.app.dependencies.tasks.get(taskId);
    assert.equal(settled?.checkpoint.iterations, 4);
    // Work usage is charged to the daily ledger exactly once per generation.
    assert.deepEqual(started.app.service.budget(principal).used.usage, completed.usage);
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
      // The resumed generation skipped the read, so its final transcript must
      // replay the read's evidence rather than only the verification line.
      const answer = conversation.value.messages.at(-1)?.text ?? '';
      assert.match(answer, /alpha beta gamma/);
      assert.match(answer, /A verified result\./);
      assert.match(answer, /Verification: passed/);
    }
  } finally {
    await started.close();
  }
});

test('approval suspension survives a failed lease release and becomes resumable after expiry', async (t) => {
  const started = await startTestApp({
    gateway: fakeGateway({ plan: READ_PLAN }),
    config: {
      ...configWithScopedRead(),
      execution: { leaseTtlMs: 60_000, heartbeatIntervalMs: 500 },
    },
  });
  try {
    const { service, dependencies: deps } = started.app;
    let checkpointAtRelease: { state: string; firstStep: string | undefined } | undefined;
    const readBeforeFailedRelease: typeof deps.lease.release = async () => {
      const [task] = await deps.tasks.listUnsettled();
      if (task) {
        checkpointAtRelease = {
          state: task.state,
          firstStep: task.checkpoint.plan?.steps[0]?.id,
        };
      }
      throw new Error('lease store unavailable');
    };
    const release = t.mock.method(deps.lease, 'release', readBeforeFailedRelease);
    writeFileSync(path.join(started.workspace.cloudRoot, 'notes.txt'), 'saved notes');
    const submitted = await service.submitWork(principal, {
      objective: 'Read the notes and answer from them',
      mode: 'cloud',
      requireApproval: true,
      reasoning: 'complex',
    });
    assert.ok(submitted.ok);
    const { taskId, generation } = submitted.value;

    // Each Work generation runs in its own confined directory under the mode
    // root, so the file the resumed plan reads is seeded for both generations.
    for (const gen of [1, 2]) {
      const dir = path.join(
        started.workspace.cloudRoot,
        '.coderax-runs',
        `${taskId}-g${gen}`,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'notes.txt'), 'saved notes', 'utf8');
    }

    await deps.scheduler.idle();
    assert.equal(release.mock.callCount(), 1);
    assert.deepEqual(checkpointAtRelease, {
      state: 'awaiting_approval',
      firstStep: 'read-notes',
    });

    const held = await service.task(principal, taskId);
    assert.ok(held.ok);
    assert.equal(held.value.state, 'running');
    const pending = await service.permissions(principal, taskId);
    assert.ok(pending.ok && pending.value.requests[0]);
    const approved = await service.decidePermission(principal, taskId, {
      requestId: pending.value.requests[0].requestId,
      decision: 'approved',
    });
    assert.ok(approved.ok);
    const premature = await service.resumeTask(principal, taskId, generation);
    assert.ok(!premature.ok && premature.code === 'busy');

    release.mock.restore();
    const afterExpiry = new Date(deps.clock.now().getTime() + 60_000);
    t.mock.method(deps.clock, 'now', () => afterExpiry);
    assert.deepEqual(await service.recoverInterrupted(), { interrupted: 0 });
    const ready = await service.task(principal, taskId);
    assert.ok(ready.ok);
    assert.equal(ready.value.state, 'awaiting_approval');
    const resumed = await service.resumeTask(principal, taskId, generation);
    assert.ok(resumed.ok && resumed.value.outcome === 'accepted');
    await deps.scheduler.idle();
    const completed = await service.task(principal, taskId);
    assert.ok(completed.ok && completed.value.state === 'completed');
    assert.equal(completed.value.generation, generation + 1);
  } finally {
    await started.close();
  }
});

for (const cancelFirst of [true, false]) {
  test(`cancellation wins when ${cancelFirst ? 'flagging first' : 'suspending first'}`, async (t) => {
    const started = await startTestApp({
      gateway: fakeGateway({ plan: READ_PLAN }),
      config: configWithScopedRead(),
    });
    try {
      const { service, dependencies: deps } = started.app;
      const update = deps.tasks.updateFenced;
      let cancellation: Awaited<ReturnType<typeof service.cancelTask>> | undefined;
      const get = deps.tasks.get;
      t.mock.method(deps.tasks, 'updateFenced', async (input: Parameters<typeof update>[0]) => {
        if (input.patch.state !== 'awaiting_approval') return update(input);
        if (cancelFirst) {
          cancellation = await service.cancelTask(principal, input.taskId);
          return update(input);
        }

        // Give cancelTask an active snapshot even though suspension has already
        // won the task write. The old lease remains live at this point.
        const active = await get(input.taskId);
        const applied = await update(input);
        const stale = t.mock.method(deps.tasks, 'get', async (id: string) => {
          stale.mock.restore();
          return id === input.taskId ? active : get(id);
        });
        cancellation = await service.cancelTask(principal, input.taskId);
        return applied;
      });

      const submitted = await service.submitWork(principal, {
        objective: 'Read the notes and answer from them',
        mode: 'cloud',
        requireApproval: true,
        reasoning: 'complex',
      });
      assert.ok(submitted.ok);
      const { taskId, generation } = submitted.value;
      await deps.scheduler.idle();

      assert.ok(cancellation?.ok && cancellation.value.outcome === 'accepted');
      const final = await service.task(principal, taskId);
      assert.ok(final.ok && final.value.state === 'cancelled');
      const resumed = await service.resumeTask(principal, taskId, generation);
      assert.ok(resumed.ok && resumed.value.outcome === 'already_terminal');
      assert.equal(resumed.value.generation, generation);
    } finally {
      await started.close();
    }
  });
}

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
