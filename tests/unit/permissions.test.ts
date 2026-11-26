import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPermissionStore } from '../../src/permissions/store.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';

const clock = createClock();
const ids = createIdGenerator();

function store() {
  return createPermissionStore({ clock, ids });
}

test('a decision is single-use and cannot authorize a different call', async () => {
  const permissions = store();
  const base = {
    ownerId: 'owner',
    taskId: 'task',
    agent: 'coderax' as const,
    resource: 'report.txt',
    binding: 'digest-of-the-action',
    callId: 'call-1',
    description: 'fs.write: write the report',
  };
  const first = await permissions.request({ ...base, scope: 'workspace.write' });
  const second = await permissions.request({ ...base, scope: 'workspace.read' });
  assert.ok((await permissions.decide({ ...base, requestId: first.requestId, decision: 'approved' })).ok);
  assert.ok((await permissions.decide({ ...base, requestId: second.requestId, decision: 'approved' })).ok);

  // The same call id with a different action digest is not the same decision.
  assert.equal(
    await permissions.lookup({ ...base, scope: 'workspace.write', binding: 'different', consume: true }),
    null,
  );
  const granted = await permissions.lookup({ ...base, scope: 'workspace.write', consume: true });
  assert.equal(granted?.decision, 'granted');
  const replayed = await permissions.lookup({ ...base, scope: 'workspace.write', consume: true });
  assert.equal(replayed?.decision, 'denied');
  // A multi-scope tool has its own row for the second scope.
  assert.equal(
    (await permissions.lookup({ ...base, scope: 'workspace.read', consume: true }))?.decision,
    'granted',
  );

  // A new invocation is a new identity even with identical arguments.
  assert.equal(
    await permissions.lookup({ ...base, callId: 'call-2', scope: 'workspace.write', consume: true }),
    null,
  );
});

test('a denied decision is reported and never granted', async () => {
  const permissions = store();
  const request = await permissions.request({
    ownerId: 'owner',
    taskId: 'task',
    agent: 'coderax',
    scope: 'command.execute',
    resource: 'git status',
    binding: 'digest',
    callId: 'call-3',
    description: 'shell.run',
  });
  assert.ok((await permissions.decide({
    ownerId: 'owner', taskId: 'task', requestId: request.requestId, decision: 'denied',
  })).ok);
  const decision = await permissions.lookup({
    ownerId: 'owner',
    taskId: 'task',
    scope: 'command.execute',
    resource: 'git status',
    binding: 'digest',
    callId: 'call-3',
    consume: true,
  });
  assert.equal(decision?.decision, 'denied');
});

test('an expired request is not returned', async () => {
  const permissions = store();
  const request = await permissions.request({
    ownerId: 'owner',
    taskId: 'task',
    agent: 'coderax',
    scope: 'workspace.write',
    resource: 'old.txt',
    binding: 'digest',
    callId: 'call-4',
    description: 'fs.write',
    ttlMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await permissions.decide({
    ownerId: 'owner', taskId: 'task', requestId: request.requestId, decision: 'approved',
  });
  assert.equal(
    await permissions.lookup({
      ownerId: 'owner',
      taskId: 'task',
      scope: 'workspace.write',
      resource: 'old.txt',
      binding: 'digest',
      callId: 'call-4',
      consume: true,
    }),
    null,
  );
});
