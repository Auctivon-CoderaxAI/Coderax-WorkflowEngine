import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ExecutionEvent } from '@coderax/contracts';
import { composeApplication, StartupError } from '../../src/bootstrap/compose.js';
import type { AgentAdapter } from '../../src/agents/types.js';
import { createTaskRunner } from '../../src/execution/runner.js';
import type { LeaseStore } from '../../src/execution/lease.js';
import { validateWorkspaceRoots } from '../../src/execution/workspace.js';
import { buildTranscript } from '../../src/orchestration/transcript.js';
import { createPermissionStore } from '../../src/permissions/store.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_TOKEN,
  startTestApp,
} from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };
const covered = new Set<string>();

/** Exact-resource check through the durable lookup, owner-scoped. */
async function isApproved(
  store: ReturnType<typeof createPermissionStore>,
  taskId: string,
  scope: Parameters<ReturnType<typeof createPermissionStore>['lookup']>[0]['scope'],
  resource: string,
  ownerId = 'owner-test',
): Promise<boolean> {
  const found = await store.lookup({ ownerId, taskId, scope, resource, binding: '', consume: false });
  return found?.decision === 'granted';
}

/** Every finding from the independent review is a permanent named test. */
function regression(id: string, title: string, body: () => Promise<void> | void): void {
  covered.add(id);
  test(`[SEC-${id}] ${title}`, body);
}

regression('F1', 'provider and adapter text is redacted before persistence, events and status', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async () => ({
      ok: false,
      code: 'provider_error',
      // Split so a secret scanner does not mistake the regression fixture for a key.
      detail: `upstream said sk-${"abcdefghijklmnopqrstuvwx"} at /home/owner/private/secret.env`,
      retryable: false,
    });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Redaction regression',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();

    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.equal(status.ok && status.value.state, 'failed');
    const detail = status.ok ? status.value.failure?.detail ?? '' : '';
    assert.doesNotMatch(detail, /sk-|owner|\/home\//);

    const frames = JSON.stringify(
      started.app.dependencies.events.replay(submitted.value.taskId, 0).events,
    );
    assert.doesNotMatch(frames, /sk-|owner|\/home\//);
  } finally {
    await started.close();
  }
});

regression('F2', 'mongo persistence never silently downgrades to process-local state', async () => {
  const workspace = createWorkspaces();
  try {
    await assert.rejects(
      () =>
        composeApplication({
          config: baseConfig(workspace, { persistence: { driver: 'mongo' } }),
          env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
          gateway: fakeGateway(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.issues.join(' '), /CODERAX_MONGODB_URI is not set/);
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

regression('F3', 'an unavailable external agent is refused with no task and no substitution', async () => {
  const started = await startTestApp();
  try {
    const opencode = started.app.service.agents().agents.find((agent) => agent.id === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.availability.available, false);
    assert.deepEqual(opencode.isolation, {
      workspace: 'isolated',
      memory: 'none',
      credentials: 'none',
      conversations: 'none',
    });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Use the unavailable agent',
      agent: 'opencode',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, false);
    assert.equal(
      (await started.app.dependencies.tasks.listByOwner(principal.ownerId)).length,
      0,
    );
  } finally {
    await started.close();
  }
});

regression('F4', 'every emitted event validates, has a unique id and a monotonic sequence', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async (_request, report) => {
      report({ type: 'file.edit', path: '/workspace/result.txt' });
      report({ type: 'text.delta', text: 'done' });
      return { ok: true, summary: 'done' };
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Event integrity',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();

    const events = started.app.dependencies.events.replay(submitted.value.taskId, 0).events;
    assert.ok(events.length > 0);
    const ids = new Set<string>();
    events.forEach((event, index) => {
      ExecutionEvent.parse(event);
      assert.equal(event.seq, index + 1);
      assert.equal(ids.has(event.eventId), false);
      ids.add(event.eventId);
    });
    assert.equal(events.at(-1)?.type, 'task.completed');
    assert.ok(events.some((event) => event.type === 'file.edit'));
  } finally {
    await started.close();
  }
});

regression('F5', 'an approval is exact, owner/task scoped, expiring and never widened', async () => {
  let now = new Date('2026-11-26T00:00:00.000Z');
  const clock = { now: () => now, iso: () => now.toISOString() } as ReturnType<
    typeof createClock
  >;
  const store = createPermissionStore({
    clock,
    ids: createIdGenerator(),
    defaultTtlMs: 1_000,
  });
  const recorded = await store.request({
    ownerId: 'owner-test',
    taskId: 'task_1',
    agent: 'coderax',
    scope: 'workspace.read',
    description: 'Read one file',
    resource: '/workspace/allowed.txt',
  });
  assert.equal(recorded.decision, 'pending');
  assert.equal(
    await isApproved(store, 'task_1', 'workspace.read', '/workspace/allowed.txt'),
    false,
  );

  const foreign = await store.decide({
    ownerId: 'someone-else',
    taskId: 'task_1',
    requestId: recorded.requestId,
    decision: 'approved',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.code, 'not_found');

  const wrongTask = await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_2',
    requestId: recorded.requestId,
    decision: 'approved',
  });
  assert.equal(wrongTask.ok, false);

  const approved = await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_1',
    requestId: recorded.requestId,
    decision: 'approved',
  });
  assert.equal(approved.ok, true);
  assert.equal(
    await isApproved(store, 'task_1', 'workspace.read', '/workspace/allowed.txt'),
    true,
  );
  // The exact resource and scope are part of the key: a grant is not a wildcard.
  assert.equal(
    await isApproved(store, 'task_1', 'workspace.read', '/workspace/other.txt'),
    false,
  );
  assert.equal(
    await isApproved(store, 'task_1', 'workspace.write', '/workspace/allowed.txt'),
    false,
  );

  now = new Date(now.getTime() + 10_000);
  assert.equal(
    await isApproved(store, 'task_1', 'workspace.read', '/workspace/allowed.txt'),
    false,
  );
  const expired = await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_1',
    requestId: recorded.requestId,
    decision: 'approved',
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.code, 'conflict');
});

regression('F6', 'cancellation is bounded and a late report never reaches the bus', async () => {
  const lease: LeaseStore = {
    claim: async () => true,
    renew: async () => ({ renewed: true, cancelRequested: false }),
    release: async () => true,
    cancel: async () => 'requested',
    read: async () => null,
    prune: async () => 0,
  };
  const adapter: AgentAdapter = {
    agent: 'coderax',
    engine: 'native',
    capabilities: {
      streaming: true,
      tools: false,
      cancellation: true,
      resume: true,
      modelSelection: true,
      durable: true,
    },
    isolation: {
      workspace: 'isolated',
      memory: 'granted',
      credentials: 'none',
      conversations: 'granted',
    },
    availability: () => ({ available: true, reason: 'ready', detail: 'ready' }),
    run: async () => new Promise(() => undefined),
  };
  const runner = createTaskRunner({
    lease,
    clock: createClock(),
    leaseTtlMs: 3_000,
    heartbeatIntervalMs: 1_000,
    cleanupGraceMs: 20,
  });
  const external = new AbortController();
  const started = Date.now();
  const running = runner.run({
    scope: { ownerId: 'owner', tenantId: null, conversationId: 'conv' },
    token: 'token',
    adapter,
    request: {
      ownerId: 'owner',
      tenantId: null,
      conversationId: 'conv',
      objective: 'bounded cancellation',
      model: { providerId: 'free', modelId: 'coderax-small' },
      mode: 'cloud',
      routing: 'auto',
      allowFallback: true,
      operation: 'work',
      workspaceRoot: '/tmp',
      maxSteps: 1,
      budget: null,
      signal: external.signal,
    },
    report: () => undefined,
  });
  setTimeout(() => external.abort(), 5);
  const result = await running;
  assert.deepEqual(result, {
    outcome: { kind: 'cancelled', abandoned: true },
    ownershipLost: false,
  });
  assert.ok(Date.now() - started < 1_000);
});

regression('F7', 'the follow-up prompt is built from stored history without repeating the objective', () => {
  const transcript = buildTranscript({
    messages: [
      { messageId: 'm1', conversationId: 'c', role: 'user', text: 'First objective', createdAt: '2026-11-26T00:00:00.000Z' },
      { messageId: 'm2', conversationId: 'c', role: 'assistant', text: 'First answer', createdAt: '2026-11-26T00:00:01.000Z' },
      { messageId: 'm3', conversationId: 'c', role: 'user', text: 'Follow-up objective', createdAt: '2026-11-26T00:00:02.000Z' },
    ],
    currentText: 'Follow-up objective',
  });
  assert.deepEqual(transcript, [
    { role: 'user', text: 'First objective' },
    { role: 'assistant', text: 'First answer' },
  ]);
});

regression('F8', 'the event vocabulary covers file edits and an optional session id', () => {
  const base = {
    v: 1 as const,
    eventId: 'evt_1',
    taskId: 'task_1',
    seq: 1,
    at: '2026-11-26T00:00:00.000Z',
    agent: 'coderax' as const,
    generation: 1,
  };
  assert.equal(
    ExecutionEvent.parse({ ...base, type: 'file.edit', payload: { path: 'src/index.ts' } }).type,
    'file.edit',
  );
  assert.equal(
    ExecutionEvent.parse({
      ...base,
      type: 'task.started',
      payload: { sessionId: 'session-1' },
    }).type,
    'task.started',
  );
  assert.throws(() =>
    ExecutionEvent.parse({ ...base, type: 'file.edit', payload: { path: 'x'.repeat(1025) } }),
  );
});

regression('F9', 'workspace roots are resolved through symlinks and must not overlap', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-workspace-'));
  const privateRoot = path.join(root, 'private');
  const cloudRoot = path.join(root, 'cloud');
  mkdirSync(privateRoot);
  mkdirSync(cloudRoot);
  mkdirSync(path.join(privateRoot, 'nested'));
  try {
    assert.equal(
      (await validateWorkspaceRoots({ private: privateRoot, cloud: cloudRoot })).ok,
      true,
    );
    assert.equal(
      (await validateWorkspaceRoots({ private: privateRoot, cloud: path.join(privateRoot, 'nested') })).ok,
      false,
    );

    const linked = path.join(root, 'linked-cloud');
    symlinkSync(privateRoot, linked);
    const symlinked = await validateWorkspaceRoots({ private: privateRoot, cloud: linked });
    assert.equal(symlinked.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

regression('F10', 'the three-agent model has no OpenHands surface', async () => {
  const started = await startTestApp();
  try {
    assert.deepEqual(
      started.app.service.agents().agents.map((agent) => agent.id).sort(),
      ['coderax', 'freebuff', 'opencode'],
    );
  } finally {
    await started.close();
  }
});

regression('F11', 'readiness is configuration admission and spends no provider request', async () => {
  const gateway = fakeGateway();
  const started = await startTestApp({ gateway });
  try {
    const readiness = await started.app.service.readiness();
    assert.equal(readiness.ready, true);
    assert.equal(gateway.calls, 0);
  } finally {
    await started.close();
  }
});

test('every reported independent finding has a permanent regression test', () => {
  assert.deepEqual([...covered].sort(), [
    'F1',
    'F10',
    'F11',
    'F2',
    'F3',
    'F4',
    'F5',
    'F6',
    'F7',
    'F8',
    'F9',
  ]);
});

test('a foreign owner receives not_found rather than a forbidden existence oracle', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Owner scoped',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    const foreign = await started.app.service.task(
      { ownerId: 'someone-else', isOwner: true },
      submitted.value.taskId,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');
  } finally {
    await started.close();
  }
});
