import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStatus } from '@coderax/contracts';
import { OWNER_TOKEN, slowGateway, startTestApp, waitFor } from '../helpers.js';

/**
 * Adversarial execution.
 *
 * The adapter is another process's code: it can return a malformed outcome, keep
 * reporting after it was cancelled, emit enormous text, or resolve successfully
 * after the owner stopped it. None of that may leave a task running forever, apply
 * a stale result, or violate the status contract.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };
const TERMINAL = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.interrupted']);

test('malformed adapter outcomes become readable terminal protocol failures', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    for (const outcome of [
      {},
      null,
      undefined,
      { ok: false, code: 'cancelled' },
      ...['', 'x'.repeat(61)].map((code) => ({ ok: false, code, detail: 'failed', retryable: false })),
    ]) {
      agent.run = async () => outcome as never;
      const submitted = await started.app.service.submitWork(principal, {
        objective: 'malformed adapter',
        mode: 'cloud',
        requireApproval: true,
      });
      assert.ok(submitted.ok);
      await started.app.dependencies.scheduler.idle();

      const response = await fetch(`${started.url}/v1/work/${submitted.value.taskId}`, {
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      });
      assert.equal(response.status, 200);
      const status = TaskStatus.parse(await response.json());
      assert.equal(status.state, 'failed');
      assert.equal(status.failure?.code, 'protocol_error');
    }
  } finally {
    await started.close();
  }
});

test('an adapter cannot exceed the status contract with an enormous summary', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({ ok: true, summary: 'z'.repeat(300_000) });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'oversized result',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'completed');
    assert.ok((status.value.result?.summary ?? '').length <= 20_000);
    assert.equal(TaskStatus.safeParse(status.value).success, true);
  } finally {
    await started.close();
  }
});

test('an adapter that resolves successfully after cancellation is still cancelled once', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    agent.run = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: true, summary: 'too late to matter' };
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'cancel then resolve',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'running' ? true : null;
    });
    await started.app.service.cancelTask(principal, submitted.value.taskId, 'owner stopped it');
    await deps.scheduler.idle();

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'cancelled');
    assert.equal(status.value.result, undefined);
    const terminals = deps.events
      .replay(submitted.value.taskId, 0)
      .events.filter((event) => TERMINAL.has(event.type));
    assert.deepEqual(terminals.map((event) => event.type), ['task.cancelled']);
  } finally {
    await started.close();
  }
});

test('a report delivered after settlement is ignored', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let late: (() => void) | undefined;
    agent.run = async (_request, report) => {
      late = () => report({ type: 'text.delta', text: 'STALE REPORT' });
      return { ok: true, summary: 'settled' };
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'late report',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await deps.scheduler.idle();
    late?.();
    assert.doesNotMatch(
      JSON.stringify(deps.events.replay(submitted.value.taskId, 0)),
      /STALE REPORT/,
    );
  } finally {
    await started.close();
  }
});

test('two concurrent submissions for one conversation cannot both start', async () => {
  const started = await startTestApp({ gateway: slowGateway(60_000) });
  try {
    const principalScope = principal;
    const first = await started.app.service.submitWork(principalScope, {
      objective: 'first concurrent request',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(first.ok);
    const [a, b] = await Promise.all([
      started.app.service.submitWork(principalScope, {
        objective: 'second concurrent request',
        conversationId: first.value.conversationId,
        mode: 'cloud',
        requireApproval: true,
      }),
      started.app.service.submitWork(principalScope, {
        objective: 'third concurrent request',
        conversationId: first.value.conversationId,
        mode: 'cloud',
        requireApproval: true,
      }),
    ]);
    const accepted = [a, b].filter((result) => result.ok);
    assert.equal(accepted.length, 0, 'the live lease must refuse both later submissions');
    for (const result of [a, b]) {
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.code, 'busy');
    }
    await started.app.service.cancelTask(principal, first.value.taskId, 'test cleanup');
  } finally {
    await started.close();
  }
});

test('a traversal-shaped task id is a typed not-found, never a path escape', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(
      `${started.url}/v1/work/..%2F..%2Fetc%2Fpasswd`,
      { headers: { authorization: `Bearer ${OWNER_TOKEN}` } },
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string; type: string };
    assert.equal(body.code, 'not_found');
    assert.match(body.type, /problems\/not_found$/);
  } finally {
    await started.close();
  }
});
