import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  waitFor,
} from '../helpers.js';

const principal = { ownerId: 'owner-test', isOwner: true as const };

/**
 * Live MongoDB evidence.
 *
 * This suite is skipped unless a real server is named. A fake collection proves
 * the adapter's semantics; it does not prove that a driver, an index, a restart
 * or a second process can store and read the data. Run it with:
 *
 *   CODERAX_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 npm run test:mongo
 */
const uri = process.env.CODERAX_TEST_MONGODB_URI?.trim();
const required = process.env.CODERAX_REQUIRE_MONGODB === '1';

test(
  'tasks, transcripts, events, memory, permissions, receipts, checkpoints and idempotency survive a restart',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGODB_URI is not set', timeout: 120_000 },
  async () => {
    assert.ok(uri, 'CODERAX_REQUIRE_MONGODB=1 requires CODERAX_TEST_MONGODB_URI');
    const workspace = createWorkspaces();
    const database = `coderax_test_${randomUUID().replace(/-/g, '')}`;
    const config = baseConfig(workspace, {
      persistence: { driver: 'mongo', database, collectionPrefix: '' },
      execution: { leaseTtlMs: 10_000, heartbeatIntervalMs: 1_000 },
    });
    const env = {
      CODERAX_OWNER_TOKEN: OWNER_TOKEN,
      CODERAX_MONGODB_URI: uri,
    };
    let taskId = '';
    let conversationId = '';
    let permissionRequestId = '';

    const first = await composeApplication({ config, env, gateway: fakeGateway() });
    try {
      await first.start();
      assert.equal(first.persistence.durable, true);
      const health = await first.dependencies.persistencePing();
      assert.equal(health.ok, true);
      assert.equal(health.durable, true);

      await first.dependencies.memory.put({
        ownerId: principal.ownerId,
        tenantId: null,
        mode: 'private',
        key: 'profile',
        value: 'owner memory',
      });
      const request = {
        objective: 'Persist the release checklist',
        mode: 'cloud' as const,
        requireApproval: true,
        idempotencyKey: 'submission-restart-0001',
      };
      const accepted = await first.service.submitWork(principal, request);
      assert.equal(accepted.ok, true);
      if (!accepted.ok) return;
      taskId = accepted.value.taskId;
      conversationId = accepted.value.conversationId;
      const permission = await first.dependencies.permissions.request({
        ownerId: principal.ownerId,
        taskId,
        agent: 'coderax',
        scope: 'workspace.read',
        description: 'Read the release notes',
        resource: '/release/notes.md',
      });
      permissionRequestId = permission.requestId;
      assert.equal(permission.requestId.length > 0, true);

      const replay = await first.service.submitWork(principal, request);
      assert.equal(replay.ok, true);
      assert.equal(replay.ok && replay.value.taskId, taskId);

      const completed = await waitFor(async () => {
        const status = await first.service.task(principal, taskId);
        return status.ok && status.value.state === 'completed' ? status.value : null;
      });
      assert.equal(completed.generation, 1);
      await first.dependencies.events.flush(taskId);
      const beforeRestartEvents = await first.dependencies.events.read(taskId, 0);
      assert.equal(
        beforeRestartEvents.events.at(-1)?.type,
        'task.completed',
        'the terminal event is durable before the task row is reported complete',
      );
      const beforeRestartCheckpoints = await first.dependencies.checkpoints.list({ taskId });
      assert.ok(beforeRestartCheckpoints.checkpoints.length > 0);
      const beforeRestartReceipts = await first.dependencies.audit.list({
        actor: principal.ownerId,
        taskId,
      });
      assert.ok(
        beforeRestartReceipts.receipts.some((receipt) => receipt.action === 'work.completed'),
      );
    } finally {
      await first.stop();
    }

    const second = await composeApplication({ config, env, gateway: fakeGateway() });
    try {
      await second.start();

      const reopened = await second.service.task(principal, taskId);
      assert.equal(reopened.ok, true);
      assert.equal(reopened.ok && reopened.value.state, 'completed');

      const executions = await second.dependencies.executions.listByTask(taskId);
      assert.equal(executions.length, 1, 'one supervised attempt must survive the restart');
      assert.equal(executions[0]?.cause, 'completed');
      assert.equal(executions[0]?.termination?.status, 'verified');
      assert.ok(
        (await second.dependencies.budget.snapshot(OWNER_ID, new Date())).requests >= 1,
        'the budget reservation is durable, not process-local',
      );

      const conversation = await second.service.conversation(principal, conversationId);
      assert.equal(conversation.ok, true);
      assert.equal(conversation.ok && conversation.value.messages.length, 2);

      const events = await second.dependencies.events.read(taskId, 0);
      assert.equal(events.events.at(-1)?.type, 'task.completed');
      assert.equal(events.truncated, false);

      const notifications = await second.service.notifications(principal, {
        limit: 1,
        unreadOnly: 'true',
      });
      assert.equal(notifications.ok, true);
      assert.ok(notifications.ok);
      assert.equal(notifications.value.total, 1);
      assert.equal(notifications.value.unread, 1);
      assert.equal(notifications.value.notifications[0]?.state, 'completed');

      const taskPage = await second.service.listTasks(principal, { mode: 'cloud', limit: 1 });
      assert.equal(taskPage.ok, true);
      assert.ok(taskPage.ok);
      assert.equal(taskPage.value.total, 1);
      assert.equal(taskPage.value.tasks[0]?.taskId, taskId);

      const receiptPage = await second.service.receipts(principal, taskId, { limit: 1 });
      assert.equal(receiptPage.ok, true);
      assert.ok(receiptPage.ok);
      assert.ok(receiptPage.value.total >= 2);
      assert.equal(receiptPage.value.receipts.length, 1);

      const memory = await second.service.memory(principal, 'private');
      assert.deepEqual(
        memory.entries.map((entry) => [entry.key, entry.value]),
        [['profile', 'owner memory']],
      );
      assert.deepEqual((await second.service.memory(principal, 'cloud')).entries, []);

      const permissions = await second.service.permissions(principal, taskId, {
        decision: 'pending',
        limit: 1,
      });
      assert.equal(permissions.ok, true);
      assert.ok(permissions.ok);
      assert.equal(permissions.value.total, 1);
      assert.equal(permissions.value.requests.length, 1);
      const decided = await second.service.decidePermission(principal, taskId, {
        requestId: permissionRequestId,
        decision: 'approved',
      });
      assert.equal(decided.ok, true);
      assert.equal(
        decided.ok && decided.value.requests[0]?.decision,
        'approved',
      );

      const checkpoints = await second.dependencies.checkpoints.list({ taskId });
      assert.ok(checkpoints.checkpoints.length > 0);

      const receipts = await second.dependencies.audit.list({ taskId });
      assert.ok(receipts.receipts.some((receipt) => receipt.action === 'work.accepted'));
      assert.ok(receipts.receipts.some((receipt) => receipt.action === 'work.completed'));

      const replay = await second.service.submitWork(principal, {
        objective: 'Persist the release checklist',
        mode: 'cloud',
        requireApproval: true,
        idempotencyKey: 'submission-restart-0001',
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.ok && replay.value.taskId, taskId);

      const restarted = await MongoClient.connect(uri!, { directConnection: true });
      try {
        const stored = await restarted
          .db(database)
          .collection('tasks')
          .find({ ownerId: principal.ownerId })
          .toArray();
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.taskId, taskId);
        assert.equal(stored[0]?.state, 'completed');
      } finally {
        await restarted.db(database).dropDatabase();
        await restarted.close();
      }
    } finally {
      await second.stop();
      workspace.cleanup();
    }
  },
);
