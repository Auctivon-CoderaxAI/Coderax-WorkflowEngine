import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ProviderAdapter } from '../../src/models/types.js';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { baseConfig, createWorkspaces, fakeProvider, OWNER_ID, OWNER_TOKEN, slowProvider, startTestApp, taskRecord, waitFor, type TestWorkspace } from '../helpers.js';
import { createFakeDatabase, type FakeDatabase } from '../fakes/mongo.js';
import { workRunKey } from '../../src/execution/lease.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import { createMongoEventLog, ensureEventIndexes } from '../../src/persistence/mongo-events.js';

const principal = { ownerId: OWNER_ID, isOwner: true as const };

/**
 * Builds the whole engine over a fake MongoDB. The fake enforces the unique
 * indexes and cursor semantics the stores declare, so this proves the real
 * repository path — not the in-memory maps — and a second application over the
 * same database is a genuine restart of the process.
 */
async function mongoApp(input: {
  database: FakeDatabase;
  workspace: TestWorkspace;
  provider?: ProviderAdapter;
  execution?: Record<string, unknown>;
}): Promise<Application> {
  const config = baseConfig(input.workspace, {
    persistence: { driver: 'mongo' },
    ...(input.execution ? { execution: input.execution } : {}),
  });
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    providers: [{ adapter: input.provider ?? fakeProvider() }],
    persistence: { database: input.database },
  });
  await app.start();
  return app;
}

function collection(database: FakeDatabase, name: string) {
  return database.collection(name);
}

async function seedConversation(database: FakeDatabase, conversationId: string): Promise<void> {
  const now = new Date().toISOString();
  await collection(database, 'conversations').insertOne({
    conversationId,
    ownerId: OWNER_ID,
    tenantId: null,
    title: 'recovery',
    mode: 'cloud',
    isWork: true,
    agent: 'coderax',
    createdAt: now,
    updatedAt: now,
  });
}

test('a crash after the terminal task write is repaired from the record on restart', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const now = new Date().toISOString();
  const taskId = 'task_crash';
  const conversationId = 'conv_crash';

  // Exactly what a crash between the fenced terminal write and the derived writes
  // leaves behind: a completed task with no event, no message and no notification.
  await seedConversation(database, conversationId);
  await collection(database, 'tasks').insertOne({
    ...taskRecord({
      taskId,
      conversationId,
      state: 'completed',
      runToken: 'run_crash',
      updatedAt: now,
      checkpoint: { completedSteps: ['step-1'], text: 'the complete answer' },
      result: { summary: 'the complete answer', artifacts: [] },
    }),
  });

  const app = await mongoApp({ database, workspace });
  try {
    const replay = await app.dependencies.events.read(taskId, 0);
    assert.deepEqual(replay.events.map((event) => event.seq), [1]);
    assert.equal(replay.events[0]?.type, 'task.completed');

    const notifications = await app.service.notifications(principal);
    assert.ok(notifications.notifications.some((entry) => entry.taskId === taskId));

    const conversation = await app.service.conversation(principal, conversationId);
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.length, 1);
    assert.equal(conversation.value.messages[0]?.text, 'the complete answer');
  } finally {
    await app.stop();
  }

  // A second restart must not append a second ending, message or notification.
  // Simulate a settlement from the legacy random-id writer.
  await collection(database, 'messages').updateOne({ conversationId, role: 'assistant' },
    { $set: { messageId: randomUUID() } }, { upsert: false });
  const restarted = await mongoApp({ database, workspace });
  try {
    const replay = await restarted.dependencies.events.read(taskId, 0);
    assert.equal(replay.events.filter((event) => event.type === 'task.completed').length, 1);
    const conversation = await restarted.service.conversation(principal, conversationId);
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.length, 1);
    const notifications = await restarted.service.notifications(principal);
    assert.equal(
      notifications.notifications.filter((entry) => entry.taskId === taskId).length,
      1,
    );
  } finally {
    await restarted.stop();
    workspace.cleanup();
  }
});

test('a running task whose lease row was pruned is retired as interrupted', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const now = new Date().toISOString();
  const taskId = 'task_orphan';
  const conversationId = 'conv_orphan';

  // No work_runs row at all: retention may have removed it after the crash. A
  // missing row must not mean "still running".
  await seedConversation(database, conversationId);
  await collection(database, 'tasks').insertOne({
    ...taskRecord({
      taskId,
      conversationId,
      state: 'running',
      runToken: 'run_gone',
      updatedAt: now,
    }),
  });

  const app = await mongoApp({ database, workspace });
  try {
    const status = await app.service.task(principal, taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'interrupted');
    assert.equal(status.value.failure?.code, 'server_unavailable');

    const replay = await app.dependencies.events.read(taskId, 0);
    assert.equal(replay.events.at(-1)?.type, 'task.interrupted');
    const notifications = await app.service.notifications(principal);
    assert.ok(notifications.notifications.some((entry) => entry.taskId === taskId));

    // A second recovery pass is a no-op: an interrupted task is terminal.
    const second = await app.service.recoverInterrupted();
    assert.deepEqual(second, { interrupted: 0, repaired: 0 });
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('a rejected submission leaves no orphaned user message', async () => {
  const started = await startTestApp({ provider: slowProvider(60_000) });
  try {
    const first = await started.app.service.submitWork(principal, {
      objective: 'first objective',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(first.ok);
    if (!first.ok) return;

    const second = await started.app.service.submitWork(principal, {
      objective: 'rejected objective',
      conversationId: first.value.conversationId,
      mode: 'cloud',
      requireApproval: true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.code, 'busy');

    const conversation = await started.app.service.conversation(
      principal,
      first.value.conversationId,
    );
    assert.ok(conversation.ok);
    const userTurns = conversation.value.messages.filter((message) => message.role === 'user');
    assert.equal(userTurns.length, 1);
    assert.equal(userTurns[0]?.text, 'first objective');
    assert.equal(
      conversation.value.messages.filter((message) => message.text === 'rejected objective').length,
      0,
    );

    await started.app.service.cancelTask(principal, first.value.taskId);
    await started.app.dependencies.scheduler.idle();
  } finally {
    await started.close();
  }
});

test('a failure that is not retryable is refused a retry instead of replayed', async () => {
  const started = await startTestApp();
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    // A post-dispatch failure: the adapter reports it as not retryable, so
    // neither the bounded policy nor an owner retry may replay it.
    agent.run = async () => ({
      ok: false,
      code: 'provider_error',
      detail: 'The provider rejected the request.',
      retryable: false,
    });

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'unsafe to replay',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;

    const failed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'failed' ? status.value : null;
    });
    assert.equal(failed.failure?.code, 'provider_error');

    const retried = await started.app.service.retryTask(
      principal,
      submitted.value.taskId,
      failed.generation,
    );
    assert.equal(retried.ok, false);
    assert.equal(retried.ok === false && retried.code, 'conflict');

    const unchanged = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(unchanged.ok);
    assert.equal(unchanged.value.state, 'failed');
    assert.equal(unchanged.value.generation, failed.generation);
  } finally {
    await started.close();
  }
});

test('a graceful stop interrupts an adapter that is still running and releases its lease', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const app = await mongoApp({
    database,
    workspace,
    provider: slowProvider(60_000),
    execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500, cancelGraceMs: 150 },
  });
  const agent = app.dependencies.agents.get('coderax');
  assert.ok(agent);
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const update = app.dependencies.tasks.updateFenced;
  app.dependencies.tasks.updateFenced = async input => {
    if (input.patch.checkpoint) await writeGate;
    return update(input);
  };
  // An adapter that ignores the abort: the process must still leave a recoverable
  // record and no live lease behind.
  agent.run = async (_request, report) => {
    report({ type: 'text.delta', text: 'partial result' });
    // The step boundary snapshots the accumulated text into the checkpoint.
    report({ type: 'step.completed', stepId: 'step-1', title: 'One' });
    entered();
    return new Promise(() => {});
  };

  const submitted = await app.service.submitWork(principal, {
    objective: 'interrupt me',
    mode: 'cloud',
    requireApproval: true,
  });
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  await running;

  const stopping = app.stop();
  // Let the runner finish its cancellation grace while the accepted write is blocked.
  await new Promise(resolve => setTimeout(resolve, 300));
  releaseWrite();
  await stopping;

  const task = await app.dependencies.tasks.get(submitted.value.taskId);
  assert.equal(task?.state, 'interrupted');
  assert.deepEqual(task?.checkpoint.completedSteps, ['step-1']);
  assert.equal(task?.checkpoint.text, 'partial result');

  const lease = await app.dependencies.lease.read({
    key: workRunKey({
      ownerId: OWNER_ID,
      tenantId: null,
      conversationId: submitted.value.conversationId,
    }),
    now: new Date(),
  });
  assert.equal(lease, null);

  const replay = await app.dependencies.events.read(submitted.value.taskId, 0);
  assert.equal(replay.events.at(-1)?.type, 'task.interrupted');
  const notifications = await app.dependencies.notifications.list(OWNER_ID);
  assert.ok(notifications.notifications.some((entry) => entry.taskId === submitted.value.taskId));

  // A restart repairs nothing further and does not duplicate the ending.
  const restarted = await mongoApp({ database, workspace });
  try {
    const retry = await restarted.service.retryTask(principal, submitted.value.taskId, task!.generation);
    assert.equal(retry.ok, false);
    const again = await restarted.dependencies.events.read(submitted.value.taskId, 0);
    assert.equal(
      again.events.filter((event) => event.type === 'task.interrupted').length,
      1,
    );
    const persisted = await restarted.dependencies.tasks.get(submitted.value.taskId);
    assert.deepEqual(persisted?.checkpoint.completedSteps, ['step-1']);
  } finally {
    await restarted.stop();
    workspace.cleanup();
  }
});

test('a resume continues completed steps instead of repeating them', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    const seen: Array<{ completed: string[]; priorText: string }> = [];
    let abortOld!: (error: Error) => void;
    agent.run = async (request, report) => {
      seen.push({
        completed: [...(request.context?.completedSteps ?? [])],
        priorText: request.context?.priorText ?? '',
      });
      if (seen.length === 1) {
        report({ type: 'text.delta', text: 'first result' });
        report({ type: 'step.completed', stepId: 'step-1', title: 'One' });
        await new Promise<void>((_resolve, reject) => {
          abortOld = reject;
        });
        return { ok: true, summary: 'unreachable' };
      }
      report({ type: 'text.delta', text: ' second result' });
      report({ type: 'step.completed', stepId: 'step-2', title: 'Two' });
      return { ok: true, summary: 'first result second result' };
    };

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'resume without repeating',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await waitFor(async () => {
      const task = await deps.tasks.get(submitted.value.taskId);
      return task?.checkpoint.completedSteps.includes('step-1') ? true : null;
    });

    // The lease expires without a heartbeat: the run is recoverable.
    deps.clock.now = () => new Date(Date.now() + 60_000);
    const resumed = await started.app.service.resumeTask(
      principal,
      submitted.value.taskId,
      submitted.value.generation,
    );
    assert.ok(resumed.ok && resumed.value.outcome === 'accepted');

    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.equal(completed.generation, 2);

    // Two invocations total: the completed step was never run a second time.
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]?.completed, ['step-1']);
    assert.equal(seen[1]?.priorText, 'first result');

    abortOld(new Error('aborted'));
    await deps.scheduler.idle();

    const conversation = await started.app.service.conversation(
      principal,
      submitted.value.conversationId,
    );
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.at(-1)?.text, 'first result second result');
  } finally {
    await started.close();
  }
});

test('lease retention prunes an expired row at startup and keeps a live one', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const workRuns = collection(database, 'work_runs');
  await workRuns.insertOne({
    key: 'stale-lease',
    owner: OWNER_ID,
    token: 'run_stale',
    cancelRequested: false,
    expiresAt: new Date(Date.now() - 2 * 86_400_000),
  });
  await workRuns.insertOne({
    key: 'live-lease',
    owner: OWNER_ID,
    token: 'run_live',
    cancelRequested: false,
    expiresAt: new Date(Date.now() + 60_000),
  });

  const app = await mongoApp({ database, workspace });
  try {
    assert.equal(await workRuns.findOne({ key: 'stale-lease' }), null);
    assert.notEqual(await workRuns.findOne({ key: 'live-lease' }), null);
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('the event stream honours the after cursor and Last-Event-ID', async () => {
  const started = await startTestApp();
  try {
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'stream every event',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();

    const all = await started.app.dependencies.events.read(submitted.value.taskId, 0);
    assert.ok(all.events.length > 4);
    const lastSeq = all.events.at(-1)?.seq ?? 0;
    assert.equal(all.events.at(-1)?.type, 'task.completed');

    const read = async (path: string, headers: Record<string, string>): Promise<number[]> => {
      const response = await fetch(`${started.url}${path}`, {
        headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...headers },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    };

    const afterQuery = await read(`/v1/work/${submitted.value.taskId}/events?after=3`, {});
    assert.equal(afterQuery[0], 4);
    assert.equal(afterQuery.at(-1), lastSeq);

    const afterHeader = await read(`/v1/work/${submitted.value.taskId}/events`, {
      'last-event-id': '5',
    });
    assert.equal(afterHeader[0], 6);
    assert.equal(afterHeader.at(-1), lastSeq);
  } finally {
    await started.close();
  }
});

test('a retryable pre-dispatch failure is replayed inside the same lease and generation', async () => {
  const started = await startTestApp({
    config: {
      execution: { maxAttempts: 2, retryDelayMs: 0, leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
    },
  });
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let calls = 0;
    agent.run = async (_request, report) => {
      calls += 1;
      if (calls === 1) {
        report({ type: 'text.delta', text: 'discarded attempt' });
        return {
          ok: false,
          code: 'server_unavailable',
          detail: 'The endpoint refused before dispatch.',
          retryable: true,
          preDispatch: true,
        };
      }
      report({ type: 'text.delta', text: 'final answer' });
      return { ok: true, summary: 'final answer' };
    };

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'retry inside the lease',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    const completed = await waitFor(async () => {
      const status = await started.app.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });

    assert.equal(calls, 2);
    // The replay is the same generation on the same engine, with one ending.
    assert.equal(completed.generation, 1);
    const events = await deps.events.read(submitted.value.taskId, 0);
    assert.equal(events.events.filter((event) => event.type === 'task.completed').length, 1);
    assert.ok(
      events.events.some(
        (event) => event.type === 'text.replace' && (event.payload as { text: string }).text === '',
      ),
    );

    const conversation = await started.app.service.conversation(
      principal,
      submitted.value.conversationId,
    );
    assert.ok(conversation.ok);
    assert.equal(conversation.value.messages.at(-1)?.text, 'final answer');
  } finally {
    await started.close();
  }
});

test('an ambiguous post-dispatch failure is not replayed automatically even when retryable', async () => {
  const started = await startTestApp({
    config: {
      execution: { maxAttempts: 3, retryDelayMs: 0, leaseTtlMs: 3_000, heartbeatIntervalMs: 500 },
    },
  });
  try {
    const agent = started.app.dependencies.agents.get('coderax');
    assert.ok(agent);
    let calls = 0;
    agent.run = async () => {
      calls += 1;
      return {
        ok: false,
        code: 'provider_error',
        detail: 'The provider failed after accepting the request.',
        retryable: true,
      };
    };

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'not replayable',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await started.app.dependencies.scheduler.idle();
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'failed');
    assert.equal(calls, 1);
  } finally {
    await started.close();
  }
});

test('a rejected checkpoint write is contained and the run still settles', async () => {
  const started = await startTestApp();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    const deps = started.app.dependencies;
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    const update = deps.tasks.updateFenced;
    let failed = 0;
    deps.tasks.updateFenced = async (input) => {
      // Only the step checkpoint fails; start and settlement still work.
      if (input.patch.checkpoint && failed === 0) {
        failed += 1;
        throw new Error('checkpoint storage unavailable');
      }
      return update(input);
    };
    agent.run = async (_request, report) => {
      report({ type: 'step.completed', stepId: 'step-1', title: 'One' });
      return { ok: true, summary: 'done' };
    };

    const submitted = await started.app.service.submitWork(principal, {
      objective: 'contain a rejected write',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await deps.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(failed, 1);
    assert.deepEqual(rejections, []);
    const status = await started.app.service.task(principal, submitted.value.taskId);
    assert.ok(status.ok);
    assert.equal(status.value.state, 'completed');
  } finally {
    process.off('unhandledRejection', onRejection);
    await started.close();
  }
});

test('a notification lost during settlement is repaired after a restart', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const app = await mongoApp({ database, workspace });
  let taskId = '';
  try {
    app.dependencies.notifications.record = async () => {
      throw new Error('notification storage unavailable');
    };
    const submitted = await app.service.submitWork(principal, {
      objective: 'notify after a crash',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    taskId = submitted.value.taskId;
    await waitFor(async () => {
      const status = await app.service.task(principal, taskId);
      return status.ok && status.value.state === 'completed' ? true : null;
    });
    const before = await app.service.notifications(principal);
    assert.equal(before.notifications.filter((entry) => entry.taskId === taskId).length, 0);
  } finally {
    await app.stop();
  }

  const restarted = await mongoApp({ database, workspace });
  try {
    const after = await restarted.service.notifications(principal);
    assert.equal(after.notifications.filter((entry) => entry.taskId === taskId).length, 1);
    const replay = await restarted.dependencies.events.read(taskId, 0);
    assert.equal(replay.events.filter((event) => event.type === 'task.completed').length, 1);
  } finally {
    await restarted.stop();
    workspace.cleanup();
  }
});

test('the arbiter is on the execution path and refuses a duplicate generation', async () => {
  const started = await startTestApp();
  try {
    const deps = started.app.dependencies;
    const key = 'scope:run-token';
    assert.equal(deps.arbiter.acquire(key, 'native').ok, true);
    const duplicate = deps.arbiter.acquire(key, 'native');
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.ok === false && duplicate.code, 'busy');
    deps.arbiter.release(key, 'native');
    assert.equal(deps.arbiter.acquire(key, 'native').ok, true);

    // The service consults it before starting an adapter: a refused admission
    // leaves the task queued rather than running two engines for one token.
    const acquire = deps.arbiter.acquire.bind(deps.arbiter);
    deps.arbiter.acquire = () => ({
      ok: false,
      code: 'busy',
      detail: 'test refusal',
      retryable: false,
    });
    const submitted = await started.app.service.submitWork(principal, {
      objective: 'never admitted',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await deps.scheduler.idle();
    const task = await deps.tasks.get(submitted.value.taskId);
    assert.equal(task?.state, 'queued');
    deps.arbiter.acquire = acquire;
  } finally {
    await started.close();
  }
});

test('the memory driver is reported as process-local and the fake MongoDB as mongo', async () => {
  const memory = await startTestApp();
  try {
    assert.equal(memory.app.persistence.driver, 'memory');
  } finally {
    await memory.close();
  }

  const workspace = createWorkspaces();
  const database = createFakeDatabase();
  const mongo = await mongoApp({ database, workspace });
  try {
    assert.equal(mongo.persistence.driver, 'mongo');
  } finally {
    await mongo.stop();
    workspace.cleanup();
  }
});

/**
 * The real-database check is opt-in and reported as skipped otherwise. No live
 * MongoDB is contacted without an authorized connection string, and a skipped
 * test is never counted as durable verification. CI provides the database as a
 * service container, so it also sets CODERAX_REQUIRE_LIVE_MONGO: a missing
 * connection string then fails the run instead of dropping the only
 * real-database evidence in silence.
 */
const mongoUri = process.env.CODERAX_MONGODB_URI?.trim();
if (process.env.CODERAX_REQUIRE_LIVE_MONGO === '1' && !mongoUri) {
  test('a live MongoDB is required but CODERAX_MONGODB_URI is empty', () => {
    assert.fail(
      'CODERAX_REQUIRE_LIVE_MONGO is set but CODERAX_MONGODB_URI is empty, so the live-persistence test would have been skipped',
    );
  });
}
test(
  'a real MongoDB stores the stream and resumes its sequence after a restart',
  {
    skip: mongoUri
      ? false
      : 'CODERAX_MONGODB_URI is not set: no live MongoDB was contacted, so live persistence is unverified',
  },
  async () => {
    const uri = mongoUri as string;
    const databaseName = `coderax_verify_${randomUUID().replace(/-/g, '')}`;
    const connect = createMongoConnector();
    const database = await connect({ uri, database: databaseName });
    const events = database.collection('events');
    const heads = database.collection('event_heads');
    try {
      await ensureEventIndexes({ events, heads });
      const log = createMongoEventLog({ events, heads });
      const base = {
        v: 1 as const,
        taskId: 'task_live',
        at: new Date().toISOString(),
        agent: 'coderax' as const,
        generation: 1,
      };
      assert.deepEqual(await log.append({ ...base, eventId: 'live-1', seq: 1, type: 'task.queued' }), {
        appended: true,
      });
      assert.deepEqual(await log.append({ ...base, eventId: 'live-2', seq: 2, type: 'task.started' }), {
        appended: true,
      });
      // A redelivery is refused, but it must be reported as the same `duplicate`
      // the in-memory log reports: the bus treats `duplicate` as benign and
      // `out_of_order` as a settlement failure, so the wrong reason would fail a
      // task whose terminal event was simply delivered twice.
      assert.deepEqual(await log.append({ ...base, eventId: 'live-2', seq: 2, type: 'task.started' }), {
        appended: false,
        reason: 'duplicate',
      });

      await assert.rejects(events.insertOne({ ...base, eventId: 'other', seq: 2 }), { code: 11000 });
      await assert.rejects(events.insertOne({ ...base, eventId: 'live-2', seq: 3 }), { code: 11000 });

      const restarted = createMongoEventLog({ events, heads });
      assert.deepEqual(await restarted.watermark('task_live'), { seq: 2, generation: 1 });
      assert.deepEqual(
        await restarted.append({ ...base, eventId: 'live-3', seq: 3, type: 'task.completed', payload: {} }),
        { appended: true },
      );
      const replayed = await restarted.read({ taskId: 'task_live', after: 0, limit: 10 });
      assert.deepEqual(replayed.events.map((event) => event.seq), [1, 2, 3]);
    } finally {
      await events.deleteMany({});
      await heads.deleteMany({});
      await database.close();
    }
  },
);

test('a graceful stop leaves a run owned by another replica alone', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const taskId = 'task_remote';
  const conversationId = 'conv_remote';
  const leaseKey = workRunKey({ ownerId: OWNER_ID, tenantId: null, conversationId });
  const now = new Date().toISOString();

  // A task another replica is executing: its token is not one this process was
  // ever given, and its lease is live.
  await collection(database, 'tasks').insertOne({
    ...taskRecord({
      taskId,
      conversationId,
      state: 'running',
      runToken: 'run_remote',
      updatedAt: now,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  await collection(database, 'work_runs').insertOne({
    key: leaseKey,
    owner: OWNER_ID,
    token: 'run_remote',
    cancelRequested: false,
    expiresAt: new Date(Date.now() + 60_000),
  });

  const app = await mongoApp({ database, workspace });
  try {
    // Startup reconcile sees a live lease and does not interfere either.
    assert.equal((await app.dependencies.tasks.get(taskId))?.state, 'running');
  } finally {
    await app.stop();
  }

  // A stopping replica must not enumerate the shared database and retire work it
  // does not own: that would interrupt a healthy run and free its live lease.
  const task = await collection(database, 'tasks').findOne({ taskId });
  assert.equal(task?.state, 'running');
  assert.notEqual(await collection(database, 'work_runs').findOne({ key: leaseKey }), null);
  workspace.cleanup();
});

test('a backlog larger than one page replays through the ending without duplicating it', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const taskId = 'task_long_stream';
  const conversationId = 'conv_long_stream';
  const now = new Date().toISOString();
  await seedConversation(database, conversationId);
  await collection(database, 'tasks').insertOne({
    ...taskRecord({
      taskId,
      conversationId,
      state: 'completed',
      runToken: 'run_long',
      updatedAt: now,
      result: { summary: 'done', artifacts: [] },
      checkpoint: { completedSteps: [], text: '' },
    }),
  });

  // Forty events with a sixteen-event page: the ending is beyond the first page.
  for (let index = 0; index < 40; index += 1) {
    const terminal = index === 39;
    await collection(database, 'events').insertOne({
      v: 1,
      taskId,
      seq: index + 1,
      eventId: `long_${index + 1}`,
      at: now,
      agent: 'coderax',
      generation: 1,
      type: terminal ? 'task.completed' : 'text.delta',
      payload: terminal ? { summary: 'done' } : { text: '.' },
    });
  }
  await collection(database, 'event_heads').insertOne({ taskId, seq: 40, generation: 1 });

  const app = await mongoApp({ database, workspace, execution: { eventBufferSize: 16 } });
  try {
    const opened = await app.dependencies.events.open(taskId, 0, 16);
    assert.equal(opened.replay.events.length, 40);
    assert.equal(opened.replay.events.at(-1)?.type, 'task.completed');

    // Repair reads the end of the stream, so a long backlog cannot make it
    // append a second terminal event.
    const stored = await app.dependencies.events.read(taskId, 0, 100);
    assert.equal(stored.events.filter((event) => event.type === 'task.completed').length, 1);
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('repair restores the current generation ending and refreshes a stale notification', async () => {
  const database = createFakeDatabase();
  const workspace = createWorkspaces();
  const taskId = 'task_gen_repair';
  const conversationId = 'conv_gen_repair';
  const now = new Date().toISOString();
  await seedConversation(database, conversationId);

  // Generation 2 completed, but its ending never reached the log: the newest
  // event belongs to generation 1.
  await collection(database, 'tasks').insertOne({
    ...taskRecord({
      taskId,
      conversationId,
      state: 'completed',
      runToken: 'run_g2',
      generation: 2,
      updatedAt: now,
      result: { summary: 'done again', artifacts: [] },
      checkpoint: { completedSteps: [], text: '' },
    }),
  });
  for (const event of [
    { seq: 1, type: 'task.queued', generation: 1, payload: {} },
    {
      seq: 2,
      type: 'task.failed',
      generation: 1,
      payload: { code: 'provider_error', retryable: true },
    },
  ]) {
    await collection(database, 'events').insertOne({
      v: 1,
      taskId,
      eventId: `gen_${event.seq}`,
      at: now,
      agent: 'coderax',
      ...event,
    });
  }
  await collection(database, 'event_heads').insertOne({ taskId, seq: 2, generation: 1 });

  // The previous generation also completed, but its summary is stale.
  await collection(database, 'notifications').insertOne({
    taskId,
    ownerId: OWNER_ID,
    conversationId,
    agent: 'coderax',
    mode: 'cloud',
    generation: 1,
    state: 'completed',
    summary: 'interrupted',
    createdAt: now,
    read: true,
  });

  const app = await mongoApp({ database, workspace });
  try {
    const replay = await app.dependencies.events.read(taskId, 0, 10);
    const endings = replay.events.filter((event) => event.type === 'task.completed');
    assert.equal(endings.length, 1);
    assert.equal(endings[0]?.generation, 2);

    const response = await app.router.handle({
      method: 'GET', path: `/v1/work/${taskId}/events`,
      authorization: `Bearer ${OWNER_TOKEN}`, bodyText: '',
    });
    assert.ok(response.kind === 'sse');
    try {
      const streamed = [];
      for await (const event of response.events) streamed.push(event);
      assert.deepEqual(streamed, replay.events);
    } finally {
      response.close();
    }

    const notifications = await app.service.notifications(principal);
    const entry = notifications.notifications.find((item) => item.taskId === taskId);
    assert.equal(entry?.state, 'completed');
    assert.equal(entry?.summary, 'done again');
    assert.equal(entry?.read, false);
  } finally {
    await app.stop();
    workspace.cleanup();
  }
});

test('shutdown drains a submission paused before local registration', async () => {
  const started = await startTestApp();
  const { service, dependencies } = started.app;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let resume!: () => void;
  const release = new Promise<void>(resolve => { resume = resolve; });
  const append = dependencies.conversations.appendMessage;
  dependencies.conversations.appendMessage = async message => {
    enter();
    await release;
    return append(message);
  };
  try {
    const request = { objective: 'shutdown race', mode: 'cloud', requireApproval: true } as const;
    const accepted = service.submitWork(principal, request);
    await entered;
    const stopping = service.shutdown();
    assert.equal((await service.submitWork(principal, request)).ok, false);
    resume();
    const result = await accepted;
    assert.ok(result.ok);
    await stopping;
    assert.equal((await dependencies.tasks.get(result.value.taskId))?.state, 'interrupted');
  } finally {
    resume();
    await started.close();
  }
});

test('a cancellation on the replica that never wrote the stream keeps the interruption', async () => {
  const database = createFakeDatabase();
  const workspaceA = createWorkspaces();
  const workspaceB = createWorkspaces();
  const appA = await mongoApp({
    database,
    workspace: workspaceA,
    execution: { leaseTtlMs: 3_000, heartbeatIntervalMs: 500, cancelGraceMs: 150 },
  });
  const appB = await mongoApp({ database, workspace: workspaceB });
  try {
    const agent = appA.dependencies.agents.get('coderax');
    assert.ok(agent);
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    agent.run = async (_request, report) => {
      report({ type: 'text.delta', text: 'partial result' });
      entered();
      return new Promise(() => {});
    };

    const submitted = await appA.service.submitWork(principal, {
      objective: 'cancel this run from another replica',
      mode: 'cloud',
      requireApproval: true,
    });
    assert.ok(submitted.ok);
    if (!submitted.ok) return;
    await running;

    // Sample the durable head: the owner's bus may still hold a coalesced
    // delta, and the watermark has to be what the store actually committed.
    await appA.dependencies.events.flush(submitted.value.taskId);
    const owned = await appA.dependencies.events.read(submitted.value.taskId, 0);
    const watermark = owned.events.at(-1)?.seq ?? 0;
    assert.ok(watermark >= 2);

    // The cancellation lands on the replica that never wrote this stream, and
    // the owner's lease is already expired from its clock, so the run is retired
    // as interrupted rather than flagged live.
    appB.dependencies.clock.now = () => new Date(Date.now() + 60_000);
    const cancelled = await appB.service.cancelTask(
      principal,
      submitted.value.taskId,
      'The owner stopped heartbeating.',
    );
    assert.ok(cancelled.ok);
    assert.equal(cancelled.value.outcome, 'accepted');
    assert.equal(cancelled.value.state, 'interrupted');
    assert.equal(cancelled.value.generation, 1);

    // Read the collection itself: the event endpoint repairs a missing terminal
    // event, so only the store shows what the cancel path wrote.
    const stored = await collection(database, 'events')
      .find({ taskId: submitted.value.taskId })
      .sort({ seq: 1 })
      .toArray();
    assert.equal(stored.length, watermark + 1, 'the interruption is stored exactly once');
    assert.equal(stored.at(-1)?.type, 'task.interrupted');
    assert.equal(stored.at(-1)?.seq, watermark + 1);
    assert.equal(stored.at(-1)?.generation, 1);

    // The interrupted generation stays resumable, and its ending has to precede
    // the generation that follows it.
    const resumed = await appB.service.resumeTask(principal, submitted.value.taskId, 1);
    assert.ok(resumed.ok);
    assert.equal(resumed.value.generation, 2);
    const completed = await waitFor(async () => {
      const status = await appB.service.task(principal, submitted.value.taskId);
      return status.ok && status.value.state === 'completed' ? status.value : null;
    });
    assert.equal(completed.generation, 2);
    await appB.dependencies.scheduler.idle();

    const full = await appB.dependencies.events.read(submitted.value.taskId, 0);
    const first = full.events.filter((event) => event.generation === 1);
    const second = full.events.filter((event) => event.generation === 2);
    assert.equal(first.at(-1)?.type, 'task.interrupted');
    assert.equal(second[0]?.type, 'task.queued');
    assert.equal(second[0]?.seq, (first.at(-1)?.seq ?? 0) + 1);
  } finally {
    await appB.stop();
    await appA.stop();
    workspaceA.cleanup();
    workspaceB.cleanup();
  }
});
