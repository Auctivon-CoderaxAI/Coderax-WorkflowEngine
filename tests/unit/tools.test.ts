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

test('an approved http.fetch dispatches through the pinned client, never global fetch', async () => {
  const space = workspace();
  const original = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error('http.fetch must not use global fetch');
  }) as typeof fetch;
  try {
    const dispatched: Array<{ url: string; method: string; addresses: string[]; body?: string }> = [];
    const tools = createToolRuntime({
      tools: createBuiltinTools({
        shellEnabled: false,
        allowedCommands: [],
        networkEnabled: true,
        allowedHosts: ['1.1.1.1'],
        maxOutputBytes: 10_000,
        commandTimeoutMs: 1_000,
        maxSearchFiles: 100,
        memory: null,
        knowledge: null,
        // The real policy refuses a non-public destination, so no local server
        // can stand in for the network. Only the transport is injected;
        // authorization above it is the production code path.
        networkFetch: async (input) => {
          dispatched.push({
            url: input.target.url.href,
            method: input.method,
            addresses: input.target.addresses,
            ...(input.body === undefined ? {} : { body: input.body }),
          });
          return { status: 200, headers: {}, text: 'pinned response', truncated: false };
        },
      }),
    });
    let approvals = 0;
    const outcome = await tools.call({
      name: 'http.fetch',
      arguments: { url: 'https://1.1.1.1/status', method: 'POST', body: 'payload' },
      context: context(space.root),
      gate: {
        ensure: async () => {
          approvals += 1;
          return { decision: 'granted' };
        },
      },
    });
    assert.equal(outcome.approval, 'granted');
    assert.equal(outcome.result.ok && outcome.result.output, 'HTTP 200\npinned response');
    assert.equal(approvals, 1);
    assert.deepEqual(dispatched, [
      { url: 'https://1.1.1.1/status', method: 'POST', addresses: ['1.1.1.1'], body: 'payload' },
    ]);
    assert.equal(globalFetchCalls, 0);
  } finally {
    globalThis.fetch = original;
    space.cleanup();
  }
});

test('the HTTP tool refuses plaintext before approval and private destinations before dispatch', async () => {
  const space = workspace();
  try {
    const tools = runtime(true);
    let approvals = 0;
    const ensure = async (): Promise<{ decision: ApprovalDecision }> => {
      approvals += 1;
      return { decision: 'granted' };
    };
    const call = (target: ReturnType<typeof runtime>, url: string) => target.call({
      name: 'http.fetch', arguments: { url },
      context: context(space.root), gate: { ensure },
    });

    const refused = await call(tools, 'http://allowed.example/resource');
    assert.equal(!refused.result.ok && refused.result.code, 'validation_failed');
    assert.equal(approvals, 0);

    const foreign = await call(tools, 'https://not-allowed.example/resource');
    assert.equal(!foreign.result.ok && foreign.result.code, 'permission_required');

    const privateNetwork = createToolRuntime({
      tools: createBuiltinTools({
        shellEnabled: false,
        allowedCommands: [],
        networkEnabled: true,
        allowedHosts: ['192.168.1.10'],
        maxOutputBytes: 10_000,
        commandTimeoutMs: 1_000,
        maxSearchFiles: 100,
        memory: null,
        knowledge: null,
      }),
    });
    const privateTarget = await call(privateNetwork, 'https://192.168.1.10/resource');
    assert.equal(!privateTarget.result.ok && privateTarget.result.code, 'permission_required');
    assert.match(
      privateTarget.result.ok === false ? privateTarget.result.detail : '',
      /non-public/,
    );
  } finally {
    space.cleanup();
  }
});
