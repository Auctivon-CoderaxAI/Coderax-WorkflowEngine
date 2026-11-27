import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES, CONTRACT_VERSION } from '@coderax/contracts';
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
    assert.equal(handshakeBody.contractVersion, CONTRACT_VERSION);

    const missingToken = await fetch(`${started.url}/v1/work/task_auth_probe`);
    assert.equal(missingToken.status, 401);
    assert.equal(
      ((await missingToken.json()) as { code: string }).code,
      'unauthorized',
    );

    const wrongToken = await fetch(`${started.url}/v1/work/task_auth_probe`, {
      headers: { authorization: 'Bearer not-the-owner-token-000000000' },
    });
    assert.equal(wrongToken.status, 401);

    const api = client(started.url);
    const handshake = await api.handshake({ contract: CONTRACT_VERSION });
    assert.equal(handshake.server.name, 'coderax-workflow-engine');
    assert.equal(handshake.eventSchemaVersion, 1);
    assert.equal(handshake.chatStreamVersion, 1);
    assert.deepEqual(
      handshake.operations.map((operation) => operation.operationId).sort(),
      ROUTES.map((route) => route.operationId).sort(),
    );
    assert.equal(handshake.capabilities.schedules, true);
    assert.equal(handshake.capabilities.artifacts, true);
    assert.equal(handshake.capabilities.idempotentSubmission, false);
    assert.equal(handshake.capabilities.paidModels, false);
    assert.ok(handshake.operations.some((entry) => entry.operationId === 'uploadMedia'));
    assert.ok(handshake.operations.some((entry) => entry.operationId === 'submitTeam'));
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

test('a Work submission produces one task, transcript and notification', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const accepted = await api.submitWork({
      objective: 'Prepare the release checklist',
      mode: 'cloud',
      agent: 'coderax',
      requireApproval: true,
    });

    const completed = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });

    assert.equal(completed.generation, 1);

    const tasks = await started.app.dependencies.tasks.listByOwner(OWNER_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, accepted.taskId);

    const conversation = await api.conversation(accepted.conversationId);
    assert.equal(conversation.messages.length, 2);

    const notifications = await api.notifications();
    assert.equal(notifications.unread, 1);

    const marked = await api.markNotificationsRead();
    assert.equal(marked.unread, 0);
    assert.equal(marked.notifications[0]?.read, true);
  } finally {
    await started.close();
  }
});

test('unsupported Work idempotency fields are rejected without charging inference', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const handshake = await api.handshake();
    assert.equal(handshake.capabilities.idempotentSubmission, false);

    const before = await started.app.dependencies.budget.snapshot(OWNER_ID, new Date());

    const response = await fetch(`${started.url}/v1/work`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        objective: 'Unsupported submission field',
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
        idempotencyKey: 'test-submission-key',
      }),
    });

    assert.equal(response.status, 400);

    const after = await started.app.dependencies.budget.snapshot(OWNER_ID, new Date());
    assert.equal(after.requests, before.requests);
    assert.equal((await started.app.dependencies.tasks.listByOwner(OWNER_ID)).length, 0);
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

    const stream = api.events(accepted.taskId, { after: 0 });

    const seqs: number[] = [];
    let sawCompleted = false;
    for await (const event of stream) {
      seqs.push(event.seq);
      if (event.type === 'task.completed') {
        sawCompleted = true;
        break;
      }
    }
    assert.equal(sawCompleted, true);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
    assert.equal(new Set(seqs).size, seqs.length);

    const replay = api.events(accepted.taskId, { after: 2 });
    const first = await replay.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.seq, 3);

    await replay.return(undefined);

    const resumedClient = new CoderaxClient({
      baseUrl: started.url,
      token: OWNER_TOKEN,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Last-Event-ID', '2');
        return fetch(input, { ...init, headers });
      },
    });
    const resumed = resumedClient.events(accepted.taskId);
    const resumedFirst = await resumed.next();
    assert.equal(resumedFirst.value?.seq, 3);
    await resumed.return(undefined);
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
    const task = taskRecord({
      taskId: 'task_permission_http',
      state: 'awaiting_approval',
      runToken: null,
    });
    assert.equal((await started.app.dependencies.tasks.create(task)).ok, true);

    const request = await started.app.dependencies.permissions.request({
      ownerId: OWNER_ID,
      taskId: task.taskId,
      agent: 'coderax',
      scope: 'workspace.read',
      description: 'Read the release notes',
      resource: 'release-notes.md',
    });

    const listed = await api.permissions(task.taskId);
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0]?.requestId, request.requestId);
    assert.equal(listed.requests[0]?.decision, 'pending');

    const decided = await api.decidePermission(task.taskId, {
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(decided.requests[0]?.decision, 'approved');

    const after = await api.permissions(task.taskId);
    assert.equal(after.requests.some((entry) => entry.decision === 'pending'), false);

    await assert.rejects(
      () => api.decidePermission(task.taskId, {
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
    await started.app.dependencies.memory.put({
      ownerId: OWNER_ID,
      tenantId: null,
      key: 'release',
      value: 'v1.3.0',
      mode: 'private',
    });


    const privateMemory = await api.memory('private');
    assert.ok(privateMemory.entries.some((entry) => entry.key === 'release'));
    const cloudMemory = await api.memory('cloud');
    assert.equal(cloudMemory.entries.some((entry) => entry.key === 'release'), false);
  } finally {
    await started.close();
  }
});

test('a durable schedule fires one Work task and records its execution', async () => {
  const started = await startTestApp({
    provider: fakeProvider(),
    config: { schedules: { enabled: true, tickMs: 100, batchSize: 10 } },
  });
  try {
    const api = client(started.url);
    const schedule = await api.createSchedule({
      name: 'HTTP verification',
      objective: 'Scheduled HTTP verification',
      timing: {
        kind: 'once',
        at: new Date(Date.now() + 1000).toISOString(),
      },
      mode: 'cloud',
      agent: 'coderax',
    });

    assert.equal(schedule.state, 'active');

    const receipt = await waitFor(async () => {
      const history = await api.scheduleExecutions(schedule.scheduleId);
      return history.executions.find((entry) => entry.taskId !== null) ?? null;
    });

    assert.ok(receipt.taskId);

    const completed = await waitFor(async () => {
      const current = await api.task(receipt.taskId!);
      return current.state === 'completed' ? current : null;
    });

    assert.equal(completed.state, 'completed');

    await waitFor(async () => {
      const current = await api.schedule(schedule.scheduleId);
      return current.state === 'exhausted' ? current : null;
    });

    const cancelled = await api.cancelSchedule(schedule.scheduleId);
    assert.equal(cancelled.outcome, 'already_terminal');

    const schedules = await api.schedules();
    assert.equal(schedules.schedules.length, 1);

    const history = await api.scheduleExecutions(schedule.scheduleId);
    assert.equal(history.executions.length, 1);
  } finally {
    await started.close();
  }
});

test('durable artifact versions are stored, listed and verified by sha256', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const content = Buffer.from('artifact bytes that must round-trip\n', 'utf8');
    const uploaded = await api.uploadArtifact({
      filename: 'release.txt',
      mediaType: 'text/plain',
      kind: 'document',
      mode: 'cloud',
      contentBase64: content.toString('base64'),
    });
    assert.equal(uploaded.artifact.bytes, content.length);
    assert.match(uploaded.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(uploaded.artifact.version, 1);

    const appended = await api.uploadArtifactVersion(uploaded.artifact.artifactId, {
      filename: 'release-v2.txt',
      mediaType: 'text/plain',
      kind: 'document',
      mode: 'cloud',
      contentBase64: Buffer.from('second version\n', 'utf8').toString('base64'),
    });
    assert.equal(appended.artifact.version, 2);
    assert.equal(appended.artifact.versions, 2);

    const listed = await api.artifacts({ mode: 'cloud' });
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0]?.artifactId, uploaded.artifact.artifactId);

    const metadata = await api.artifact(uploaded.artifact.artifactId, 'cloud');
    assert.equal(metadata.version, 2);
    const versions = await api.artifactVersions(uploaded.artifact.artifactId, 'cloud');
    assert.deepEqual(versions.versions.map((entry) => entry.version), [1, 2]);

    const fetched = await api.downloadArtifact(uploaded.artifact.artifactId, {
      mode: 'cloud',
      version: 1,
    });
    assert.equal(fetched.contentBase64, content.toString('base64'));

    await assert.rejects(
      () => api.artifact('art_missing', 'cloud'),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );
    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'active.html',
          mediaType: 'text/html' as never,
          mode: 'private',
          contentBase64: 'aGk=',
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 400,
    );
  } finally {
    await started.close();
  }
});
