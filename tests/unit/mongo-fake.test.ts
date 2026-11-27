import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeCollection } from '../fakes/mongo.js';

/**
 * The durable stores are proven against this fake, so the fake has to behave like
 * the driver where the stores depend on it: numeric comparisons and ordering for
 * event sequences, `$inc` for the fenced allocator, `$max` for adoption, and the
 * unique indexes that turn a double append into a reportable duplicate.
 */
test('numeric comparisons and ordering are numeric, not lexical', async () => {
  const collection = createFakeCollection();
  for (const seq of [9, 10, 1]) await collection.insertOne({ taskId: 't1', seq });

  const ordered = await collection.find({ taskId: 't1' }).sort({ seq: 1 }).toArray();
  assert.deepEqual(ordered.map((document) => document.seq), [1, 9, 10]);

  const above = await collection.find({ seq: { $gt: 9 } }).toArray();
  assert.deepEqual(above.map((document) => document.seq), [10]);
  const atMost = await collection.find({ seq: { $lte: 9 } }).toArray();
  assert.deepEqual(atMost.map((document) => document.seq).sort((a, b) => Number(a) - Number(b)), [1, 9]);
  assert.equal((await collection.find({ seq: { $lt: 1 } }).toArray()).length, 0);
  assert.equal((await collection.find({ seq: { $gte: 10 } }).toArray()).length, 1);
  // A missing field matches no comparison, exactly as the driver behaves.
  await collection.insertOne({ taskId: 't2' });
  assert.equal((await collection.find({ taskId: 't2', seq: { $gt: 0 } }).toArray()).length, 0);
});

test('$inc creates a missing field and then increments it atomically', async () => {
  const collection = createFakeCollection();
  await collection.insertOne({ taskId: 't1' });

  const first = await collection.findOneAndUpdate(
    { taskId: 't1', runToken: 'run-1' },
    { $inc: { eventSeq: 1 } },
    { returnDocument: 'after', includeResultMetadata: false },
  );
  // The fence is part of the filter, so a stranger matches nothing.
  assert.equal(first, null);

  await collection.updateOne({ taskId: 't1' }, { $set: { runToken: 'run-1' } }, { upsert: false });
  const allocated = await collection.findOneAndUpdate(
    { taskId: 't1', runToken: 'run-1' },
    { $inc: { eventSeq: 1 } },
    { returnDocument: 'after', includeResultMetadata: false },
  );
  assert.equal(allocated?.eventSeq, 1);

  await collection.updateOne(
    { taskId: 't1' },
    { $inc: { eventSeq: 1 } },
    { upsert: false },
  );
  assert.equal(collection.documents[0]?.eventSeq, 2);
});

test('$max raises a head and never lowers it', async () => {
  const collection = createFakeCollection();
  await collection.insertOne({ taskId: 't1' });

  await collection.updateOne({ taskId: 't1' }, { $max: { eventSeq: 5 } }, { upsert: false });
  assert.equal(collection.documents[0]?.eventSeq, 5);
  await collection.updateOne({ taskId: 't1' }, { $max: { eventSeq: 2 } }, { upsert: false });
  assert.equal(collection.documents[0]?.eventSeq, 5);
  await collection.updateOne({ taskId: 't1' }, { $max: { eventSeq: 9 } }, { upsert: false });
  assert.equal(collection.documents[0]?.eventSeq, 9);
});

test('every declared unique index raises 11000, including a composite one', async () => {
  const collection = createFakeCollection();
  await collection.createIndex({ taskId: 1, seq: 1 }, { unique: true, name: 'event_task_seq' });
  await collection.createIndex({ eventId: 1 }, { unique: true, name: 'event_id' });

  await collection.insertOne({ taskId: 't1', seq: 1, eventId: 'evt_1' });
  await assert.rejects(
    () => collection.insertOne({ taskId: 't1', seq: 1, eventId: 'evt_other' }),
    (error: unknown) => (error as { code?: number }).code === 11000,
  );
  await assert.rejects(
    () => collection.insertOne({ taskId: 't2', seq: 2, eventId: 'evt_1' }),
    (error: unknown) => (error as { code?: number }).code === 11000,
  );
  // Same sequence on a different task is not a duplicate.
  await collection.insertOne({ taskId: 't2', seq: 1, eventId: 'evt_2' });
  assert.equal(collection.documents.length, 2);
});

test('an upsert applies $inc to the inserted document', async () => {
  const collection = createFakeCollection();
  await collection.updateOne(
    { taskId: 't1' },
    { $set: { runToken: 'run-1' }, $setOnInsert: { taskId: 't1' }, $inc: { eventSeq: 1 } },
    { upsert: true },
  );
  assert.equal(collection.documents[0]?.eventSeq, 1);
  assert.equal(collection.documents[0]?.runToken, 'run-1');
});
