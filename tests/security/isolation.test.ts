import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('an unavailable external agent is refused, never replaced by Native', async () => {
  const started = await startTestApp();
  try {
    const agents = started.app.service.agents();
    const opencode = agents.agents.find((agent) => agent.id === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.availability.available, false);
    assert.equal(opencode.isolation.memory, 'none');
    assert.equal(opencode.isolation.credentials, 'none');
    assert.equal(opencode.isolation.conversations, 'none');

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Use the external agent',
      agent: 'opencode',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.ok === false && submitted.code, 'engine_unavailable');

    // No task was created, so nothing was silently executed on Native.
    const tasks = await started.app.dependencies.tasks.listByOwner(principal.ownerId);
    assert.equal(tasks.length, 0);
  } finally {
    await started.close();
  }
});

test('Native is the default and is marked as the only internal agent', async () => {
  const started = await startTestApp();
  try {
    const agents = started.app.service.agents();
    const native = agents.agents.find((agent) => agent.id === 'coderax');
    assert.ok(native);
    assert.equal(native.external, false);
    assert.equal(native.engine, 'native');
    assert.equal(native.isolation.memory, 'granted');
  } finally {
    await started.close();
  }
});

test('private memory is never visible to a cloud query in the same owner scope', async () => {
  const started = await startTestApp();
  try {
    const memory = started.app.dependencies.memory;
    await memory.put({
      ownerId: principal.ownerId,
      tenantId: null,
      mode: 'private',
      key: 'secret',
      value: 'private-only',
    });
    await memory.put({
      ownerId: principal.ownerId,
      tenantId: null,
      mode: 'cloud',
      key: 'shareable',
      value: 'cloud-only',
    });

    const priv = await started.app.service.memory(principal, 'private');
    const cloud = await started.app.service.memory(principal, 'cloud');
    assert.deepEqual(priv.entries.map((entry) => entry.key), ['secret']);
    assert.deepEqual(cloud.entries.map((entry) => entry.key), ['shareable']);
  } finally {
    await started.close();
  }
});

test('one owner cannot read another owner\u2019s conversation', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Owner scoped',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const foreign = await started.app.service.conversation(
      { ownerId: 'someone-else', isOwner: true },
      submitted.value.conversationId,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');

    const foreignTask = await started.app.service.task(
      { ownerId: 'someone-else', isOwner: true },
      submitted.value.taskId,
    );
    assert.equal(foreignTask.ok, false);
  } finally {
    await started.close();
  }
});
