import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { composeApplication } from '../../src/bootstrap/compose.js';
import { workRunKey } from '../../src/execution/lease.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  taskRecord,
  waitFor,
} from '../helpers.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };

/**
 * Two engine processes against one real MongoDB.
 *
 * A fake collection cannot prove that two replicas arbitrate a lease, consume a
 * grant once or agree on the task a duplicate submission created, because a fake
 * has no server-side atomicity. `CODERAX_REQUIRE_MONGODB=1` turns a missing URI
 * into a failure instead of a skip, so a CI lane cannot report green while the
 * database evidence did not run.
 */
const uri = process.env.CODERAX_TEST_MONGODB_URI?.trim();
const required = process.env.CODERAX_REQUIRE_MONGODB === '1';

test(
  'two replicas share one durable execution, lease, grant and read model',
  {
    skip: uri ? false : required ? false : 'CODERAX_TEST_MONGODB_URI is not set',
    timeout: 180_000,
  },
  async () => {
    assert.ok(uri, 'CODERAX_REQUIRE_MONGODB=1 requires CODERAX_TEST_MONGODB_URI');
    const workspace = createWorkspaces();
    const database = `coderax_replicas_${randomUUID().replace(/-/g, '')}`;
    const config = baseConfig(workspace, {
      persistence: { driver: 'mongo', database, collectionPrefix: '' },
      execution: { leaseTtlMs: 5_000, heartbeatIntervalMs: 500 },
    });
    const env = {
      CODERAX_OWNER_TOKEN: OWNER_TOKEN,
      CODERAX_MONGODB_URI: uri,
      CODERAX_DEPLOYMENT_REVISION: 'replica-test-rev-1',
    };
    const first = await composeApplication({ config, env, gateway: fakeGateway() });
    const second = await composeApplication({ config, env, gateway: fakeGateway() });

    try {
      await first.start();
      await second.start();

      // Readiness is component-level, not "the process answered".
      const readiness = await first.service.readiness();
      assert.equal(readiness.ready, true);
      const names = new Set(readiness.checks.map((check) => check.name));
      for (const required of ['api', 'persistence', 'scheduler', 'models', 'events.durable', 'artifacts.storage']) {
        assert.ok(names.has(required), `readiness is missing ${required}`);
      }
      assert.equal(first.service.handshake().deploymentRevision, 'replica-test-rev-1');
      assert.equal(
        first.service.handshake().capabilities.executionSupervisor.state,
        'available',
        'the supervisor capability is reported only because it is enforced',
      );

      // Concurrent duplicate submissions across replicas.
      const request = {
        objective: 'Replicated durable work',
        mode: 'cloud' as const,
        requireApproval: true,
        idempotencyKey: 'replica-idempotency-0001',
      };
      const attempts = await Promise.all([
        first.service.submitWork(principal, request),
        second.service.submitWork(principal, request),
      ]);
      const accepted = attempts.filter((entry) => entry.ok);
      assert.ok(accepted.length >= 1, 'at least one replica must accept the submission');
      const taskIds = new Set(
        accepted.map((entry) => (entry.ok ? entry.value.taskId : '')),
      );
      assert.equal(taskIds.size, 1, 'both accepted replicas must reference one task');
      const taskId = [...taskIds][0]!;

      // A retryable conflict is recoverable: the same key returns the same task.
      if (accepted.length < 2) {
        const retried = await second.service.submitWork(principal, request);
        assert.equal(retried.ok, true);
        assert.equal(retried.ok && retried.value.taskId, taskId);
      }

      const completed = await waitFor(async () => {
        const status = await first.service.task(principal, taskId);
        return status.ok && status.value.state === 'completed' ? status.value : null;
      });
      assert.equal(completed.generation, 1);

      const record = await second.dependencies.tasks.get(taskId);
      assert.ok(record);
      assert.equal(record.conversationId.length > 0, true);

      // One transcript, visible identically from either replica. The terminal
      // state is authoritative first; the assistant row follows it, so readiness
      // of the read model is asserted as convergence, not as an instant read.
      await waitFor(async () => {
        const current = await second.service.conversation(principal, record.conversationId);
        return current.ok && current.value.messages.length === 2 ? current.value : null;
      });
      const fromFirst = await first.service.conversation(principal, record.conversationId);
      const fromSecond = await second.service.conversation(principal, record.conversationId);
      assert.equal(fromFirst.ok, true);
      assert.equal(fromSecond.ok, true);
      assert.equal(fromFirst.ok && fromFirst.value.messages.length, 2);
      assert.equal(fromSecond.ok && fromSecond.value.messages.length, 2);
      assert.equal(
        fromSecond.ok && fromSecond.value.messages[0]?.text,
        'Replicated durable work',
      );

      // The second replica can replay the terminal event the first wrote.
      const replay = await second.service.events(principal, taskId, 0);
      assert.equal(replay.ok, true);
      assert.ok(replay.ok);
      assert.equal(replay.value.replay.events.at(-1)?.type, 'task.completed');

      // Notifications are deduplicated by task, not by replica.
      await waitFor(async () => {
        const current = await second.service.notifications(principal, { limit: 10 });
        return current.ok && current.value.total === 1 ? current.value : null;
      });
      const firstNotifications = await first.service.notifications(principal, { limit: 10 });
      const secondNotifications = await second.service.notifications(principal, { limit: 10 });
      assert.equal(firstNotifications.ok, true);
      assert.equal(secondNotifications.ok, true);
      assert.equal(firstNotifications.ok && firstNotifications.value.total, 1);
      assert.equal(secondNotifications.ok && secondNotifications.value.unread, 1);

      // A persisted conversation is owner-scoped, not merely task-scoped.
      const foreign = await second.dependencies.conversations.get(
        'someone-else',
        record.conversationId,
      );
      assert.equal(foreign, null);

      // Concurrent memory writes converge on one row.
      await Promise.all([
        first.dependencies.memory.put({
          ownerId: OWNER_ID,
          tenantId: null,
          mode: 'cloud',
          key: 'shared',
          value: 'first',
        }),
        second.dependencies.memory.put({
          ownerId: OWNER_ID,
          tenantId: null,
          mode: 'cloud',
          key: 'shared',
          value: 'second',
        }),
      ]);
      const memory = await first.service.memory(principal, 'cloud');
      assert.equal(memory.entries.filter((entry) => entry.key === 'shared').length, 1);

      // Lease arbitration: only one replica may own a conversation's run.
      const key = workRunKey({
        ownerId: OWNER_ID,
        tenantId: null,
        conversationId: 'conv_replica_lease',
      });
      const now = new Date();
      const expires = new Date(now.getTime() + 5_000);
      assert.equal(
        await first.dependencies.lease.claim({
          key,
          owner: OWNER_ID,
          token: 'run_replica_a',
          now,
          expiresAt: expires,
        }),
        true,
      );
      assert.equal(
        await second.dependencies.lease.claim({
          key,
          owner: OWNER_ID,
          token: 'run_replica_b',
          now,
          expiresAt: expires,
        }),
        false,
        'the second replica must not steal a live lease',
      );

      // One approval, consumed exactly once across two racing replicas.
      const permission = await first.dependencies.permissions.request({
        ownerId: OWNER_ID,
        taskId,
        agent: 'coderax',
        scope: 'command.execute',
        description: 'Run the release command',
        resource: 'release',
        binding: 'git tag v1.1.0',
      });
      const approved = await first.service.decidePermission(principal, taskId, {
        requestId: permission.requestId,
        decision: 'approved',
      });
      assert.equal(approved.ok, true);
      const grant = {
        ownerId: OWNER_ID,
        taskId,
        scope: 'command.execute' as const,
        resource: 'release',
        binding: 'git tag v1.1.0',
        consume: true,
      };
      const [left, right] = await Promise.all([
        first.dependencies.permissions.lookup(grant),
        second.dependencies.permissions.lookup(grant),
      ]);
      assert.equal([left, right].filter((entry) => entry?.decision === 'granted').length, 1);
      assert.equal([left, right].filter((entry) => entry === null).length, 1);
      assert.equal(
        await second.dependencies.permissions.isApproved(taskId, 'command.execute', 'release'),
        false,
        'a consumed grant can never authorize a second action',
      );

      // Durable quarantine: one replica abandons an execution, and the other
      // refuses the same workspace rather than writing beside it.
      const quarantineIdentity = (executionId: string) => ({
        executionId,
        kind: 'work' as const,
        taskId: null,
        conversationId: 'conv_quarantine',
        ownerId: OWNER_ID,
        tenantId: null,
        agent: 'coderax' as const,
        mode: 'cloud' as const,
        generation: 1,
        token: null,
      });
      const abandoned = await first.dependencies.supervisor.run({
        identity: quarantineIdentity('exec_quarantine_a'),
        adapter: { agent: 'coderax', workload: 'in-process' },
        workspaceRoot: workspace.cloudRoot,
        scopes: ['workspace.write'],
        launch: async () => ({
          outcome: { kind: 'cancelled' as const, abandoned: true },
          abandoned: true,
        }),
      });
      assert.equal(abandoned.admitted, true);
      assert.equal(abandoned.admitted && abandoned.termination.kind, 'unverified');
      assert.equal(abandoned.admitted && abandoned.workspaceHeld, true);
      assert.ok(
        await second.dependencies.quarantine.find(workspace.cloudRoot, Date.now()),
        'the hold must be visible to the replica that never ran the workload',
      );
      const refusedByHold = await second.dependencies.supervisor.run({
        identity: quarantineIdentity('exec_quarantine_b'),
        adapter: { agent: 'coderax', workload: 'in-process' },
        workspaceRoot: workspace.cloudRoot,
        scopes: ['workspace.write'],
        launch: async () => ({ outcome: { kind: 'completed' as const, summary: 'unreachable' } }),
      });
      assert.equal(refusedByHold.admitted, false);
      assert.equal(refusedByHold.admitted === false && refusedByHold.code, 'workspace_denied');
      await second.dependencies.quarantine.release(workspace.cloudRoot);

      // Retention never removes user history or anything an execution needs.
      const ancient = taskRecord({
        taskId: 'task_ancient',
        conversationId: 'conv_ancient',
        ownerId: OWNER_ID,
        createdAt: '2016-01-01T00:00:00.000Z',
        updatedAt: '2016-01-01T00:00:00.000Z',
      });
      const created = await first.dependencies.tasks.create(ancient);
      assert.equal(created.ok, true);
      await first.dependencies.retention.run();
      assert.ok(await first.dependencies.tasks.get('task_ancient'));
      assert.ok(await second.dependencies.tasks.get(taskId));
      assert.ok(await second.dependencies.conversations.get(OWNER_ID, record.conversationId));

      // Bounded retention for the durable execution and budget ledgers: the
      // sweep on one replica removes a finished attempt and a settled
      // reservation for both. A live attempt and a reserved allowance are never
      // removed, because they are current ownership and admission state.
      assert.equal(
        await first.dependencies.executions.create({
          ...quarantineIdentity('exec_retention'),
          workspaceRoot: workspace.privateRoot,
          phase: 'starting',
          cause: null,
          startedAt: '2016-01-01T00:00:00.000Z',
          lastHeartbeatAt: '2016-01-01T00:00:00.000Z',
          finishedAt: null,
          termination: null,
          capabilityRevokedAt: null,
          processUseCount: 0,
        }),
        true,
      );
      await first.dependencies.executions.finish({
        executionId: 'exec_retention',
        cause: 'completed',
        finishedAt: '2016-01-01T00:00:00.000Z',
        capabilityRevokedAt: '2016-01-01T00:00:00.000Z',
        processUseCount: 0,
        termination: {
          status: 'verified',
          method: 'no-child-processes',
          observedAt: '2016-01-01T00:00:00.000Z',
        },
      });
      const oldBudget = await first.dependencies.budget.reserve({
        ownerId: OWNER_ID,
        at: new Date('2016-01-01T00:00:00.000Z'),
        inputTokens: 1,
        outputTokens: 1,
        reservationId: 'budget_retention',
      });
      assert.equal(oldBudget.allowed, true);
      assert.equal(
        await first.dependencies.budget.settle('budget_retention', {
          inputTokens: 1,
          outputTokens: 1,
        }),
        true,
      );

      const swept = await second.dependencies.retention.run();
      assert.equal(swept.deleted.executions, 1);
      assert.equal(swept.deleted.budgetReservations, 1);
      assert.equal(await first.dependencies.executions.get('exec_retention'), null);
      assert.equal(
        await first.dependencies.budget.release('budget_retention'),
        false,
        'the settled reservation is gone for every replica',
      );
    } finally {
      await first.stop().catch(() => undefined);
      await second.stop().catch(() => undefined);
      const client = await MongoClient.connect(uri!, { directConnection: true });
      try {
        await client.db(database).dropDatabase();
      } finally {
        await client.close();
      }
      workspace.cleanup();
    }
  },
);

test(
  'two replicas share one durable budget reservation',
  {
    skip: uri ? false : required ? false : 'CODERAX_TEST_MONGODB_URI is not set',
    timeout: 120_000,
  },
  async () => {
    assert.ok(uri, 'CODERAX_REQUIRE_MONGODB=1 requires CODERAX_TEST_MONGODB_URI');
    const workspace = createWorkspaces();
    const database = `coderax_budget_${randomUUID().replace(/-/g, '')}`;
    const config = baseConfig(workspace, {
      persistence: { driver: 'mongo', database, collectionPrefix: '' },
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        dailyRequestBudget: 1,
        dailyTokenBudget: 2_000_000,
      },
    });
    const env = {
      CODERAX_OWNER_TOKEN: OWNER_TOKEN,
      CODERAX_MONGODB_URI: uri,
    };
    const first = await composeApplication({ config, env, gateway: fakeGateway() });
    const second = await composeApplication({ config, env, gateway: fakeGateway() });
    try {
      await first.start();
      await second.start();
      const submissions = await Promise.all([
        first.service.submitWork(principal, {
          objective: 'Budget contender A',
          mode: 'cloud',
          requireApproval: false,
          idempotencyKey: 'budget-replica-a',
        }),
        second.service.submitWork(principal, {
          objective: 'Budget contender B',
          mode: 'cloud',
          requireApproval: false,
          idempotencyKey: 'budget-replica-b',
        }),
      ]);
      const accepted = submissions.filter((entry) => entry.ok);
      const refused = submissions.filter(
        (entry) => !entry.ok && entry.code === 'budget_exhausted',
      );
      assert.equal(accepted.length, 1, 'only one replica may take the single request slot');
      assert.equal(refused.length, 1, 'the other must fail closed on the shared reservation');

      const replay = await second.service.submitWork(principal, {
        objective: 'Budget contender C',
        mode: 'cloud',
        requireApproval: false,
        idempotencyKey: 'budget-replica-c',
      });
      assert.equal(replay.ok, false);
      assert.equal(replay.ok === false && replay.code, 'budget_exhausted');

      const left = await first.service.budget(principal);
      const right = await second.service.budget(principal);
      assert.equal(left.used.requests, 1);
      assert.equal(right.used.requests, 1, 'both replicas read the same counter');
    } finally {
      await first.stop().catch(() => undefined);
      await second.stop().catch(() => undefined);
      const client = await MongoClient.connect(uri!, { directConnection: true });
      try {
        await client.db(database).dropDatabase();
      } finally {
        await client.close();
      }
      workspace.cleanup();
    }
  },
);
