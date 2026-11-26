import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExternalAgentTransport } from '../../src/agents/adapters/external.js';
import { EngineConfigSchema } from '../../src/configuration/schema.js';
import { PROCESSING_OPERATIONS } from '../../src/models/policy.js';
import { fakeProvider, OWNER_TOKEN, startTestApp, testProviderPolicy } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * Identity of a conversation is owner + data mode + kind of work.
 *
 * Reusing a private conversation for cloud work would send the private
 * transcript to a hosted agent and write the cloud answer back into it.
 */
test('a conversation is never reused across data modes', async () => {
  const provider = fakeProvider();
  const policy = testProviderPolicy('free', {
    credentials: 'owner-managed',
    grants: PROCESSING_OPERATIONS.flatMap(operation => ([
      { operation, mode: 'cloud' as const, location: 'owner-region' as const },
      { operation, mode: 'private' as const, location: 'owner-region' as const },
    ])),
  });
  const started = await startTestApp({
    provider,
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [policy],
      },
    },
  });
  try {
    const chat = await started.app.service.chat(principal, {
      message: 'a private note',
      conversationId: 'conv_mode',
      mode: 'private',
      agent: 'coderax',
    });
    assert.equal(chat.ok, true);

    const crossed = await started.app.service.submitWork(principal, {
      objective: 'cloud work',
      conversationId: 'conv_mode',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.ok === false && crossed.code, 'conflict');

    const stillPrivate = await started.app.service.conversation(principal, 'conv_mode');
    assert.equal(stillPrivate.ok, true);
    assert.equal(stillPrivate.ok && stillPrivate.value.mode, 'private');
  } finally {
    await started.close();
  }
});

/**
 * An external agent declares `conversations: none`. Handing it prior turns would
 * quietly widen that isolation.
 */
test('an external agent is never given the conversation transcript', async () => {
  const seenHistories: number[] = [];
  const transport: ExternalAgentTransport = {
    probe: async () => undefined,
    run: async (request) => {
      seenHistories.push(request.history?.length ?? 0);
      return { ok: true, summary: 'external result' };
    },
  };
  const started = await startTestApp({
    externals: { opencode: transport },
    env: { OPENCODE_PASSWORD: 'test-password' },
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [testProviderPolicy(), testProviderPolicy('opencode')],
      },
      engines: {
        opencode: {
          enabled: true,
          baseURL: 'http://127.0.0.1:4096',
          model: 'local/model',
          passwordEnv: 'OPENCODE_PASSWORD',
        },
      },
    },
  });
  try {
    const first = await started.app.service.submitWork(principal, {
      objective: 'the earlier exchange',
      conversationId: 'conv_external',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(first.ok, true);
    await started.app.dependencies.scheduler.idle();

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'external follow-up',
      conversationId: 'conv_external',
      agent: 'opencode',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(submitted.ok, true);
    await started.app.dependencies.scheduler.idle();

    assert.equal(seenHistories.length, 1);
    assert.equal(seenHistories[0], 0, 'the external agent received no history');
    const status = await started.app.service.task(principal, submitted.ok ? submitted.value.taskId : '');
    assert.equal(status.ok && status.value.state, 'completed');
  } finally {
    await started.close();
  }
});

/**
 * Private execution needs an owner policy record that grants that exact
 * operation in private mode. The fixture policy is cloud-only, so a private run
 * is refused instead of falling back to a hosted endpoint or local inference.
 */
test('private execution is refused without an owner grant for the mode', async () => {
  const provider = fakeProvider();
  const started = await startTestApp({ provider });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'private work',
      mode: 'private',
      requireApproval: false,
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.ok === false && submitted.code, 'model_missing');
    await started.app.dependencies.scheduler.idle();
    assert.equal(provider.calls, 0, 'no hosted request was made for private work');

    const cloud = await started.app.service.submitWork(principal, {
      objective: 'cloud work',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(cloud.ok, true);
    await started.app.dependencies.scheduler.idle();
    assert.equal(provider.calls > 0, true, 'cloud work may use the hosted endpoint');
  } finally {
    await started.close();
  }
});

test('an inference endpoint that would leak a credential is refused at startup', () => {
  const base = {
    auth: { ownerId: 'owner-test' },
    workspaces: { privateRoot: '/tmp/private', cloudRoot: '/tmp/cloud' },
  };
  const cleartext = EngineConfigSchema.safeParse({
    ...base,
    models: {
      providers: [
        { id: 'remote', baseURL: 'http://api.example.com/v1', apiKeyEnv: 'REMOTE_KEY' },
      ],
    },
  });
  assert.equal(cleartext.success, false);

  const credentials = EngineConfigSchema.safeParse({
    ...base,
    models: {
      providers: [
        { id: 'remote', baseURL: 'https://user:pass@api.example.com/v1', apiKeyEnv: 'REMOTE_KEY' },
      ],
    },
  });
  assert.equal(credentials.success, false);

  const loopback = EngineConfigSchema.safeParse({
    ...base,
    models: {
      providers: [
        { id: 'local', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_KEY' },
      ],
    },
  });
  assert.equal(loopback.success, true, 'a loopback runtime needs no TLS');

  const secure = EngineConfigSchema.safeParse({
    ...base,
    models: {
      providers: [
        { id: 'remote', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'REMOTE_KEY' },
      ],
    },
  });
  assert.equal(secure.success, true);
});

/**
 * Provider output is written by someone else: it may contain a credential or an
 * owner path, and it reaches the transcript, the reply and the notification.
 */
test('provider text is scrubbed before it is stored, returned or notified', async () => {
  const secretText = 'leaked sk-abcdefghijklmnopqrstuvwx from /home/owner/project';
  const started = await startTestApp({ provider: fakeProvider({ text: secretText }) });
  try {
    const chat = await started.app.service.chat(principal, {
      message: 'show me',
      mode: 'cloud',
      agent: 'coderax',
    });
    assert.equal(chat.ok, true);
    if (!chat.ok) return;
    assert.doesNotMatch(chat.value.text, /sk-abcdefghijklmnopqrstuvwx/);
    assert.doesNotMatch(chat.value.text, /\/home\/owner/);

    const conversation = await started.app.service.conversation(
      principal,
      chat.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    const stored = JSON.stringify(conversation);
    assert.doesNotMatch(stored, /sk-abcdefghijklmnopqrstuvwx/);
    assert.doesNotMatch(stored, /\/home\/owner/);

    // A failing adapter's detail takes the same path into the task row and the
    // completion notification.
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({
      ok: false,
      code: 'provider_error',
      detail: `upstream said ${secretText}`,
      retryable: false,
    });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'fail with a secret',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();

    const row = await started.app.dependencies.tasks.get(submitted.value.taskId);
    assert.ok(row?.failure?.detail);
    assert.doesNotMatch(row.failure.detail, /sk-abcdefghijklmnopqrstuvwx/);

    const notifications = await started.app.service.notifications(principal);
    assert.doesNotMatch(JSON.stringify(notifications), /sk-abcdefghijklmnopqrstuvwx/);
  } finally {
    await started.close();
  }
});

/**
 * A mode root used to be the workspace of every conversation in it, so one run
 * could read another's files and a quarantine took the whole mode out of service.
 */
test('each conversation has its own confined workspace and a resume reuses it', async () => {
  const roots: string[] = [];
  let calls = 0;
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async (request) => {
      calls += 1;
      roots.push(request.workspaceRoot);
      return calls === 1
        ? { ok: false, code: 'provider_error', detail: 'planned failure', retryable: true }
        : { ok: true, summary: 'done' };
    };

    const first = await started.app.service.submitWork(principal, {
      objective: 'first conversation',
      conversationId: 'conv_ws_a',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(first.ok, true);
    await started.app.dependencies.scheduler.idle();

    const second = await started.app.service.submitWork(principal, {
      objective: 'second conversation',
      conversationId: 'conv_ws_b',
      mode: 'cloud',
      requireApproval: false,
    });
    assert.equal(second.ok, true);
    await started.app.dependencies.scheduler.idle();

    assert.equal(roots.length, 2);
    assert.notEqual(roots[0], roots[1], 'two conversations never share a directory');

    const modeRoot = await realpath(started.workspace.cloudRoot);
    for (const root of roots) {
      assert.equal(root.startsWith(`${modeRoot}${path.sep}`), true);
      assert.equal(root.includes(`${path.sep}conversations${path.sep}`), true);
    }

    const failed = await started.app.service.task(
      principal,
      first.ok ? first.value.taskId : '',
    );
    assert.equal(failed.ok && failed.value.state, 'failed');
    if (!failed.ok) return;
    const retried = await started.app.service.retryTask(
      principal,
      failed.value.taskId,
      failed.value.generation,
    );
    assert.equal(retried.ok, true);
    await started.app.dependencies.scheduler.idle();
    assert.equal(roots.at(-1), roots[0], 'a new generation resumes in its own directory');
  } finally {
    await started.close();
  }
});

/**
 * An external agent executes tools outside this process, so "approve before it
 * acts" can only be honoured by refusing to dispatch without an owner grant.
 * The grant is durable on the task row and can be spent once.
 */
test('an autonomous external agent runs only with a durable, single-use grant', async () => {
  let runs = 0;
  const transport: ExternalAgentTransport = {
    probe: async () => undefined,
    run: async () => {
      runs += 1;
      return { ok: true, summary: 'external done' };
    },
  };
  const started = await startTestApp({
    externals: { opencode: transport },
    env: { OPENCODE_PASSWORD: 'test-password' },
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [testProviderPolicy(), testProviderPolicy('opencode')],
      },
      engines: {
        opencode: {
          enabled: true,
          baseURL: 'http://127.0.0.1:4096',
          model: 'local/model',
          passwordEnv: 'OPENCODE_PASSWORD',
        },
      },
    },
  });
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'run the external agent',
      agent: 'opencode',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const taskId = submitted.value.taskId;
    await started.app.dependencies.scheduler.idle();

    const waiting = await started.app.service.task(principal, taskId);
    assert.equal(waiting.ok && waiting.value.state, 'awaiting_approval');
    assert.equal(waiting.ok && waiting.value.failure?.code, 'approval_required');
    assert.equal(runs, 0, 'nothing was dispatched before the decision');

    const listed = await started.app.service.permissions(principal, taskId);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const denied = listed.value.requests.find((entry) => entry.decision === 'pending');
    assert.ok(denied);
    assert.equal(denied.scope, 'command.execute');
    assert.equal(denied.resource, taskId);

    const denial = await started.app.service.decidePermission(principal, taskId, {
      requestId: denied.requestId,
      decision: 'denied',
    });
    assert.equal(denial.ok, true);
    await started.app.service.resumeTask(
      principal,
      taskId,
      waiting.ok ? waiting.value.generation : 1,
    );
    await started.app.dependencies.scheduler.idle();
    assert.equal(runs, 0, 'a denial never dispatches the agent');

    const again = await started.app.service.permissions(principal, taskId);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    const pending = again.value.requests.find((entry) => entry.decision === 'pending');
    assert.ok(pending, 'the owner can decide again after a denial');
    const approval = await started.app.service.decidePermission(principal, taskId, {
      requestId: pending.requestId,
      decision: 'approved',
    });
    assert.equal(approval.ok, true);

    const durable = await started.app.dependencies.tasks.get(taskId);
    assert.equal(durable?.approval?.decision, 'approved');

    const current = await started.app.service.task(principal, taskId);
    assert.equal(current.ok, true);
    if (!current.ok) return;
    const resumed = await started.app.service.resumeTask(
      principal,
      taskId,
      current.value.generation,
    );
    assert.equal(resumed.ok, true);
    await started.app.dependencies.scheduler.idle();

    assert.equal(runs, 1);
    const finished = await started.app.service.task(principal, taskId);
    assert.equal(finished.ok && finished.value.state, 'completed');

    const consumed = await started.app.dependencies.tasks.get(taskId);
    assert.ok(consumed?.approval?.consumedAt, 'the grant was spent exactly once');

    const replay = await started.app.service.resumeTask(
      principal,
      taskId,
      finished.ok ? finished.value.generation : 2,
    );
    assert.equal(replay.ok === true && replay.value.outcome, 'already_terminal');
    assert.equal(runs, 1, 'a spent grant cannot authorize another run');
  } finally {
    await started.close();
  }
});

/**
 * A JSON array is the cheapest way to make a validator do unbounded work per
 * byte. The body is refused before schema validation.
 */
test('an oversized request array is refused before schema validation', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/notifications/read`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        taskIds: Array.from({ length: 1_000 }, (_, index) => `task-${index}`),
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { detail?: string };
    assert.match(body.detail ?? '', /too many entries/);

    const accepted = await fetch(`${started.url}/v1/notifications/read`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['task-1'] }),
    });
    assert.equal(accepted.status, 200);
  } finally {
    await started.close();
  }
});
