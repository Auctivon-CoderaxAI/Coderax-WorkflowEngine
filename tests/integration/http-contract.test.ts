import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CoderaxApiError } from '@coderax/sdk';
import { CONTRACT_VERSION } from '@coderax/contracts';
import { clientFor, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

/**
 * The cross-repository harness.
 *
 * Every call is made over real HTTP by `@coderax/sdk`, the client Coderax and
 * CoderaxCLI consume. A route that only works when called in-process fails here,
 * and a response that drifts from the published schema fails at the client
 * boundary rather than in a UI.
 */

test('owner authentication gates every owner operation', async () => {
  const started = await startTestApp();
  try {
    const anonymous = await fetch(`${started.url}/v1/handshake`);
    assert.equal(anonymous.status, 401);
    const problem = (await anonymous.json()) as {
      code: string;
      status: number;
      requestId: string;
      retryable: boolean;
    };
    assert.equal(problem.code, 'unauthorized');
    assert.equal(problem.status, 401);
    assert.equal(problem.retryable, false);
    assert.match(problem.requestId, /^req_/);

    await assert.rejects(
      () => clientFor(started.url, 'wrong-token'.padEnd(40, 'x')).handshake(),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.status === 401 && error.code === 'unauthorized',
    );

    // Health and readiness stay public so a supervisor can probe without the token.
    assert.equal((await fetch(`${started.url}/v1/health`)).status, 200);
    assert.equal((await fetch(`${started.url}/v1/ready`)).status, 200);
  } finally {
    await started.close();
  }
});

test('contract negotiation and the capability handshake agree with the server', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  try {
    const exact = await client.handshake({ contract: CONTRACT_VERSION });
    assert.equal(exact.compatible, true);
    assert.equal(exact.negotiation, 'exact');

    const older = await client.handshake({ contract: '1.0.0' });
    assert.equal(older.compatible, true);
    assert.equal(older.negotiatedContractVersion, '1.0.0');
    assert.equal(older.negotiation, 'client_supported');

    // The fingerprint pins the catalogue, so a shared version string is not enough.
    assert.match(exact.contractFingerprint, /^sha256:[0-9a-f]{64}$/);
    const mismatched = await client.handshake({
      contract: CONTRACT_VERSION,
      fingerprint: `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(mismatched.compatible, false);
    assert.equal(mismatched.negotiation, 'fingerprint_mismatch');

    const ahead = await client.handshake({ contract: '1.3.0' });
    assert.equal(ahead.compatible, false);
    assert.equal(ahead.negotiation, 'client_ahead');
    assert.equal(ahead.negotiatedContractVersion, CONTRACT_VERSION);

    const foreign = await client.handshake({ contract: '2.0.0' });
    assert.equal(foreign.compatible, false);
    assert.equal(foreign.negotiation, 'unsupported_major');

    // The SDK checks three versioned surfaces plus operation coverage at once.
    const report = await client.compatibility();
    assert.deepEqual(report.problems, []);
    assert.equal(report.compatible, true);
    assert.equal(report.serverContractVersion, CONTRACT_VERSION);
    assert.equal(report.missingOperations.length, 0);
  } finally {
    await started.close();
  }
});

test('Chat, Work, read models, artifacts, permissions, notifications and memory work over HTTP', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  try {
    // Chat answers and persists the exchange.
    const reply = await client.chat({ message: 'Summarise the repository' });
    assert.equal(reply.agent, 'coderax');
    assert.ok(reply.text.startsWith('A verified result.'));

    const conversations = await client.conversations();
    assert.ok(
      conversations.conversations.some((entry) => entry.conversationId === reply.conversationId),
      'the chat conversation is missing from the read model',
    );
    const conversation = await client.conversation(reply.conversationId);
    assert.deepEqual(conversation.messages.map((message) => message.role), ['user', 'assistant']);

    // Work is durable: the submission returns before the run finishes.
    const accepted = await client.submitWork({ objective: 'Cross-repository harness task' });
    assert.equal(accepted.state, 'queued');
    assert.equal(accepted.eventsPath, `/v1/work/${accepted.taskId}/events`);

    const completed = await waitFor(async () => {
      const status = await client.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    assert.equal(completed.generation, 1);
    assert.equal(completed.cancelRequested, false);
    assert.ok(completed.result?.summary);
    assert.equal(completed.result?.artifacts.length, 1, 'the run transcript is not an artifact');

    // Task read model.
    const tasks = await client.tasks({ limit: 10 });
    assert.ok(tasks.tasks.some((entry) => entry.taskId === accepted.taskId));
    assert.equal((await client.tasks({ state: 'failed' })).tasks.length, 0);

    // Artifacts: the engine computed the digest over the stored bytes.
    const artifacts = await client.artifacts(accepted.taskId);
    const record = artifacts.artifacts[0];
    assert.ok(record);
    assert.equal(record.path, 'result.md');
    assert.equal(record.origin, 'engine');
    const content = await client.artifact(accepted.taskId, record.artifactId);
    assert.equal(content.encoding, 'utf8');
    assert.equal(
      `sha256:${createHash('sha256').update(content.content, 'utf8').digest('hex')}`,
      record.digest,
      'the reported digest does not match the stored bytes',
    );

    // An owner attachment is stored with an engine-computed digest too.
    const attached = await client.createArtifact(accepted.taskId, {
      path: 'notes.txt',
      mediaType: 'text/plain',
      encoding: 'utf8',
      content: 'owner note',
    });
    assert.equal(attached.origin, 'owner');
    assert.equal(attached.bytes, 10);
    assert.equal((await client.artifacts(accepted.taskId)).artifacts.length, 2);

    const binary = Buffer.from([0, 1, 2, 250, 251]).toString('base64');
    const stored = await client.createArtifact(accepted.taskId, {
      path: 'raw.bin',
      mediaType: 'application/octet-stream',
      encoding: 'base64',
      content: binary,
    });
    const read = await client.artifact(accepted.taskId, stored.artifactId);
    assert.equal(read.encoding, 'base64');
    assert.equal(read.content, binary);

    // Permissions: nothing was requested, and an unknown request is a 404 Problem.
    assert.deepEqual((await client.permissions(accepted.taskId)).requests, []);
    await assert.rejects(
      () => client.decidePermission(accepted.taskId, { requestId: 'req_missing', decision: 'approved' }),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );

    // Notifications are durable and individually addressable.
    const before = await client.notifications();
    assert.ok(before.unread >= 1);
    assert.equal(before.notifications.find((entry) => entry.taskId === accepted.taskId)?.read, false);
    const after = await client.markNotificationRead(accepted.taskId);
    assert.equal(after.unread, before.unread - 1);
    await assert.rejects(
      () => client.markNotificationRead('task_unknown'),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );

    // Memory is partitioned by data mode, not filtered by the caller.
    const written = await client.writeMemory({
      key: 'project.owner',
      value: 'the harness writes this note',
      mode: 'private',
    });
    assert.ok(written.entries.some((entry) => entry.key === 'project.owner'));
    assert.equal(
      (await client.memory('cloud')).entries.some((entry) => entry.key === 'project.owner'),
      false,
      'a private entry leaked into the cloud partition',
    );
    const found = await client.searchMemory({ q: 'harness', mode: 'private' });
    assert.equal(found.matches[0]?.key, 'project.owner');
    assert.deepEqual((await client.searchMemory({ q: 'harness', mode: 'cloud' })).matches, []);
    assert.deepEqual((await client.deleteMemory({ key: 'project.owner', mode: 'private' })).entries, []);
  } finally {
    await started.close();
  }
});

test('the router rejects a request that does not match the catalogue', async () => {
  const started = await startTestApp();
  const authorized = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };
  try {
    const missingObjective = await fetch(`${started.url}/v1/work`, {
      method: 'POST',
      headers: authorized,
      body: '{}',
    });
    assert.equal(missingObjective.status, 400);
    const problem = (await missingObjective.json()) as { code: string; detail: string };
    assert.equal(problem.code, 'validation_failed');
    assert.match(problem.detail, /objective/);

    const badQuery = await fetch(`${started.url}/v1/work?limit=0`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(badQuery.status, 400);

    const unknownOperation = await fetch(`${started.url}/v1/not-an-operation`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(unknownOperation.status, 404);

    const wrongMethod = await fetch(`${started.url}/v1/handshake`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(wrongMethod.status, 404);

    const oversized = await fetch(`${started.url}/v1/chat`, {
      method: 'POST',
      headers: authorized,
      body: JSON.stringify({ message: 'x'.repeat(1_048_577) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await started.close();
  }
});
