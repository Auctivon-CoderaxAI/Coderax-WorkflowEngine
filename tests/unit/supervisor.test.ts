import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRunSupervisor } from '../../src/execution/supervisor.js';
import { createRunWorkspace, quarantineRunWorkspace } from '../../src/execution/workspace.js';

function roots(): { root: string; privateRoot: string; cloudRoot: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-supervisor-'));
  const privateRoot = path.join(root, 'private');
  const cloudRoot = path.join(root, 'cloud');
  mkdirSync(privateRoot);
  mkdirSync(cloudRoot);
  return {
    root,
    privateRoot,
    cloudRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('a run workspace is private, inside its mode and unique per generation', async () => {
  const workspace = roots();
  try {
    const first = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_abc',
      generation: 1,
    });
    const second = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_abc',
      generation: 2,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.notEqual(first.value.root, second.value.root);
    // Compare against the resolved confinement: on Windows the real path can
    // expand a short name (`NADERA~1`) differently from the temporary root.
    assert.ok(first.value.root.startsWith(first.value.parent));
    assert.ok(first.value.root.includes('task_abc-g1'));
    // Windows ignores POSIX mode bits on directories; the confinement is
    // enforced by path checks and the capability, not by chmod.
    if (process.platform !== 'win32') {
      assert.equal(statSync(first.value.root).mode & 0o777, 0o700);
    }
    assert.equal(existsSync(first.value.root), true);
  } finally {
    workspace.cleanup();
  }
});

test('a run identity cannot traverse outside its mode', async () => {
  const workspace = roots();
  try {
    for (const runId of ['../private', 'a/b', '.', '']) {
      const result = await createRunWorkspace({
        mode: 'cloud',
        roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
        runId,
        generation: 1,
      });
      assert.equal(result.ok, false, runId);
    }
    assert.equal(existsSync(path.join(workspace.root, 'private', 'g1')), false);
  } finally {
    workspace.cleanup();
  }
});

test('the supervisor revokes a finished run without touching its workspace', async () => {
  const workspace = roots();
  try {
    const run = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_finished',
      generation: 1,
    });
    assert.equal(run.ok, true);
    if (!run.ok) return;

    const supervisor = createRunSupervisor({ clock: { now: () => new Date(), iso: () => new Date().toISOString() } });
    await supervisor.begin({
      taskId: 'task_finished',
      token: 'token-1',
      generation: 1,
      workspaceRoot: run.value.root,
    });
    assert.equal(supervisor.isLive('task_finished', 'token-1'), true);

    supervisor.finish('task_finished', 'token-1');
    assert.equal(supervisor.isLive('task_finished', 'token-1'), false);
    assert.equal(supervisor.live().length, 0);
    assert.equal(existsSync(run.value.root), true);
  } finally {
    workspace.cleanup();
  }
});

test('abandoning a run revokes its capability and renames its workspace', async () => {
  const workspace = roots();
  try {
    const run = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_abandoned',
      generation: 3,
    });
    assert.equal(run.ok, true);
    if (!run.ok) return;

    const supervisor = createRunSupervisor({ clock: { now: () => new Date(), iso: () => new Date().toISOString() } });
    await supervisor.begin({
      taskId: 'task_abandoned',
      token: 'token-2',
      generation: 3,
      workspaceRoot: run.value.root,
    });

    assert.equal(await supervisor.abandon({ token: 'token-2' }), true);
    assert.equal(supervisor.isLive('task_abandoned', 'token-2'), false);
    assert.equal(existsSync(run.value.root), false);
    // A second revoke is a no-op, never a second rename.
    assert.equal(await supervisor.abandon({ token: 'token-2' }), false);
  } finally {
    workspace.cleanup();
  }
});

test('a newer generation revokes and quarantines the previous workspace', async () => {
  const workspace = roots();
  try {
    const oldRun = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_resumed',
      generation: 1,
    });
    const newRun = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_resumed',
      generation: 2,
    });
    assert.ok(oldRun.ok && newRun.ok);
    if (!oldRun.ok || !newRun.ok) return;

    const supervisor = createRunSupervisor({ clock: { now: () => new Date(), iso: () => new Date().toISOString() } });
    await supervisor.begin({
      taskId: 'task_resumed',
      token: 'generation-1',
      generation: 1,
      workspaceRoot: oldRun.value.root,
    });
    await supervisor.begin({
      taskId: 'task_resumed',
      token: 'generation-2',
      generation: 2,
      workspaceRoot: newRun.value.root,
    });

    assert.equal(supervisor.isLive('task_resumed', 'generation-1'), false);
    assert.equal(existsSync(oldRun.value.root), false);
    assert.equal(existsSync(newRun.value.root), true);
    assert.equal(supervisor.isLive('task_resumed', 'generation-2'), true);
  } finally {
    workspace.cleanup();
  }
});

test('shutdown revokes every registered run', async () => {
  const workspace = roots();
  try {
    const first = await createRunWorkspace({
      mode: 'cloud',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_one',
      generation: 1,
    });
    const second = await createRunWorkspace({
      mode: 'private',
      roots: { private: workspace.privateRoot, cloud: workspace.cloudRoot },
      runId: 'task_two',
      generation: 1,
    });
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;

    const supervisor = createRunSupervisor({ clock: { now: () => new Date(), iso: () => new Date().toISOString() } });
    await supervisor.begin({
      taskId: 'task_one',
      token: 'token-a',
      generation: 1,
      workspaceRoot: first.value.root,
    });
    await supervisor.begin({
      taskId: 'task_two',
      token: 'token-b',
      generation: 1,
      workspaceRoot: second.value.root,
    });

    const result = await supervisor.shutdown();
    assert.equal(result.revoked, 2);
    assert.equal(result.quarantined, 2);
    assert.equal(supervisor.live().length, 0);
    assert.equal(existsSync(first.value.root), false);
    assert.equal(existsSync(second.value.root), false);
  } finally {
    workspace.cleanup();
  }
});

test('quarantine refuses to rename a directory it did not create', async () => {
  const workspace = roots();
  try {
    mkdirSync(path.join(workspace.cloudRoot, 'unrelated'));
    assert.equal(
      await quarantineRunWorkspace({ root: path.join(workspace.cloudRoot, 'unrelated') }),
      false,
    );
    assert.equal(existsSync(path.join(workspace.cloudRoot, 'unrelated')), true);
  } finally {
    workspace.cleanup();
  }
});
