import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { createEventBus } from '../../src/events/bus.js';
import { createMongoEventLog, ensureEventIndexes } from '../../src/persistence/mongo-events.js';
import type { MongoCollectionLike } from '../../src/persistence/mongo.js';

/**
 * Real MongoDB, two independent replicas of the durable log.
 *
 * Skipped unless `CODERAX_TEST_MONGODB_URI` points at a running server: a fake
 * collection proves the query shape, not that a unique index arbitrates two
 * processes. Each "replica" below is its own driver connection, its own
 * collections handle and its own bus, so nothing is shared except the database.
 */

const MONGO_URI = process.env.CODERAX_TEST_MONGODB_URI?.trim() ?? '';
const MONGO_DATABASE = 'coderax_live_test';
const skip =
  MONGO_URI.length === 0
    ? 'set CODERAX_TEST_MONGODB_URI to a running MongoDB to run the durability suite'
    : false;

type Fixture = {
  prefix: string;
  database: Db;
  events: MongoCollectionLike;
  heads: MongoCollectionLike;
  close: () => Promise<void>;
};

function uniquePrefix(): string {
  return `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function fixture(): Promise<Fixture> {
  const prefix = uniquePrefix();
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const database = client.db(MONGO_DATABASE);
  const events = database.collection(`${prefix}_events`) as unknown as MongoCollectionLike;
  const heads = database.collection(`${prefix}_event_heads`) as unknown as MongoCollectionLike;
  await ensureEventIndexes({ events, heads });
  return {
    prefix,
    database,
    events,
    heads,
    close: async () => {
      await database.dropCollection(`${prefix}_events`).catch(() => undefined);
      await database.dropCollection(`${prefix}_event_heads`).catch(() => undefined);
      await client.close();
    },
  };
}

let counter = 0;
function busOver(log: ReturnType<typeof createMongoEventLog>) {
  return createEventBus({
    bufferSize: 100,
    eventId: () => {
      counter += 1;
      return `live-${counter}`;
    },
    iso: () => new Date(1_700_000_000_000).toISOString(),
    log,
  });
}

test(
  'a replica that never wrote the stream replays it and continues its sequence',
  { skip },
  async () => {
    const live = await fixture();
    try {
      const writer = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      writer.publish({ taskId: 'task-live-1', agent: 'coderax', generation: 1, type: 'task.queued' });
      writer.publish({ taskId: 'task-live-1', agent: 'coderax', generation: 1, type: 'task.started' });
      writer.publish({
        taskId: 'task-live-1',
        agent: 'coderax',
        generation: 1,
        type: 'text.delta',
        payload: { text: 'hello' },
      });
      await writer.flush('task-live-1');

      const reader = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      const replay = await reader.read('task-live-1', 0);
      assert.deepEqual(
        replay.events.map((event) => event.seq),
        [1, 2, 3],
        'the stored stream is readable from after: 0 on another replica',
      );
      assert.equal(replay.truncated, false);

      const mid = await reader.read('task-live-1', 2);
      assert.deepEqual(
        mid.events.map((event) => event.eventId),
        replay.events.slice(2).map((event) => event.eventId),
        'a mid-stream cursor resumes at the durable watermark',
      );

      const continued = reader.publish({
        taskId: 'task-live-1',
        agent: 'coderax',
        generation: 2,
        type: 'task.completed',
        payload: { summary: 'done' },
      });
      assert.equal(continued.seq, 4, 'a generation reissued elsewhere continues the shared sequence');
      await reader.flush('task-live-1');
      const stored = await createMongoEventLog({ events: live.events, heads: live.heads }).lastSeq(
        'task-live-1',
      );
      assert.equal(stored, 4);
    } finally {
      await live.close();
    }
  },
);

test(
  'retention pruning is a gap for a replica that did not write the stream',
  { skip },
  async () => {
    const live = await fixture();
    try {
      const writer = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      for (let index = 0; index < 6; index += 1) {
        writer.publish({
          taskId: 'task-live-2',
          agent: 'coderax',
          generation: 1,
          type: 'text.delta',
          payload: { text: `t${index}` },
        });
      }
      await writer.flush('task-live-2');

      const readerLog = createMongoEventLog({ events: live.events, heads: live.heads });
      const full = await readerLog.read('task-live-2', 0, 100);
      assert.equal(full.length, 6);
      const removed = await readerLog.prune('task-live-2', 2);
      assert.equal(removed, 4);
      assert.equal(
        await readerLog.lastSeq('task-live-2'),
        6,
        'retention does not move the durable watermark',
      );

      const reader = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      const truncated = await reader.read('task-live-2', 0);
      assert.equal(truncated.truncated, true, 'a cursor below the retained window is a gap');
      assert.deepEqual(
        truncated.events.map((event) => event.seq),
        [5, 6],
      );
    } finally {
      await live.close();
    }
  },
);

test(
  'the shared head row refuses a stale generation and seals its bus',
  { skip },
  async () => {
    const live = await fixture();
    try {
      const current = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      current.publish({ taskId: 'task-live-3', agent: 'coderax', generation: 2, type: 'task.queued' });
      await current.flush('task-live-3');
      const watermark = await createMongoEventLog({
        events: live.events,
        heads: live.heads,
      }).lastSeq('task-live-3');

      const superseded = busOver(createMongoEventLog({ events: live.events, heads: live.heads }));
      superseded.publish({
        taskId: 'task-live-3',
        agent: 'coderax',
        generation: 1,
        type: 'text.delta',
        payload: { text: 'late' },
      });
      await superseded.flush('task-live-3');

      const log = createMongoEventLog({ events: live.events, heads: live.heads });
      assert.equal(await log.lastSeq('task-live-3'), watermark, 'the stale write was refused');
      assert.equal((await log.read('task-live-3', 0, 100)).length, 1);
    } finally {
      await live.close();
    }
  },
);
