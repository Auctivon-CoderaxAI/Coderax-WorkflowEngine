import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinTools } from '../../src/tools/builtin.js';
import { createToolRuntime } from '../../src/tools/runtime.js';
import type { ApprovalDecision, ToolContext } from '../../src/tools/types.js';

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-tools-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function context(root: string): ToolContext {
  return {
    ownerId: 'owner-test',
    taskId: 'task-test',
    agent: 'coderax',
    mode: 'cloud',
    workspaceRoot: root,
    signal: new AbortController().signal,
    callId: 'call-1',
  };
}

const gate = (decision: ApprovalDecision) => ({ ensure: async () => ({ decision }) });

function runtime(networkEnabled = false) {
  return createToolRuntime({
    tools: createBuiltinTools({
      shellEnabled: false,
      allowedCommands: [],
      networkEnabled,
      allowedHosts: ['allowed.example'],
      maxOutputBytes: 10_000,
      commandTimeoutMs: 1_000,
      maxSearchFiles: 100,
      memory: null,
      knowledge: null,
    }),
  });
}

test('a path that escapes the workspace is refused', async () => {
  const space = workspace();
  try {
    const tools = runtime();
    const escaped = await tools.call({
      name: 'fs.read',
      arguments: { path: '../outside.txt' },
      context: context(space.root),
      gate: gate('granted'),
    });
    assert.equal(escaped.result.ok, false);
    assert.equal(escaped.result.ok === false && escaped.result.code, 'permission_required');
    assert.equal(tools.get('shell.run'), null);
    assert.equal(tools.get('http.fetch'), null);
  } finally {
    space.cleanup();
  }
});

test('a write needs the owner and is refused when approval is not possible', async () => {
  const space = workspace();
  try {
    const tools = runtime();
    const denied = await tools.call({
      name: 'fs.write',
      arguments: { path: 'report.txt', content: 'verified' },
      context: context(space.root),
      gate: gate('denied'),
    });
    assert.equal(denied.approval, 'denied');
    assert.equal(denied.result.ok, false);
    assert.equal(denied.result.ok === false && denied.result.code, 'permission_required');

    const pending = await tools.call({
      name: 'fs.write',
      arguments: { path: 'report.txt', content: 'verified' },
      context: context(space.root),
      gate: gate('pending'),
    });
    assert.equal(pending.approval, 'pending');
    assert.equal(pending.result.ok === false && pending.result.code, 'approval_required');
  } finally {
    space.cleanup();
  }
});

test('an approved write is confined to the workspace and readable back', async () => {
  const space = workspace();
  try {
    const tools = runtime();
    const wrote = await tools.call({
      name: 'fs.write',
      arguments: { path: 'notes/report.txt', content: 'verified content' },
      context: context(space.root),
      gate: gate('granted'),
    });
    assert.equal(wrote.result.ok, true);
    assert.equal(
      readFileSync(path.join(space.root, 'notes', 'report.txt'), 'utf8'),
      'verified content',
    );

    const read = await tools.call({
      name: 'fs.read',
      arguments: { path: 'notes/report.txt' },
      context: context(space.root),
      gate: gate('granted'),
    });
    assert.equal(read.result.ok && read.result.output, 'verified content');
  } finally {
    space.cleanup();
  }
});

test('invalid input is rejected before any tool runs', async () => {
  const space = workspace();
  try {
    const tools = runtime();
    const invalid = await tools.call({
      name: 'fs.write',
      arguments: { path: '', content: 'x' },
      context: context(space.root),
      gate: gate('granted'),
    });
    assert.equal(invalid.result.ok, false);
    assert.equal(invalid.result.ok === false && invalid.result.code, 'validation_failed');
  } finally {
    space.cleanup();
  }
});

test('cancellation during approval prevents an approved write', async () => {
  const space = workspace();
  const controller = new AbortController();
  try {
    const outcome = await runtime().call({
      name: 'fs.write', arguments: { path: 'report.txt', content: 'test' },
      context: { ...context(space.root), signal: controller.signal },
      gate: { ensure: async () => { controller.abort(); return { decision: 'granted' }; } },
    });
    assert.equal(!outcome.result.ok && outcome.result.code, 'cancelled');
    assert.throws(() => readFileSync(path.join(space.root, 'report.txt')), { code: 'ENOENT' });
  } finally {
    space.cleanup();
  }
});

test('the HTTP tool rejects plaintext before approval and dispatches approved HTTPS', async (t) => {
  const space = workspace();
  try {
    const tools = runtime(true);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('verified'));
    const ensure = t.mock.fn(async () => ({ decision: 'granted' as const }));
    const call = (url: string) => tools.call({
      name: 'http.fetch', arguments: { url },
      context: context(space.root), gate: { ensure },
    });

    const refused = await call('http://allowed.example/resource');
    assert.equal(!refused.result.ok && refused.result.code, 'validation_failed');
    assert.equal(ensure.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);

    const approved = await call('https://allowed.example/resource');
    assert.equal(approved.result.ok, true);
    assert.equal(ensure.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    space.cleanup();
  }
});
