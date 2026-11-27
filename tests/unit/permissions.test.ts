import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPermissionGate } from '../../src/permissions/gate.js';
import { createPermissionStore } from '../../src/permissions/store.js';

test('a denied scoped read stays denied after the approval window expires', async () => {
  let now = Date.parse('2026-11-26T00:00:00.000Z');
  const clock = {
    now: () => new Date(now),
    iso: () => new Date(now).toISOString(),
  };
  const permissions = createPermissionStore({
    clock: clock as never,
    ids: { requestId: () => 'req_1' } as never,
  });
  const gate = createPermissionGate({ permissions, clock: clock as never });

  const first = await gate.authorize({
    taskId: 'task_1',
    ownerId: 'owner-test',
    agent: 'coderax',
    scope: 'workspace.read',
    resource: 'notes.txt',
    description: 'Read notes.txt',
  });
  assert.equal(first.decision, 'requested');
  if (first.decision !== 'requested') return;

  const decided = await permissions.decide({
    ownerId: 'owner-test',
    taskId: 'task_1',
    requestId: first.requestId,
    decision: 'denied',
  });
  assert.equal(decided.ok, true);

  // Sixteen minutes later the approval window is over; the owner's denial is not.
  now += 16 * 60_000;
  const resumed = await gate.authorize({
    taskId: 'task_1',
    ownerId: 'owner-test',
    agent: 'coderax',
    scope: 'workspace.read',
    resource: 'notes.txt',
    description: 'Read notes.txt',
  });
  assert.equal(resumed.decision, 'denied');
});
