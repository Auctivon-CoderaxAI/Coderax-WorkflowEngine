import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createMongoConnector, MongoUnavailableError } from '../../src/persistence/mongo-connect.js';
import { validateWorkspaceRoots } from '../../src/execution/workspace.js';
import {
  OWNER_TOKEN,
  createWorkspaces,
  fakeGateway,
  startTestApp,
} from '../helpers.js';

/**
 * Permanent regression tests for the security findings reported against this
 * engine. Each test names the finding it locks down; removing the control must
 * fail this file, not merely a review.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };
const other = { ownerId: 'someone-else', isOwner: true as const };

const CREDENTIALS =
  'provider failed for sk-abcdefghijklmnop at /home/owner/.ssh/id_ed25519?token=s3cretvalue';

test('SEC-1: adapter failure text is redacted before storage, events and status', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({
      ok: false,
      code: 'provider_error',
      detail: CREDENTIALS,
      retryable: false,
    });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'exercise failure redaction',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const stored = await started.app.dependencies.tasks.get(submitted.value.taskId);
    const storedText = JSON.stringify(stored);
    assert.doesNotMatch(storedText, /abcdefghijklmnop|owner\/\.ssh|s3cretvalue/);
    assert.match(storedText, /\[redacted-key\]/);

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.doesNotMatch(JSON.stringify(status.value), /abcdefghijklmnop|s3cretvalue/);
    const replay = started.app.dependencies.events.replay(submitted.value.taskId, 0);
    assert.doesNotMatch(JSON.stringify(replay), /abcdefghijklmnop|s3cretvalue/);
  } finally {
    await started.close();
  }
});

test('SEC-1b: Chat output is redacted before storage and before it is returned', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({ ok: true, summary: `answer: ${CREDENTIALS}` });
    const reply = await started.app.service.chat(principal, {
      message: 'hello',
      agent: 'coderax',
      mode: 'cloud',
    });
    assert.ok(reply.ok);
    assert.doesNotMatch(reply.value.text, /abcdefghijklmnop|s3cretvalue/);
    const conversation = await started.app.service.conversation(
      principal,
      reply.value.conversationId,
    );
    assert.ok(conversation.ok);
    const assistant = conversation.value.messages.at(-1);
    assert.equal(assistant?.role, 'assistant');
    assert.doesNotMatch(assistant.text, /abcdefghijklmnop|s3cretvalue/);
  } finally {
    await started.close();
  }
});

test('SEC-2: no credential-shaped value is committed to source', () => {
  const patterns = [
    /(?:CODERAX_OWNER_TOKEN|CODERAX_INFERENCE_KEY)\s*=\s*[A-Za-z0-9]/,
    /\bsk-[A-Za-z0-9]{20,}/,
    /\bghp_[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const offenders: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(absolute, 'utf8');
        if (patterns.some((pattern) => pattern.test(text))) {
          offenders.push(path.relative(root, absolute));
        }
      }
    }
  }
  walk(path.join(root, 'src'));
  assert.deepEqual(offenders, []);
});

test('SEC-3: a problem body never echoes the owner token or an internal path', async () => {
  const started = await startTestApp();
  try {
    const wrong = await fetch(`${started.url}/v1/agents`, {
      headers: { authorization: 'Bearer not-the-owner-token-but-long-enough' },
    });
    assert.equal(wrong.status, 401);
    const wrongBody = await wrong.text();
    assert.doesNotMatch(wrongBody, new RegExp(OWNER_TOKEN));
    assert.doesNotMatch(wrongBody, /\/home\/|\/srv\/|[A-Za-z]:\\/);

    const unknown = await fetch(`${started.url}/v1/nope`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(await unknown.text(), new RegExp(OWNER_TOKEN));
  } finally {
    await started.close();
  }
});

test('SEC-4: a foreign identifier reports not-found and reveals no existence', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'owner scoped',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    for (const result of [
      await started.app.service.task(other, submitted.value.taskId),
      await started.app.service.conversation(other, submitted.value.conversationId),
      await started.app.service.events(other, submitted.value.taskId, 0),
      await started.app.service.permissions(other, submitted.value.taskId),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.code, 'not_found');
      assert.doesNotMatch(result.ok === false ? result.detail : '', /owner-test|exists/);
    }
  } finally {
    await started.close();
  }
});

test('SEC-5: overlapping, nested and symlinked workspace roots are refused', async () => {
  const workspace = createWorkspaces();
  try {
    const nested = path.join(workspace.privateRoot, 'cloud');
    mkdirSync(nested);
    const nestedResult = await validateWorkspaceRoots({
      private: workspace.privateRoot,
      cloud: nested,
    });
    assert.equal(nestedResult.ok, false);

    const link = path.join(workspace.root, 'cloud-link');
    symlinkSync(workspace.privateRoot, link, 'dir');
    const symlinkResult = await validateWorkspaceRoots({
      private: workspace.privateRoot,
      cloud: link,
    });
    assert.equal(symlinkResult.ok, false);

    const disjoint = await validateWorkspaceRoots({
      private: workspace.privateRoot,
      cloud: workspace.cloudRoot,
    });
    assert.equal(disjoint.ok, true);
  } finally {
    workspace.cleanup();
  }
});

test('SEC-6: an oversized request body is a typed 413, not a dropped socket', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/work`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: `{"objective":"${'x'.repeat(1_100_000)}"}`,
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { type: string; status: number; retryable: boolean };
    assert.equal(body.status, 413);
    assert.equal(body.retryable, false);
  } finally {
    await started.close();
  }
});

test('SEC-7: a remote MongoDB without TLS is refused before connecting', async () => {
  const observed = { options: [] as Array<Record<string, unknown>>, connected: 0 };
  class FakeClient {
    readonly options: Record<string, unknown>;
    constructor(_uri: string, passed: Record<string, unknown> = {}) {
      this.options = {
        tls: false,
        hosts: [{ host: 'db.example.com' }],
        ...passed,
      };
      observed.options.push(this.options);
    }
    async connect(): Promise<void> {
      observed.connected += 1;
    }
    db(): unknown {
      return { command: async () => ({ ok: 1 }), collection: () => ({}) };
    }
    async close(): Promise<void> {}
  }
  const connector = createMongoConnector(
    (async () => ({ MongoClient: FakeClient })) as never,
  );
  await assert.rejects(
    connector({ uri: 'mongodb://db.example.com/coderax', database: 'coderax' }),
    (error: unknown) =>
      error instanceof MongoUnavailableError && /TLS/.test(error.message),
  );
  assert.equal(observed.connected, 0);
});

test('SEC-7b: a loopback MongoDB without TLS must use a direct connection', async () => {
  const observed = { options: [] as Array<Record<string, unknown>>, connected: 0 };
  class FakeClient {
    readonly options: Record<string, unknown>;
    constructor(_uri: string, passed: Record<string, unknown> = {}) {
      this.options = {
        tls: false,
        hosts: [{ host: '127.0.0.1' }],
        ...passed,
      };
      observed.options.push(this.options);
    }
    async connect(): Promise<void> {
      observed.connected += 1;
    }
    db(): unknown {
      return { command: async () => ({ ok: 1 }), collection: () => ({}) };
    }
    async close(): Promise<void> {}
  }
  const connector = createMongoConnector(
    (async () => ({ MongoClient: FakeClient })) as never,
  );
  const database = await connector({
    uri: 'mongodb://127.0.0.1:27017/coderax',
    database: 'coderax',
  });
  assert.equal(observed.connected, 1);
  assert.equal(observed.options.length, 2);
  assert.equal(observed.options[1]?.directConnection, true);
  await database.close();
});

test('SEC-8: an adapter throw is a user-safe failure with no stack or path', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => {
      throw new Error(`boom at ${process.cwd()}/secret sk-abcdefghijklmnop`);
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'hostile adapter',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'failed');
    assert.equal(status.value.failure?.code, 'provider_error');
    assert.equal(status.value.failure?.detail, 'The agent failed unexpectedly.');
    assert.doesNotMatch(JSON.stringify(status.value), /secret|process\.cwd|Error:/);
  } finally {
    await started.close();
  }
});

test('SEC-9: an external agent never gains memory, credentials or conversations', async () => {
  const started = await startTestApp();
  try {
    for (const id of ['opencode', 'freebuff'] as const) {
      const agent = started.app.service.agents().agents.find((entry) => entry.id === id);
      assert.ok(agent);
      assert.deepEqual(agent.isolation, {
        workspace: 'isolated',
        memory: 'none',
        credentials: 'none',
        conversations: 'none',
      });
    }
  } finally {
    await started.close();
  }
});

test('SEC-10: a foreign conversation id cannot inject a turn or a task', async () => {
  const started = await startTestApp({ gateway: fakeGateway() });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'original owner objective',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const injected = await started.app.service.submitWork(other, {
      objective: 'injected objective',
      conversationId: submitted.value.conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(injected.ok, false);
    assert.equal(injected.ok === false && injected.code, 'conflict');
    const messages = await started.app.dependencies.conversations.messages({
      ownerId: principal.ownerId,
      conversationId: submitted.value.conversationId,
      mode: 'cloud',
    });
    assert.equal((messages ?? []).filter((message) => message.text === 'injected objective').length, 0);
    assert.equal((await started.app.dependencies.tasks.listByOwner(other.ownerId)).length, 0);
  } finally {
    await started.close();
  }
});
