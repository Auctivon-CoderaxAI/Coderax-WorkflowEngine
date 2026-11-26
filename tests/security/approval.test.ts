import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, waitFor } from '../helpers.js';

/**
 * Approval enforcement.
 *
 * A grant is bound to one task, one scope and one exact resource, expires, and
 * is never widened. `approval.required` is a request for the owner's attention,
 * not an authorization: until the permission store records a decision, nothing
 * is approved.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('a grant is exact-resource, exact-scope and exact-task', async () => {
  const started = await startTestApp();
  try {
    const store = started.app.dependencies.permissions;
    const request = await store.request({
      ownerId: principal.ownerId,
      taskId: 'task_approval',
      agent: 'opencode',
      scope: 'workspace.read',
      description: 'Read the release checklist',
      resource: '/srv/coderax/cloud/release.md',
    });

    assert.equal(await store.isApproved('task_approval', 'workspace.read', request.resource), false);
    const decided = await store.decide({
      ownerId: principal.ownerId,
      taskId: 'task_approval',
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.ok(decided.ok);
    assert.equal(await store.isApproved('task_approval', 'workspace.read', request.resource), true);
    for (const [taskId, scope, resource] of [
      ['task_approval', 'workspace.read', '/srv/coderax/cloud'],
      ['task_approval', 'workspace.read', '/srv/coderax/cloud/release.md/../secrets'],
      ['task_approval', 'workspace.write', request.resource],
      ['task_other', 'workspace.read', request.resource],
    ] as const) {
      assert.equal(
        await store.isApproved(taskId, scope, resource),
        false,
        `${scope} ${resource} on ${taskId} must not inherit the grant`,
      );
    }
  } finally {
    await started.close();
  }
});

test('a denied request is never approved', async () => {
  const started = await startTestApp();
  try {
    const store = started.app.dependencies.permissions;
    const request = await store.request({
      ownerId: principal.ownerId,
      taskId: 'task_denied',
      agent: 'coderax',
      scope: 'command.execute',
      description: 'Run the test suite',
      resource: 'npm test',
    });
    await store.decide({
      ownerId: principal.ownerId,
      taskId: 'task_denied',
      requestId: request.requestId,
      decision: 'denied',
    });
    assert.equal(await store.isApproved('task_denied', 'command.execute', 'npm test'), false);
  } finally {
    await started.close();
  }
});

test('cross-owner and unknown decisions are not-found', async () => {
  const started = await startTestApp();
  try {
    const store = started.app.dependencies.permissions;
    const request = await store.request({
      ownerId: principal.ownerId,
      taskId: 'task_scope',
      agent: 'coderax',
      scope: 'network.access',
      description: 'Fetch the changelog',
      resource: 'https://example.invalid/changelog',
    });
    const foreign = await store.decide({
      ownerId: 'someone-else',
      taskId: 'task_scope',
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');

    const wrongTask = await store.decide({
      ownerId: principal.ownerId,
      taskId: 'task_other',
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(wrongTask.ok, false);

    const unknown = await store.decide({
      ownerId: principal.ownerId,
      taskId: 'task_scope',
      requestId: 'request_missing',
      decision: 'approved',
    });
    assert.equal(unknown.ok, false);
    assert.equal(await store.isApproved('task_scope', 'network.access', request.resource), false);
  } finally {
    await started.close();
  }
});

test('an expired request cannot be approved or inherited', async () => {
  const started = await startTestApp();
  try {
    const store = started.app.dependencies.permissions;
    const request = await store.request({
      ownerId: principal.ownerId,
      taskId: 'task_expiry',
      agent: 'opencode',
      scope: 'credential.use',
      description: 'Use the deployment token',
      resource: 'deployment_token',
      ttlMs: 1_000,
    });
    started.app.dependencies.clock.now = () => new Date(Date.now() + 60_000);
    const expired = await store.decide({
      ownerId: principal.ownerId,
      taskId: 'task_expiry',
      requestId: request.requestId,
      decision: 'approved',
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.ok === false && expired.code, 'conflict');
    assert.equal(await store.isApproved('task_expiry', 'credential.use', 'deployment_token'), false);
  } finally {
    await started.close();
  }
});

test('the service scopes permission reads and decisions to the owning task', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'approval task',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    await started.app.dependencies.scheduler.idle();

    const listed = await started.app.service.permissions(principal, submitted.value.taskId);
    assert.ok(listed.ok);
    assert.deepEqual(listed.value.requests, []);

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

test('a request is listed for its own task while it is pending', async () => {
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
    const listed = await waitFor(async () => {
      const result = await started.app.service.permissions(principal, submitted.value.taskId);
      return result.ok && result.value.requests.some((entry) => entry.requestId === request.requestId)
        ? result
        : null;
    });
    assert.equal(listed.value.requests[0]?.decision, 'pending');
  } finally {
    await started.close();
  }
});
