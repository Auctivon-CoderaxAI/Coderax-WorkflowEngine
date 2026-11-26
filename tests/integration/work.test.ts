import assert from 'node:assert/strict';
import { ExecutionEvent } from '@coderax/contracts';
import { test } from 'node:test';
import { slowProvider, startTestApp, waitFor } from '../helpers.js';

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
  const started = await startTestApp({ provider: slowProvider(60_000) });
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

test('reported text and nested arguments are scrubbed before replay and persistence', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async (_request, report) => {
      report({ type: 'text.replace', text: 'reply: sk-example' });
      report({ type: 'text.delta', text: '0123456789 done' });
      report({ type: 'tool.call', tool: 'test', callId: 'call', input: [{ api_key: 'sample value' }] });
      assert.throws(() => report({ type: 'file.edit', path: 'x'.repeat(1025) }), /file.edit path/);
      report({ type: 'file.edit', path: 'x'.repeat(1024) });
      return { ok: true, summary: 'done' };
    };
    const task = await started.app.service.submitWork(principal, {
      objective: 'exercise reports', mode: 'cloud', requireApproval: true,
    });
    assert.ok(task.ok);
    await started.app.dependencies.scheduler.idle();
    const replay = started.app.dependencies.events.replay(task.value.taskId, 0);
    for (const event of replay.events) ExecutionEvent.parse(event);
    const frames = JSON.stringify(replay.events);
    assert.doesNotMatch(frames, /sk-example|0123456789|sample value/);
    assert.match(frames, /redacted-key/);
    assert.equal(replay.events.filter(event => event.type === 'file.edit').length, 1);
    const conversation = await started.app.service.conversation(principal, task.value.conversationId);
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.at(-1)?.text, 'reply: [redacted-key] done');
  } finally {
    await started.close();
  }
});

test('cancellation releases a hung adapter and ignores its late reports', { timeout: 10000 }, async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    let late = () => {};
    agent.run = async (_request, report) => {
      late = () => report({ type: 'text.delta', text: 'stale ' });
      markEntered();
      return new Promise(() => {});
    };
    const task = await started.app.service.submitWork(principal, {
      objective: 'cancel hung adapter', mode: 'cloud', requireApproval: true,
    });
    assert.ok(task.ok);
    await entered;
    await started.app.service.cancelTask(principal, task.value.taskId);
    await started.app.dependencies.scheduler.idle();
    const status = await started.app.service.task(principal, task.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'cancelled');
    late();
    assert.doesNotMatch(JSON.stringify(started.app.dependencies.events.replay(task.value.taskId, 0)), /stale/);
    agent.run = async () => ({ ok: true, summary: 'done' });
    // The abandoned adapter may still be writing to this conversation's workspace,
    // so the supervisor quarantines it and the next run there is refused at
    // submit, not accepted and failed later.
    const next = await started.app.service.submitWork(principal, {
      objective: 'next', conversationId: task.value.conversationId, mode: 'cloud', requireApproval: true,
    });
    assert.equal(next.ok, false);
    assert.equal(next.ok === false && next.code, 'workspace_denied');

    // A different conversation has its own directory and is unaffected.
    const elsewhere = await started.app.service.submitWork(principal, {
      objective: 'elsewhere', mode: 'cloud', requireApproval: true,
    });
    assert.ok(elsewhere.ok);
    await started.app.service.cancelTask(principal, elsewhere.value.taskId);
  } finally {
    await started.close();
  }
});

test('late reports and cleanup cannot touch a resumed generation', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let stopOld: (() => void) | undefined;
    let currentSignal: AbortSignal | undefined;
    let finishCurrent: (() => void) | undefined;
    agent.run = async ({ signal }, report) => {
      if (!stopOld) {
        report({ type: 'text.delta', text: 'previous output ' });
        report({ type: 'step.completed', stepId: 'first', title: 'First' });
        await new Promise<void>(resolve => {
          stopOld = () => {
            report({ type: 'text.replace', text: 'stale output' });
            resolve();
          };
        });
      } else {
        currentSignal = signal;
        report({ type: 'text.delta', text: 'current output' });
        await new Promise<void>(resolve => { finishCurrent = resolve; });
      }
      return { ok: true, summary: 'done' };
    };
    const task = await started.app.service.submitWork(principal, {
      objective: 'resume a stalled generation', mode: 'cloud', requireApproval: true,
    });
    assert.ok(task.ok);
    const { taskId, generation, conversationId } = task.value;
    const finishOld = await waitFor(async () => stopOld);
    assert.equal((await deps.tasks.get(taskId))?.checkpoint.text, 'previous output ');
    deps.clock.now = () => new Date(Date.now() + 60_000);
    const resumed = await started.app.service.resumeTask(principal, taskId, generation);
    assert.ok(resumed.ok && resumed.value.outcome === 'accepted');
    const finish = await waitFor(async () => finishCurrent);
    assert.equal((await deps.tasks.get(taskId))?.checkpoint.text, '');
    const replay = deps.events.replay(taskId, 0).events.filter(event => event.type === 'text.delta' || event.type === 'text.replace');
    assert.deepEqual(replay.map(event => [event.type, event.payload]), [
      ['text.delta', { text: 'previous output ' }],
      ['text.replace', { text: '' }],
      ['text.delta', { text: 'current ' }],
    ]);
    finishOld();
    await waitFor(async () => deps.scheduler.active() === 1 || null);
    assert.doesNotMatch(JSON.stringify(deps.events.replay(taskId, 0)), /stale/);
    await started.app.service.cancelTask(principal, taskId);
    assert.equal(currentSignal?.aborted, true);
    finish();
    await deps.scheduler.idle();
    const conversation = await started.app.service.conversation(principal, conversationId);
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.at(-1)?.text, 'current output');
  } finally {
    await started.close();
  }
});

test('failed transcript and notification writes do not strand a settled run', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const append = deps.conversations.appendMessage;
    let publishedBeforeAppend = false;
    let notificationAttempted = false;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    agent.run = async (_request, report) => {
      deps.conversations.appendMessage = async () => {
        const [task] = await deps.tasks.listByOwner(principal.ownerId);
        publishedBeforeAppend = !!task && deps.events.replay(task.taskId, 0).events.at(-1)?.type === 'task.completed';
        throw new Error('write unavailable');
      };
      report({ type: 'text.delta', text: 'result' });
      return { ok: true, summary: 'done' };
    };
    deps.notifications.record = async () => {
      notificationAttempted = true;
      throw new Error('write unavailable');
    };
    const submit = (conversationId?: string) => started.app.service.submitWork(principal, {
      objective: 'test settlement', mode: 'cloud', requireApproval: true, ...(conversationId ? { conversationId } : {}),
    });
    const task = await submit();
    assert.ok(task.ok);
    await deps.scheduler.idle();
    assert.ok(publishedBeforeAppend && notificationAttempted);
    assert.ok(deps.audit.list().some(entry => entry.action === 'work.completed'));
    deps.conversations.appendMessage = append;
    assert.ok((await submit(task.value.conversationId)).ok);
    await deps.scheduler.idle();
  } finally {
    await started.close();
  }
});
