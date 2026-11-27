import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { ExecutionEvent } from '@coderax/contracts';
import { createEventBus, type SeqAuthority } from '../../src/events/bus.js';
import {
  createMongoEventStore,
  ensureEventIndexes,
  type EventStore,
} from '../../src/events/store.js';
import { isDuplicateKey } from '../../src/persistence/mongo.js';
import { createMongoConnector, type MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { createMongoTaskRepository } from '../../src/persistence/mongo-tables.js';
import {
  requireRealMongo,
  startRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';
import { startTestApp, taskRecord, waitFor } from '../helpers.js';

/**
 * The durable event log against a real MongoDB server, not the collection fake.
 *
 * What it proves: the sequence really is allocated by a fenced `$inc` on the task
 * row, two connections (standing in for two replicas) allocate distinct numbers
 * without a read-then-write window, a superseded generation writes nothing, the
 * `(taskId, seq)` unique index is what makes a retried append safe, and a second
 * engine process replays the log the first one wrote after it has been stopped.
 *
 * The test prefers `CODERAX_TEST_MONGODB_URI`; otherwise it starts a real mongod
 * through the optional `mongodb-memory-server` package. With neither available it
 * is skipped with the reason, and `CODERAX_REQUIRE_MONGODB=1` turns that skip into
 * a failure so the CI lane cannot report a green run without the database.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

after(async () => {
  await maybeMongo?.stop();
});

const skip =
  maybeMongo === null
    ? 'No real MongoDB: set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.'
    : false;

const principal = { ownerId: 'owner-test', isOwner: true as const };

function databaseName(prefix: string): string {
  return `coderax_${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function bus(input: { seq: SeqAuthority; collection: Parameters<typeof createMongoEventStore>[0]['collection'] }): {
  events: ReturnType<typeof createEventBus>;
  store: EventStore;
} {
  const store = createMongoEventStore({
    collection: input.collection,
    pageSize: 50,
    now: () => new Date(),
  });
  const events = createEventBus({
    store,
    seq: input.seq,
    pollMs: 10,
    eventId: () => randomUUID(),
    iso: () => new Date().toISOString(),
  });
  return { events, store };
}

test(
  'the fenced allocator and its durable log agree in a real MongoDB',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('events');
    const connect = createMongoConnector();
    const primary = await connect({ uri: real.uri, database: name });
    const replica = await connect({ uri: real.uri, database: name });

    try {
      const primaryTasks = createMongoTaskRepository(primary.collection('tasks'));
      const replicaTasks = createMongoTaskRepository(replica.collection('tasks'));
      await ensureEventIndexes(primary.collection('events'), { retentionSeconds: 3_600 });

      const writer = bus({ seq: primaryTasks, collection: primary.collection('events') });
      const reader = bus({ seq: replicaTasks, collection: replica.collection('events') });
      const draft = {
        taskId: 'task_mongo',
        runToken: 'run-1',
        agent: 'coderax' as const,
        generation: 1,
      };

      await primaryTasks.create(taskRecord({ taskId: 'task_mongo', runToken: 'run-1' }));

      // Each publish takes its number from the fenced row and stores it in one
      // step, so the sequence cannot come from anywhere else.
      const queued = await writer.events.publish({ ...draft, type: 'task.queued' });
      const started = await writer.events.publish({ ...draft, type: 'task.started' });
      assert.equal(queued?.seq, 1);
      assert.equal(started?.seq, 2);

      // A generation that lost the fence is refused before anything is stored.
      assert.equal(
        await writer.events.publish({
          ...draft,
          runToken: 'run-stale',
          type: 'task.completed',
          payload: {},
        }),
        null,
      );

      // The other replica sees the same rows, ordered, with no truncation: this
      // is the same read a reconnecting SSE client performs after a restart.
      const fromStart = await reader.events.replay('task_mongo', 0);
      assert.deepEqual(
        fromStart.events.map((event) => event.seq),
        [1, 2],
      );
      assert.equal(fromStart.lastSeq, 2);
      assert.equal(fromStart.truncated, false);
      // `storedAt` is retention metadata, not part of the event contract.
      assert.ok(fromStart.events.every((event) => !('storedAt' in event)));

      const fromCursor = await reader.events.replay('task_mongo', 1);
      assert.deepEqual(
        fromCursor.events.map((event) => event.type),
        ['task.started'],
      );

      // A retried append at a used sequence is reported, not stored twice: the
      // unique (taskId, seq) index is the reason that retry is safe.
      const duplicate: ExecutionEvent = { ...fromStart.events[0], eventId: randomUUID() };
      assert.equal(await writer.store.append(duplicate), 'duplicate');
      await assert.rejects(
        () => primary.collection('events').insertOne({ ...duplicate, storedAt: new Date() }),
        (error: unknown) => isDuplicateKey(error),
      );

      // Reissue keeps the head, so a client cursor from generation 1 still means
      // something and the new generation continues above the stored log.
      const now = new Date();
      const nowIso = now.toISOString();
      await primaryTasks.updateFenced({
        taskId: 'task_mongo',
        token: 'run-1',
        patch: { state: 'failed' },
      });
      const issued = await primaryTasks.reissue({
        taskId: 'task_mongo',
        token: 'run-2',
        now: nowIso,
        leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        from: ['failed'],
      });
      assert.equal(issued.applied, true);
      const resumed = await reader.events.publish({
        taskId: 'task_mongo',
        runToken: 'run-2',
        agent: 'coderax',
        generation: 2,
        type: 'task.queued',
        payload: {},
      });
      assert.equal(resumed?.seq, 3);
      assert.equal((await replicaTasks.get('task_mongo'))?.eventSeq, 3);

      // The rows are on the server, in sequence order, with the retention stamp.
      const rows = await primary
        .collection('events')
        .find({ taskId: 'task_mongo' })
        .sort({ seq: 1 })
        .toArray();
      assert.deepEqual(
        rows.map((row) => row.seq),
        [1, 2, 3],
      );
      assert.ok(rows.every((row) => row.storedAt instanceof Date));

      // The indexes are the server's, not the fake's: one unique ordering index
      // and one TTL index that bounds retention.
      const indexes = await (
        primary.collection('events') as unknown as {
          listIndexes: () => { toArray: () => Promise<Record<string, unknown>[]> };
        }
      )
        .listIndexes()
        .toArray();
      const ordering = indexes.find((index) => index.name === 'event_task_seq');
      assert.equal(ordering?.unique, true);
      const retention = indexes.find((index) => index.name === 'event_retention');
      assert.equal(retention?.expireAfterSeconds, 3_600);

      // Two connections allocating for the same task get distinct numbers, which
      // is the property that a read-then-compare allocation would not have.
      // A separate conversation, because the row enforces one live run per
      // conversation as well as one token per task.
      const sequenceTask = await primaryTasks.create(
        taskRecord({ taskId: 'task_seq', runToken: 'run-1', conversationId: 'conv_seq' }),
      );
      assert.equal(sequenceTask.ok, true);
      assert.equal(await primaryTasks.allocateSeq({ taskId: 'task_seq', token: 'run-1' }), 1);
      assert.equal(await replicaTasks.allocateSeq({ taskId: 'task_seq', token: 'run-1' }), 2);
      assert.equal((await primaryTasks.get('task_seq'))?.eventSeq, 2);
      // The same token from the other replica continues, and a wrong one takes
      // nothing at all.
      assert.equal(await replicaTasks.allocateSeq({ taskId: 'task_seq', token: 'run-2' }), null);
      assert.equal((await primaryTasks.get('task_seq'))?.eventSeq, 2);

      // Two replicas publishing at the same instant take distinct numbers and
      // lose nothing: the allocation is one atomic `$inc` inside the fence, not
      // a read-then-write comparison two processes could both win.
      const race = await primaryTasks.create(
        taskRecord({ taskId: 'task_race', runToken: 'run-1', conversationId: 'conv_race' }),
      );
      assert.equal(race.ok, true);
      const publishing = Array.from({ length: 6 }, (_value, index) =>
        (index % 2 === 0 ? writer.events : reader.events).publish({
          taskId: 'task_race',
          runToken: 'run-1',
          agent: 'coderax',
          generation: 1,
          type: 'text.delta',
          payload: { text: `${index}` },
        }),
      );
      const numbers = (await Promise.all(publishing))
        .map((event) => event?.seq ?? 0)
        .sort((left, right) => left - right);
      assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6]);
      const raced = await reader.events.replay('task_race', 0);
      assert.deepEqual(
        raced.events.map((event) => event.seq),
        [1, 2, 3, 4, 5, 6],
      );
      assert.equal((await primaryTasks.get('task_race'))?.eventSeq, 6);
    } finally {
      await primary.close().catch(() => undefined);
      await replica.close().catch(() => undefined);
    }
  },
);

test(
  'a restarted engine replays the whole task log from MongoDB',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('events_restart');
    const connect = createMongoConnector();
    const connections: MongoDatabase[] = [];
    const config = { persistence: { driver: 'mongo', database: name } };

    try {
      const firstDatabase = await connect({ uri: real.uri, database: name });
      connections.push(firstDatabase);
      const first = await startTestApp({
        persistence: { database: firstDatabase },
        config,
      });

      let taskId = '';
      let head = 0;
      try {
        const submitted = await first.app.service.submitWork(principal, {
          objective: 'Summarize the repository',
          mode: 'cloud',
          requireApproval: true,
        });
        assert.equal(submitted.ok, true);
        if (!submitted.ok) throw new Error('the work run was not accepted');
        taskId = submitted.value.taskId;

        const completed = await waitFor(async () => {
          const status = await first.app.service.task(principal, taskId);
          return status.ok && status.value.state === 'completed' ? status.value : null;
        });
        assert.equal(completed.state, 'completed');
        head = await first.app.dependencies.events.lastSeq(taskId);
        assert.ok(head >= 2);
      } finally {
        // Stopping the engine closes its connection: nothing the second process
        // reads can come from this process's memory.
        await first.close();
      }

      const secondDatabase = await connect({ uri: real.uri, database: name });
      connections.push(secondDatabase);
      const second = await startTestApp({
        persistence: { database: secondDatabase },
        config,
      });
      try {
        const replay = await second.app.dependencies.events.replay(taskId, 0);
        assert.equal(replay.truncated, false);
        assert.equal(replay.lastSeq, head);
        assert.deepEqual(
          replay.events.map((event) => event.seq),
          replay.events.map((_event, index) => index + 1),
        );
        assert.equal(replay.events[0]?.type, 'task.queued');
        assert.equal(replay.events.at(-1)?.type, 'task.completed');
        assert.ok(replay.events.every((event) => event.taskId === taskId));
        // The run's own progress was recorded, not only its envelope.
        assert.ok(replay.events.some((event) => event.type === 'task.started'));

        // A cursor in the middle returns only what follows it.
        const tail = await second.app.dependencies.events.replay(taskId, head - 1);
        assert.deepEqual(
          tail.events.map((event) => event.seq),
          [head],
        );

        // The service stream starts at the same durable head, so a reconnecting
        // client can trust the metadata frame it is given.
        const stream = await second.app.service.events(principal, taskId, 0);
        assert.equal(stream.ok, true);
        if (stream.ok) {
          assert.equal(stream.value.replay.lastSeq, head);
          assert.equal(stream.value.replay.events.length, replay.events.length);
        }

        // The rows are genuinely in the database, not reconstructed by the engine.
        const rows = await secondDatabase
          .collection('events')
          .find({ taskId })
          .sort({ seq: 1 })
          .toArray();
        assert.equal(rows.length, replay.events.length);
      } finally {
        await second.close();
      }
    } finally {
      for (const connection of connections) await connection.close().catch(() => undefined);
    }
  },
);

test(
  'a second replica tails a run while its owner is still working',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('events_live');
    const connect = createMongoConnector();
    const owner = await connect({ uri: real.uri, database: name });
    const replica = await connect({ uri: real.uri, database: name });

    try {
      const ownerTasks = createMongoTaskRepository(owner.collection('tasks'));
      const replicaTasks = createMongoTaskRepository(replica.collection('tasks'));
      await ensureEventIndexes(owner.collection('events'), { retentionSeconds: 3_600 });
      const writer = bus({ seq: ownerTasks, collection: owner.collection('events') });
      const reader = bus({ seq: replicaTasks, collection: replica.collection('events') });
      const draft = {
        taskId: 'task_live',
        runToken: 'run-1',
        agent: 'coderax' as const,
        generation: 1,
      };

      const created = await ownerTasks.create(
        taskRecord({ taskId: 'task_live', runToken: 'run-1', conversationId: 'conv_live' }),
      );
      assert.equal(created.ok, true);
      const running = await ownerTasks.updateFenced({
        taskId: 'task_live',
        token: 'run-1',
        patch: { state: 'running' },
      });
      assert.equal(running.applied, true);
      assert.equal((await writer.events.publish({ ...draft, type: 'task.started' }))?.seq, 1);

      // The replica attaches at the head it already has and follows the run from
      // there, the way an SSE client reconnecting mid-run does.
      const seen: Array<{ seq: number; type: string }> = [];
      const unsubscribe = reader.events.subscribe('task_live', 1, (event) => {
        seen.push({ seq: event.seq, type: event.type });
      });
      try {
        await writer.events.publish({ ...draft, type: 'text.delta', payload: { text: 'one ' } });
        await writer.events.publish({ ...draft, type: 'text.delta', payload: { text: 'two' } });
        await waitFor(async () => (seen.length >= 2 ? true : null), 5_000);

        // The run is still `running`: what the replica received is a live tail of
        // an unfinished run, not a replay of a settled task.
        assert.equal((await replicaTasks.get('task_live'))?.state, 'running');
        assert.deepEqual(
          seen.map((entry) => entry.seq),
          [2, 3],
        );

        await writer.events.publish({ ...draft, type: 'task.completed', payload: {} });
        await waitFor(
          async () => (seen.some((entry) => entry.type === 'task.completed') ? true : null),
          5_000,
        );
        assert.deepEqual(
          seen.map((entry) => entry.seq),
          [2, 3, 4],
        );
      } finally {
        unsubscribe();
      }

      // Once the owner has settled, the replica's replay is the same log it was
      // tailing, so a client can switch from tailing to replaying without a gap.
      const settled = await reader.events.replay('task_live', 0);
      assert.deepEqual(
        settled.events.map((event) => event.seq),
        [1, 2, 3, 4],
      );
      assert.equal(settled.lastSeq, 4);
      assert.equal(settled.truncated, false);
    } finally {
      await owner.close().catch(() => undefined);
      await replica.close().catch(() => undefined);
    }
  },
);

test(
  'a stale generation is refused on both replicas',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('events_stale');
    const connect = createMongoConnector();
    const first = await connect({ uri: real.uri, database: name });
    const second = await connect({ uri: real.uri, database: name });

    try {
      const firstTasks = createMongoTaskRepository(first.collection('tasks'));
      const secondTasks = createMongoTaskRepository(second.collection('tasks'));
      await ensureEventIndexes(first.collection('events'), { retentionSeconds: 3_600 });
      const firstBus = bus({ seq: firstTasks, collection: first.collection('events') });
      const secondBus = bus({ seq: secondTasks, collection: second.collection('events') });
      const stale = { taskId: 'task_stale', runToken: 'run-1', agent: 'coderax' as const, generation: 1 };

      const created = await firstTasks.create(
        taskRecord({ taskId: 'task_stale', runToken: 'run-1', conversationId: 'conv_stale' }),
      );
      assert.equal(created.ok, true);
      assert.equal((await firstBus.events.publish({ ...stale, type: 'task.queued' }))?.seq, 1);

      // Generation 2 takes the fence, through the other replica.
      await secondTasks.updateFenced({
        taskId: 'task_stale',
        token: 'run-1',
        patch: { state: 'failed' },
      });
      const now = new Date();
      const issued = await secondTasks.reissue({
        taskId: 'task_stale',
        token: 'run-2',
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        from: ['failed'],
      });
      assert.equal(issued.applied, true);

      const head = await firstBus.events.lastSeq('task_stale');
      // Both replicas refuse the superseded token, and a refusal consumes no
      // sequence and stores nothing.
      assert.equal(
        await firstBus.events.publish({ ...stale, type: 'task.completed', payload: {} }),
        null,
      );
      assert.equal(
        await secondBus.events.publish({ ...stale, type: 'task.completed', payload: {} }),
        null,
      );
      assert.equal(await firstBus.events.lastSeq('task_stale'), head);
      assert.equal((await firstTasks.get('task_stale'))?.eventSeq, head);
      assert.equal((await firstBus.events.replay('task_stale', 0)).events.length, 1);

      // The generation that holds the fence writes from either replica.
      const fromSecond = await secondBus.events.publish({
        taskId: 'task_stale',
        runToken: 'run-2',
        agent: 'coderax',
        generation: 2,
        type: 'task.started',
      });
      assert.equal(fromSecond?.seq, head + 1);
      const fromFirst = await firstBus.events.publish({
        taskId: 'task_stale',
        runToken: 'run-2',
        agent: 'coderax',
        generation: 2,
        type: 'text.delta',
        payload: { text: 'resumed' },
      });
      assert.equal(fromFirst?.seq, head + 2);

      // ...and the stale token still cannot write after the new one has.
      assert.equal(
        await secondBus.events.publish({ ...stale, type: 'text.delta', payload: { text: 'late' } }),
        null,
      );

      const final = await secondBus.events.replay('task_stale', 0);
      assert.deepEqual(
        final.events.map((event) => event.seq),
        [1, 2, 3],
      );
      // The refused terminal writes never reached the log from either replica.
      assert.equal(
        final.events.some((event) => event.type === 'task.completed'),
        false,
      );
      assert.deepEqual(
        final.events.map((event) => event.generation),
        [1, 2, 2],
      );
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
    }
  },
);

test(
  'retention removes expired rows and an old cursor is reported as truncated',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('events_retention');
    const connect = createMongoConnector();
    const database = await connect({ uri: real.uri, database: name });

    try {
      const collection = database.collection('events_retained');
      // Keep new rows within the window for the entire polling budget. The rows
      // stamped an hour ago remain expired when the server's TTL monitor runs.
      await ensureEventIndexes(collection, { retentionSeconds: 300 });
      let stamp = Date.now() - 3_600_000;
      const tasks = createMongoTaskRepository(database.collection('tasks_retained'));
      const created = await tasks.create(
        taskRecord({ taskId: 'task_ttl', runToken: 'run-1', conversationId: 'conv_ttl' }),
      );
      assert.equal(created.ok, true);
      const store = createMongoEventStore({
        collection,
        pageSize: 50,
        now: () => new Date(stamp),
      });
      const events = createEventBus({
        store,
        seq: tasks,
        pollMs: 10,
        eventId: () => randomUUID(),
        iso: () => new Date().toISOString(),
      });
      const draft = { taskId: 'task_ttl', runToken: 'run-1', agent: 'coderax' as const, generation: 1 };

      for (const type of ['task.queued', 'task.started', 'text.delta'] as const) {
        await events.publish({ ...draft, type, payload: { text: 'expired' } });
      }

      // The rest of the run is written now, so it is inside the window and must
      // survive the same sweep that removes the three old rows.
      stamp = Date.now();
      await events.publish({ ...draft, type: 'text.delta', payload: { text: 'retained' } });
      await events.publish({ ...draft, type: 'task.completed', payload: {} });
      assert.equal(await events.lastSeq('task_ttl'), 5);

      const remaining = async (): Promise<number> =>
        (await collection.find({ taskId: 'task_ttl' }).toArray()).length;
      const deadline = Date.now() + 180_000;
      let rows = await remaining();
      while (rows > 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        rows = await remaining();
      }
      assert.equal(
        rows,
        2,
        `the TTL monitor did not expire the old rows within 180s (${rows} rows remained)`,
      );

      // A cursor at the start lost events: it is told so instead of silently
      // skipping them, and it receives the surviving tail.
      const old = await events.replay('task_ttl', 0);
      assert.equal(old.truncated, true);
      assert.deepEqual(
        old.events.map((event) => event.seq),
        [4, 5],
      );
      assert.equal(old.lastSeq, 5);

      // A cursor that still lands inside the window is not a truncation.
      const inside = await events.replay('task_ttl', 3);
      assert.equal(inside.truncated, false);
      assert.deepEqual(
        inside.events.map((event) => event.seq),
        [4, 5],
      );
    } finally {
      await database.close().catch(() => undefined);
    }
  },
);
