import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspaceFile } from '../../src/agents/native/actions.js';

test('a workspace read enforces the byte bound and returns the real content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coderax-read-'));
  try {
    await writeFile(path.join(root, 'notes.txt'), 'alpha beta', 'utf8');

    const read = await readWorkspaceFile({ root, resource: 'notes.txt', maxBytes: 100 });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.match(read.text, /alpha beta/);
      assert.match(read.citation, /sha256/);
    }

    const bounded = await readWorkspaceFile({ root, resource: 'notes.txt', maxBytes: 4 });
    assert.equal(bounded.ok, false);
    if (!bounded.ok) assert.equal(bounded.code, 'too_large');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
