import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateCommand } from '../../src/security/shell.js';
import { createBuiltinTools } from '../../src/tools/builtin.js';
import { createToolRuntime } from '../../src/tools/runtime.js';
import type { ToolContext } from '../../src/tools/types.js';

test('only bare, allow-listed commands that exist are accepted', async () => {
  assert.equal((await validateCommand({ command: 'node', args: [], allowedCommands: ['node'] })).ok, true);
  const notAllowed = await validateCommand({ command: 'node', args: [], allowedCommands: [] });
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.ok === false ? notAllowed.detail : '', /not allow-listed/);

  const pathName = await validateCommand({ command: '/usr/bin/node', args: [], allowedCommands: ['/usr/bin/node'] });
  assert.equal(pathName.ok, false);

  const missing = await validateCommand({
    command: 'definitely-not-installed',
    args: [],
    allowedCommands: ['definitely-not-installed'],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.detail : '', /not installed/);
});

test('flag forms that turn an allow-listed program into a code runner are refused', async () => {
  for (const args of [['-e', 'process.exit(0)'], ['--eval=process.exit(0)'], ['-p', '1'], ['--print=1']]) {
    const result = await validateCommand({ command: 'node', args, allowedCommands: ['node'] });
    assert.equal(result.ok, false, `expected ${args.join(' ')} to be refused`);
  }
  const shell = await validateCommand({ command: 'sh', args: ['-c', 'id'], allowedCommands: ['sh'] });
  assert.equal(shell.ok, false);
});

test('arguments that name a host or parent path are refused', async () => {
  for (const args of [['/etc/passwd'], ['../outside.js'], ['--require=/etc/secret.js'], ['dir/../../escape']]) {
    const result = await validateCommand({ command: 'node', args, allowedCommands: ['node'] });
    assert.equal(result.ok, false, args.join(' '));
  }
  const relative = await validateCommand({ command: 'node', args: ['script.js', '--title=hello'], allowedCommands: ['node'] });
  assert.equal(relative.ok, true);
});

test('commands that exist only to dispatch another program are always refused', async () => {
  const result = await validateCommand({ command: 'xargs', args: ['node'], allowedCommands: ['xargs'] });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.detail : '', /launches another program/);
});

test('control characters and command injection syntax stay literal, never interpreted', async () => {
  const control = await validateCommand({ command: 'node', args: ['a\u0000b'], allowedCommands: ['node'] });
  assert.equal(control.ok, false);

  const root = mkdtempSync(path.join(tmpdir(), 'coderax-shell-'));
  try {
    const tools = createToolRuntime({
      tools: createBuiltinTools({
        shellEnabled: true,
        allowedCommands: ['printf'],
        networkEnabled: false,
        allowedHosts: [],
        maxOutputBytes: 10_000,
        commandTimeoutMs: 5_000,
        maxSearchFiles: 10,
        memory: null,
        knowledge: null,
      }),
    });
    const context: ToolContext = {
      ownerId: 'owner',
      taskId: 'task',
      agent: 'coderax',
      mode: 'cloud',
      workspaceRoot: root,
      signal: new AbortController().signal,
      callId: 'call-shell',
    };
    const outcome = await tools.call({
      name: 'shell.run',
      arguments: { command: 'printf', args: ['%s', 'literal; echo injected'] },
      context,
      gate: { ensure: async () => ({ decision: 'granted' }) },
    });
    assert.equal(outcome.result.ok, true);
    // The metacharacters are one argv entry because `shell: false` is used.
    assert.ok(outcome.result.ok && outcome.result.output.endsWith('literal; echo injected'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
