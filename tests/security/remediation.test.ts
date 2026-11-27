import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { validateRemoteEndpoint } from '../../src/configuration/endpoint.js';
import { validateInvariants } from '../../src/configuration/load.js';
import { EngineConfigSchema } from '../../src/configuration/schema.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_TOKEN,
  startTestApp,
} from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };
const ENV = { CODERAX_OWNER_TOKEN: OWNER_TOKEN };

function problemText(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues)) return issues.join(' ');
  return (error as Error).message;
}

// ---------------------------------------------------------------------------
// Findings 1 and 2: conversation-mode and surface binding.
// ---------------------------------------------------------------------------

test('private conversation history never crosses into a cloud run', async () => {
  const prompts: string[] = [];
  const started = await startTestApp({
    gateway: {
      id: 'recording',
      complete: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { text: 'private answer' };
      },
    },
  });
  try {
    const privateTurn = await started.app.service.submitWork(principal, {
      objective: 'Private objective: launch code ORCHID-9',
      mode: 'private',
      requireApproval: true,
    });
    assert.equal(privateTurn.ok, true);
    if (!privateTurn.ok) return;
    await started.app.dependencies.scheduler.idle();

    const promptsBefore = prompts.length;
    const cloudRun = await started.app.service.submitWork(principal, {
      objective: 'Cloud follow-up',
      conversationId: privateTurn.value.conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(cloudRun.ok, false);
    assert.equal(cloudRun.ok === false && cloudRun.code, 'conflict');

    // The refusal happened before the model saw anything, and no cloud task exists.
    assert.equal(prompts.length, promptsBefore);
    const tasks = await started.app.dependencies.tasks.listByOwner(principal.ownerId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.mode, 'private');

    const conversation = await started.app.service.conversation(
      principal,
      privateTurn.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    assert.equal(conversation.ok && conversation.value.mode, 'private');
    assert.equal(conversation.ok && conversation.value.messages.length, 2);
  } finally {
    await started.close();
  }
});

test('a cloud conversation cannot be read through a private request', async () => {
  const started = await startTestApp();
  try {
    const cloudTurn = await started.app.service.submitWork(principal, {
      objective: 'Cloud-only objective',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(cloudTurn.ok, true);
    if (!cloudTurn.ok) return;
    await started.app.dependencies.scheduler.idle();

    const chat = await started.app.service.chat(principal, {
      message: 'Private question',
      conversationId: cloudTurn.value.conversationId,
      mode: 'private',
      agent: 'coderax',
    });
    assert.equal(chat.ok, false);
    assert.equal(chat.ok === false && chat.code, 'conflict');

    // The store itself refuses the cross-mode read, not only the service.
    const messages = await started.app.dependencies.conversations.messages({
      ownerId: principal.ownerId,
      conversationId: cloudTurn.value.conversationId,
      mode: 'private',
    });
    assert.equal(messages, null);
  } finally {
    await started.close();
  }
});

test('Chat and Work cannot start inside the other surface\u2019s conversation', async () => {
  const started = await startTestApp();
  try {
    const chat = await started.app.service.chat(principal, {
      message: 'Chat question',
      mode: 'cloud',
      agent: 'coderax',
    });
    assert.equal(chat.ok, true);
    if (!chat.ok) return;

    const workInChat = await started.app.service.submitWork(principal, {
      objective: 'Work in a chat thread',
      conversationId: chat.value.conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(workInChat.ok, false);
    assert.equal(workInChat.ok === false && workInChat.code, 'conflict');

    const work = await started.app.service.submitWork(principal, {
      objective: 'Work objective',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(work.ok, true);
    if (!work.ok) return;
    await started.app.dependencies.scheduler.idle();

    const chatInWork = await started.app.service.chat(principal, {
      message: 'Chat in a work thread',
      conversationId: work.value.conversationId,
      mode: 'cloud',
      agent: 'coderax',
    });
    assert.equal(chatInWork.ok, false);
    assert.equal(chatInWork.ok === false && chatInWork.code, 'conflict');
  } finally {
    await started.close();
  }
});

test('an external agent declared conversations:none never receives history', async () => {
  const workspace = createWorkspaces();
  const seen: unknown[] = [];
  try {
    const config = baseConfig(workspace, {
      engines: {
        default: 'native',
        opencode: {
          enabled: true,
          baseURL: 'https://opencode.example.test',
          model: 'free/model',
          passwordEnv: 'OPENCODE_PASSWORD',
        },
      },
    });
    const app = await composeApplication({
      config,
      env: { ...ENV, OPENCODE_PASSWORD: 'test-password' },
      gateway: fakeGateway(),
      externals: {
        opencode: {
          probe: async () => undefined,
          run: async (request) => {
            seen.push(request.history);
            return { ok: true, summary: 'external answer' };
          },
        },
      },
    });
    try {
      const first = await app.service.submitWork(principal, {
        objective: 'First native objective',
        mode: 'cloud',
        requireApproval: true,
      });
      assert.equal(first.ok, true);
      if (!first.ok) return;
      await app.dependencies.scheduler.idle();

      const external = await app.service.submitWork(principal, {
        objective: 'External objective',
        conversationId: first.value.conversationId,
        agent: 'opencode',
        mode: 'cloud',
        requireApproval: true,
      });
      assert.equal(external.ok, true);
      if (!external.ok) return;
      await app.dependencies.scheduler.idle();

      assert.deepEqual(seen, [[]]);
    } finally {
      await app.stop();
    }
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Finding 3: per-task, per-generation workspaces.
// ---------------------------------------------------------------------------

test('two tasks in one data mode receive separate workspaces', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    const roots: string[] = [];
    agent.run = async (request) => {
      roots.push(request.workspaceRoot);
      return { ok: true, summary: 'done' };
    };

    const first = await started.app.service.submitWork(principal, {
      objective: 'First isolated task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(first.ok, true);
    await started.app.dependencies.scheduler.idle();

    const second = await started.app.service.submitWork(principal, {
      objective: 'Second isolated task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(second.ok, true);
    await started.app.dependencies.scheduler.idle();

    assert.equal(roots.length, 2);
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.notEqual(roots[0], roots[1]);
    assert.ok(roots[0]?.includes(first.value.taskId));
    assert.ok(roots[1]?.includes(second.value.taskId));
    assert.notEqual(roots[0], started.workspace.cloudRoot);
    assert.equal(existsSync(roots[0] ?? ''), true);
  } finally {
    await started.close();
  }
});

// ---------------------------------------------------------------------------
// Findings 4, 5 and 6: abandoned execution revocation, supervision, stale reports.
// ---------------------------------------------------------------------------

test('an abandoned adapter loses its workspace and its events', { timeout: 15_000 }, async () => {
  const started = await startTestApp({
    config: { execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500, cancelGraceMs: 100 } },
  });
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let workspaceRoot = '';
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let late: () => void = () => undefined;
    agent.run = async (request, report) => {
      workspaceRoot = request.workspaceRoot;
      late = () => report({ type: 'text.delta', text: 'stale-after-revocation' });
      entered();
      return new Promise(() => undefined);
    };

    const task = await started.app.service.submitWork(principal, {
      objective: 'Ignore cancellation',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    await ready;

    await started.app.service.cancelTask(principal, task.value.taskId);
    await deps.scheduler.idle();

    assert.equal(deps.supervisor.live().length, 0);
    assert.equal(existsSync(workspaceRoot), false, 'the revoked path must stop existing');
    const quarantined = readdirSync(path.join(started.workspace.cloudRoot, '.coderax-quarantine'));
    assert.ok(quarantined.some((entry) => entry.startsWith(path.basename(workspaceRoot))));

    late();
    const replay = JSON.stringify(deps.events.replay(task.value.taskId, 0));
    assert.doesNotMatch(replay, /stale-after-revocation/);

    const lateWrite = await writeFile(path.join(workspaceRoot, 'stale.txt'), 'x').then(
      () => 'written',
      () => 'refused',
    );
    assert.equal(lateWrite, 'refused');

    const status = await started.app.service.task(principal, task.value.taskId);
    assert.equal(status.ok, true);
    assert.equal(status.ok && status.value.state, 'cancelled');
  } finally {
    await started.close();
  }
});

test('shutdown verifies termination and revokes a hung run', { timeout: 15_000 }, async () => {
  const started = await startTestApp({
    config: { execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500, cancelGraceMs: 100 } },
  });
  const workspace = started.workspace;
  let workspaceRoot = '';
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    agent.run = async (request) => {
      workspaceRoot = request.workspaceRoot;
      entered();
      return new Promise(() => undefined);
    };

    const task = await started.app.service.submitWork(principal, {
      objective: 'Hang until shutdown',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    await ready;

    const startedAt = Date.now();
    await started.app.stop();
    assert.ok(Date.now() - startedAt < 10_000);

    assert.equal(deps.supervisor.live().length, 0);
    assert.equal(existsSync(workspaceRoot), false);
    const status = await started.app.service.task(principal, task.value.taskId);
    assert.equal(status.ok, true);
    assert.equal(status.ok && status.value.state, 'cancelled');
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 7: plaintext remote endpoints carrying credentials.
// ---------------------------------------------------------------------------

test('a plaintext remote endpoint is refused when it carries a credential', () => {
  const remote = validateRemoteEndpoint({
    url: 'http://inference.example.test/v1',
    name: 'CODERAX_INFERENCE_BASE_URL',
    carriesCredential: true,
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.ok === false && remote.code, 'engine_not_configured');

  const secure = validateRemoteEndpoint({
    url: 'https://inference.example.test/v1',
    name: 'CODERAX_INFERENCE_BASE_URL',
    carriesCredential: true,
  });
  assert.equal(secure.ok, true);

  const loopback = validateRemoteEndpoint({
    url: 'http://127.0.0.1:11434/v1',
    name: 'CODERAX_INFERENCE_BASE_URL',
    carriesCredential: true,
  });
  assert.equal(loopback.ok, true);
});

test('a credential embedded in an endpoint URL is refused even over TLS', () => {
  for (const url of [
    'https://user:password@inference.example.test/v1',
    'https://inference.example.test/v1?api_key=abc',
    'https://inference.example.test/v1?token=abc',
  ]) {
    const result = validateRemoteEndpoint({
      url,
      name: 'CODERAX_INFERENCE_BASE_URL',
      carriesCredential: true,
    });
    assert.equal(result.ok, false, url);
  }
});

test('startup refuses a plaintext remote inference endpoint', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: baseConfig(workspace),
          env: {
            ...ENV,
            CODERAX_INFERENCE_BASE_URL: 'http://inference.example.test/v1',
            CODERAX_INFERENCE_KEY: 'test-key',
          },
        }),
      (error: unknown) => {
        assert.match(problemText(error), /plaintext/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test('an OpenCode password over plaintext is refused by configuration', () => {
  const workspace = createWorkspaces();
  try {
    const config = EngineConfigSchema.parse({
      auth: { ownerId: 'owner' },
      workspaces: { privateRoot: workspace.privateRoot, cloudRoot: workspace.cloudRoot },
      models: { route: [{ providerId: 'free', modelId: 'm' }] },
      engines: {
        opencode: {
          enabled: true,
          baseURL: 'http://opencode.example.test',
          model: 'free/model',
          passwordEnv: 'OPENCODE_PASSWORD',
        },
      },
    });
    const issues = validateInvariants(config);
    assert.ok(issues.some((issue) => issue.includes('plaintext')));
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Finding 8: redaction before persistence.
// ---------------------------------------------------------------------------

test('a pasted credential is scrubbed from the transcript and the reply', async () => {
  const started = await startTestApp({
    gateway: {
      id: 'leaky',
      complete: async () => ({ text: `the recovered key is sk-${'a'.repeat(24)}` }),
    },
  });
  try {
    const reply = await started.app.service.chat(principal, {
      message: 'my password=hunter2hunter2 please remember it',
      mode: 'private',
      agent: 'coderax',
    });
    assert.equal(reply.ok, true);
    if (!reply.ok) return;

    assert.doesNotMatch(reply.value.text, /sk-a{24}/);
    assert.match(reply.value.text, /\[redacted-key\]/);

    const conversation = await started.app.service.conversation(
      principal,
      reply.value.conversationId,
    );
    assert.equal(conversation.ok, true);
    if (!conversation.ok) return;
    const stored = JSON.stringify(conversation.value.messages);
    assert.doesNotMatch(stored, /hunter2hunter2/);
    assert.doesNotMatch(stored, /sk-a{24}/);
    assert.match(stored, /password=\[redacted\]/);
  } finally {
    await started.close();
  }
});

test('failure, event, notification and audit text is scrubbed', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    const secret = `Bearer ${'b'.repeat(32)}`;
    agent.run = async (_request, report) => {
      report({ type: 'step.started', stepId: 's1', title: `credential ${secret}` });
      return {
        ok: false,
        code: 'provider_error',
        detail: `upstream rejected credential ${secret}`,
        retryable: false,
      };
    };

    const task = await started.app.service.submitWork(principal, {
      objective: 'Fail with a credential',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(task.ok, true);
    if (!task.ok) return;
    await deps.scheduler.idle();

    const status = await started.app.service.task(principal, task.value.taskId);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.value.state, 'failed');
    assert.doesNotMatch(JSON.stringify(status.value.failure), /b{32}/);

    const replay = JSON.stringify(deps.events.replay(task.value.taskId, 0));
    assert.doesNotMatch(replay, /b{32}/);
    assert.match(replay, /\[redacted\]/);

    const notifications = await started.app.service.notifications(principal);
    assert.doesNotMatch(JSON.stringify(notifications), /b{32}/);

    deps.audit.record({
      actor: principal.ownerId,
      action: 'test.audit',
      outcome: 'failed',
      detail: 'api_key=abcdefghijklmnop',
    });
    const receipt = deps.audit.list().at(-1);
    assert.ok(receipt);
    assert.doesNotMatch(receipt?.detail ?? '', /abcdefghijklmnop/);
  } finally {
    await started.close();
  }
});

test('every event payload is scrubbed at the bus, not only known types', async () => {
  const started = await startTestApp();
  try {
    const events = started.app.dependencies.events;
    events.publish({
      taskId: 'task_bus',
      agent: 'coderax',
      generation: 1,
      type: 'tool.call',
      payload: {
        callId: 'call_1',
        tool: 'test',
        input: { authorization: 'Bearer cccccccccccccccccccccccc', note: 'password=supersecret' },
      },
    });
    events.publish({
      taskId: 'task_bus',
      agent: 'coderax',
      generation: 1,
      type: 'step.started',
      payload: { stepId: 's1', title: 'key sk-' + 'd'.repeat(24) },
    });

    const replay = JSON.stringify(events.replay('task_bus', 0));
    assert.doesNotMatch(replay, /c{24}/);
    assert.doesNotMatch(replay, /supersecret/);
    assert.doesNotMatch(replay, /sk-d{24}/);
  } finally {
    await started.close();
  }
});
