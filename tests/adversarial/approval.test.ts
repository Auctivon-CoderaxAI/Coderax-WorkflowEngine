import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPermissionStore } from '../../src/permissions/store.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';
import { startTestApp } from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('a request is pending until the owner decides it, and a denial is final', async () => {
  const clock = createClock();
  const store = createPermissionStore({ clock, ids: createIdGenerator() });
  const request = await store.request({
    ownerId: 'owner-test',
    taskId: 'task_1',
    agent: 'coderax',
    scope: 'command.execute',
    description: 'Run one command',
    resource: 'npm test',
  });
  assert.equal(request.decision, 'pending');
  assert.equal(await store.hasPending('task_1'), true);
  assert.equal(await store.isApproved('task_1', 'command.execute', 'npm test'), false);

  const denied = await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_1',
    requestId: request.requestId,
    decision: 'denied',
    reason: 'not now',
  });
  assert.equal(denied.ok, true);
  assert.equal(await store.isApproved('task_1', 'command.execute', 'npm test'), false);
});

test('a grant for one resource and scope is not a grant for another', async () => {
  const store = createPermissionStore({ clock: createClock(), ids: createIdGenerator() });
  const request = await store.request({
    ownerId: 'owner-test',
    taskId: 'task_2',
    agent: 'coderax',
    scope: 'workspace.write',
    description: 'Write one file',
    resource: '/workspace/one.txt',
  });
  await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_2',
    requestId: request.requestId,
    decision: 'approved',
  });
  assert.equal(await store.isApproved('task_2', 'workspace.write', '/workspace/one.txt'), true);
  assert.equal(await store.isApproved('task_2', 'workspace.write', '/workspace/two.txt'), false);
  assert.equal(await store.isApproved('task_2', 'workspace.read', '/workspace/one.txt'), false);
});

test('a permission record cannot be decided through another task or owner', async () => {
  const store = createPermissionStore({ clock: createClock(), ids: createIdGenerator() });
  const request = await store.request({
    ownerId: 'owner-test',
    taskId: 'task_3',
    agent: 'coderax',
    scope: 'network.access',
    description: 'One host',
    resource: 'https://example.test',
  });
  const foreignOwner = await store.decide({
    ownerId: 'other',
    taskId: 'task_3',
    requestId: request.requestId,
    decision: 'approved',
  });
  assert.equal(foreignOwner.ok, false);
  const foreignTask = await store.decide({
    ownerId: 'owner-test',
    taskId: 'task_4',
    requestId: request.requestId,
    decision: 'approved',
  });
  assert.equal(foreignTask.ok, false);
});

// Reconciliation from ci/permanent-quality-gate: the event is informational and
// the service cannot decide a request that belongs to another task or owner.
test('approval.required publishes a request but grants nothing by itself', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    agent.run = async (_request, report) => {
      report({
        type: 'approval.required',
        requestId: 'request_pending',
        tool: 'write',
        description: 'Write the generated report',
      });
      return { ok: true, summary: 'awaiting owner authority' };
    };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'needs an approval',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const replay = started.app.dependencies.events.replay(submitted.value.taskId, 0);
    assert.ok(replay.events.some((event) => event.type === 'approval.required'));

    const listed = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.ok(listed.ok);
    assert.deepEqual(listed.value.requests, []);
    assert.equal(
      await started.app.dependencies.permissions.isApproved(
        submitted.value.taskId,
        'workspace.write',
        'the generated report',
      ),
      false,
    );
  } finally {
    await started.close();
  }
});

test('a pending request is listed for its own task and cannot be decided elsewhere', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'pending request',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const store = started.app.dependencies.permissions;
    const request = await store.request({
      ownerId: principal.ownerId,
      taskId: submitted.value.taskId,
      agent: 'coderax',
      scope: 'workspace.write',
      description: 'Write a file',
      resource: 'report.md',
    });
    const listed = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.ok(listed.ok);
    assert.equal(
      listed.value.requests.find((entry) => entry.requestId === request.requestId)?.decision,
      'pending',
    );

    const unknown = await started.app.service.decidePermission(
      principal,
      submitted.value.taskId,
      { requestId: 'request_missing', decision: 'approved' },
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok === false && unknown.code, 'not_found');

    const foreign = await started.app.service.permissions(
      { ownerId: 'someone-else', isOwner: true },
      submitted.value.taskId,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');
  } finally {
    await started.close();
  }
});

test('the HTTP permission routes are owner-scoped even with a valid task id', async () => {
  const started = await startTestApp();
  try {
    const principal = { ownerId: 'owner-test', isOwner: true as const };
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'Approval ownership',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;

    const foreign = await started.app.service.permissions(
      { ownerId: 'someone-else', isOwner: true },
      submitted.value.taskId,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');

    const own = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.equal(own.ok, true);
    await started.app.dependencies.scheduler.idle();
  } finally {
    await started.close();
  }
});
