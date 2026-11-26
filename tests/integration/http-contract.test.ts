import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES } from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import {
  OWNER_ID,
  OWNER_TOKEN,
  failingProvider,
  fakeProvider,
  slowProvider,
  startTestApp,
  taskRecord,
  waitFor,
} from '../helpers.js';

/**
 * The cross-repository contract harness.
 *
 * Coderax (web) and CoderaxCLI are not in this repository, so this suite is the
 * closest executable proof that the published contract works over a real socket
 * for both of them: the engine's real HTTP server on one side and the shared SDK
 * on the other. It covers authentication, negotiation, chat, Work, streaming,
 * replay, cancellation, resume/retry, permissions, memory, scheduling,
 * notifications, artifacts and the read models. A capability that is reported
 * unavailable by the handshake is asserted to be unavailable rather than
 * requested speculatively.
 */

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('owner authentication and version negotiation are enforced over HTTP', async () => {
  const started = await startTestApp();
  try {
    const anonymous = await fetch(`${started.url}/v1/handshake`);
    assert.equal(anonymous.status, 200);
    const handshakeBody = (await anonymous.json()) as { contractVersion: string };
    assert.equal(handshakeBody.contractVersion, '1.1.0');

    const missingToken = await fetch(`${started.url}/v1/tasks`);
    assert.equal(missingToken.status, 401);
    assert.equal(
      ((await missingToken.json()) as { code: string }).code,
      'unauthorized',
    );

    const wrongToken = await fetch(`${started.url}/v1/tasks`, {
      headers: { authorization: 'Bearer not-the-owner-token-000000000' },
    });
    assert.equal(wrongToken.status, 401);

    const api = client(started.url);
    const handshake = await api.negotiate();
    assert.equal(handshake.engineName, 'coderax-workflow-engine');
    assert.equal(handshake.eventSchemaVersion, 1);
    assert.equal(handshake.chatStreamSchemaVersion, 1);
    assert.deepEqual(
      handshake.operations.map((operation) => operation.operationId).sort(),
      ROUTES.map((route) => route.operationId).sort(),
    );
    assert.equal(handshake.capabilities.scheduling.state, 'available');
    assert.equal(handshake.capabilities.artifacts.state, 'available');
    assert.equal(handshake.capabilities.idempotency.state, 'available');
    assert.equal(handshake.capabilities.rag.state, 'unsupported');
    assert.equal(handshake.capabilities.multimodal.state, 'available');
    assert.equal(handshake.capabilities.multiAgent.state, 'unsupported');
  } finally {
    await started.close();
  }
});

test('Chat answers JSON and typed SSE frames through the same SDK', async () => {
  const started = await startTestApp({ provider: fakeProvider({ text: 'Streamed answer.' }) });
  try {
    const api = client(started.url);
    const reply = await api.chat({ message: 'Say something.', mode: 'cloud', agent: 'coderax' });
    assert.equal(reply.text, 'Streamed answer.');
    assert.equal(reply.conversationId.length > 0, true);

    const frames = [];
    for await (const frame of api.chatStream({
      message: 'Say something again.',
      mode: 'cloud',
      agent: 'coderax',
    })) {
      frames.push(frame);
    }
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.type, 'chat.delta');
    const completed = frames[1];
    assert.equal(completed?.type, 'chat.completed');
    assert.equal(
      completed?.type === 'chat.completed' ? completed.reply.text : undefined,
      'Streamed answer.',
    );
  } finally {
    await started.close();
  }
});

test('an idempotent submission returns one task, one transcript and one notification', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const request = {
      objective: 'Prepare the release checklist',
      mode: 'cloud' as const,
      agent: 'coderax' as const,
      requireApproval: true,
      idempotencyKey: 'idempotent-http-0001',
    };
    const first = await api.submitWork(request);
    const second = await api.submitWork({ ...request, objective: 'A different objective' });
    assert.equal(second.taskId, first.taskId, 'the replay must not create a second task');

    const completed = await waitFor(async () => {
      const current = await api.task(first.taskId);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(completed.generation, 1);

    const tasks = await api.tasks({ state: 'completed' });
    assert.equal(tasks.total, 1);
    assert.equal(tasks.tasks[0]?.taskId, first.taskId);
    assert.equal(tasks.tasks[0]?.objective, 'Prepare the release checklist');

    const conversation = await api.conversation(first.conversationId);
    assert.equal(conversation.messages.length, 2);

    const notifications = await api.notifications();
    assert.equal(notifications.unread, 1);
    const marked = await api.markNotificationsRead([first.taskId]);
    assert.equal(marked.unread, 0);
    assert.equal(marked.notifications[0]?.read, true);
  } finally {
    await started.close();
  }
});

test('concurrent duplicate submissions create one task and charge the budget once', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const request = {
      objective: 'Submit the same release job twice',
      mode: 'cloud' as const,
      agent: 'coderax' as const,
      requireApproval: true,
      idempotencyKey: 'idempotent-http-0002',
    };
    const [left, right] = await Promise.all([api.submitWork(request), api.submitWork(request)]);
    assert.equal(left.taskId, right.taskId, 'both callers must see the same task');
    assert.equal(left.conversationId, right.conversationId);

    await waitFor(async () => {
      const current = await api.task(left.taskId);
      return current.state === 'completed' ? current : null;
    });
    const conversation = await api.conversation(left.conversationId);
    assert.equal(conversation.messages.length, 2, 'the loser must not write a transcript');
    const charged = started.app.dependencies.budget.snapshot(OWNER_ID, new Date()).requests;
    assert.ok(charged >= 1, 'the completed run must charge the routed model calls');
    await api.submitWork(request);
    assert.equal(
      started.app.dependencies.budget.snapshot(OWNER_ID, new Date()).requests,
      charged,
      'the idempotent replay must not charge again',
    );
  } finally {
    await started.close();
  }
});

test('Work streams, replays from a cursor and retries as a new generation', async () => {
  const started = await startTestApp({ provider: failingProvider(1) });
  try {
    const api = client(started.url);
    const accepted = await api.submitWork({
      objective: 'Retryable HTTP work',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    const failed = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'failed' ? current : null;
    });
    assert.equal(failed.failure?.code, 'provider_error');

    const retried = await api.retry(accepted.taskId, failed.generation);
    assert.equal(retried.outcome, 'accepted');
    assert.equal(retried.generation, 2);

    await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });

    const stream = await api.openEvents(accepted.taskId, { after: 0 });
    assert.equal(stream.truncated, false);
    const seqs: number[] = [];
    let sawCompleted = false;
    for await (const event of stream.events) {
      seqs.push(event.seq);
      if (event.type === 'task.completed') {
        sawCompleted = true;
        break;
      }
    }
    assert.equal(sawCompleted, true);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
    assert.equal(new Set(seqs).size, seqs.length);

    const replay = await api.openEvents(accepted.taskId, { after: 2 });
    const first = await replay.events.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.seq, 3);

    const resumed = await api.openEvents(accepted.taskId, { lastEventId: 2 });
    const resumedFirst = await resumed.events.next();
    assert.equal(resumedFirst.value?.seq, 3);
  } finally {
    await started.close();
  }
});

test('cancellation is durable and terminal tasks refuse resume and retry', async () => {
  const started = await startTestApp({ provider: slowProvider(60_000) });
  try {
    const api = client(started.url);
    const accepted = await api.submitWork({
      objective: 'Long running HTTP work',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'running' ? current : null;
    });

    const cancelled = await api.cancel(accepted.taskId, 'owner cancelled');
    assert.equal(cancelled.outcome, 'accepted');
    const settled = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'cancelled' ? current : null;
    });
    assert.equal(settled.cancelRequested, true);

    const resumed = await api.resume(accepted.taskId, settled.generation);
    assert.equal(resumed.outcome, 'already_terminal');
    const retried = await api.retry(accepted.taskId, settled.generation);
    assert.equal(retried.outcome, 'already_terminal');
  } finally {
    await started.close();
  }
});

test('an interrupted durable task resumes over HTTP from its last checkpoint', async () => {
  const started = await startTestApp({ provider: fakeProvider({ text: 'Resumed result.' }) });
  try {
    const api = client(started.url);
    const seed = taskRecord({
      taskId: 'task_http_resume',
      conversationId: 'conv_http_resume',
      state: 'interrupted',
      runToken: null,
      generation: 1,
      mode: 'cloud',
      agent: 'coderax',
    });
    const created = await started.app.dependencies.tasks.create(seed);
    assert.equal(created.ok, true);

    const resumed = await api.resume(seed.taskId, 1);
    assert.equal(resumed.outcome, 'accepted');
    assert.equal(resumed.generation, 2);

    const completed = await waitFor(async () => {
      const current = await api.task(seed.taskId);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(completed.generation, 2);
    assert.ok(completed.result?.summary?.startsWith('Resumed result.'));
  } finally {
    await started.close();
  }
});

test('permission operations list, decide and refuse a second decision', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const accepted = await api.submitWork({
      objective: 'Permission HTTP work',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });

    // The engine's permission producer is internal to an adapter; the harness
    // seeds the same store the adapter uses so the HTTP operations are genuinely
    // exercised rather than mocked.
    const request = await started.app.dependencies.permissions.request({
      ownerId: OWNER_ID,
      taskId: accepted.taskId,
      agent: 'coderax',
      scope: 'workspace.read',
      description: 'Read the release notes',
      resource: 'release-notes.md',
    });

    const listed = await api.permissions(accepted.taskId);
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0]?.requestId, request.requestId);

    const pending = await api.pendingPermissions();
    assert.ok(pending.requests.some((entry) => entry.requestId === request.requestId));

    const decided = await api.decidePermission(accepted.taskId, {
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(decided.requests[0]?.decision, 'approved');

    const after = await api.pendingPermissions();
    assert.equal(
      after.requests.some((entry) => entry.requestId === request.requestId),
      false,
    );

    await assert.rejects(
      () =>
        api.decidePermission(accepted.taskId, {
          requestId: request.requestId,
          decision: 'denied',
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 409,
    );
  } finally {
    await started.close();
  }
});

test('memory is written and read per data mode', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const stored = await api.putMemory({ key: 'release', value: 'v1.1.0', mode: 'private' });
    assert.equal(stored.key, 'release');

    const privateMemory = await api.memory('private');
    assert.ok(privateMemory.entries.some((entry) => entry.key === 'release'));
    const cloudMemory = await api.memory('cloud');
    assert.equal(cloudMemory.entries.some((entry) => entry.key === 'release'), false);
  } finally {
    await started.close();
  }
});

test('a durable schedule fires one Work task and cannot be cancelled after it settled', async () => {
  const started = await startTestApp({
    provider: fakeProvider(),
    config: { schedules: { enabled: true, tickIntervalMs: 100, tickBatch: 10 } },
  });
  try {
    const api = client(started.url);
    const schedule = await api.createSchedule({
      objective: 'Scheduled HTTP verification',
      runAt: new Date(Date.now() + 50).toISOString(),
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    assert.equal(schedule.state, 'scheduled');

    const submitted = await waitFor(async () => {
      const current = await api.schedule(schedule.scheduleId);
      return current.state === 'submitted' ? current : null;
    });
    assert.ok(submitted.lastTaskId);

    const completed = await waitFor(async () => {
      const current = await api.task(submitted.lastTaskId as string);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(completed.state, 'completed');

    const cancelled = await api.cancelSchedule(schedule.scheduleId);
    assert.equal(cancelled.outcome, 'already_terminal');

    const schedules = await api.schedules();
    assert.equal(schedules.schedules.length, 1);
  } finally {
    await started.close();
  }
});

test('artifact bytes are stored, listed and verified by digest', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const accepted = await api.submitWork({
      objective: 'Artifact HTTP work',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });
    await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });

    const content = Buffer.from('artifact bytes that must round-trip\n', 'utf8');
    const record = await api.uploadArtifact(accepted.taskId, {
      path: 'notes/release.txt',
      mediaType: 'text/plain',
      contentBase64: content.toString('base64'),
    });
    assert.equal(record.bytes, content.length);
    assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);

    const listed = await api.artifacts(accepted.taskId);
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0]?.artifactId, record.artifactId);

    const metadata = await api.artifact(record.artifactId);
    assert.equal(metadata.digest, record.digest);

    const fetched = await api.artifactContent(record.artifactId);
    assert.equal(fetched.digest, record.digest);
    assert.equal(Buffer.from(fetched.contentBase64, 'base64').toString('utf8'), content.toString('utf8'));

    await assert.rejects(
      () => api.artifact('art_missing'),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );
    await assert.rejects(
      () =>
        api.uploadArtifact(accepted.taskId, {
          path: '../escape.txt',
          mediaType: 'text/plain',
          contentBase64: 'aGk=',
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 400,
    );
  } finally {
    await started.close();
  }
});
