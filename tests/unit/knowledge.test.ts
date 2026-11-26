import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, createKnowledgeStore, tokenize } from '../../src/knowledge/store.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';

const clock = createClock();
const ids = createIdGenerator();

test('an empty or short document chunks predictably', () => {
  assert.deepEqual(chunkText('   '), []);
  assert.deepEqual(chunkText('one sentence'), ['one sentence']);
  const long = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} about retrieval.`).join('\n\n');
  const chunks = chunkText(long, 200, 50);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.ok(tokenize('The retrieval and the ranking').includes('retrieval'));
});

test('retrieval is lexical when no embeddings are configured and stays in its partition', async () => {
  const store = createKnowledgeStore({ clock, ids, embeddings: null });
  const ingested = await store.ingest({
    ownerId: 'owner-test',
    mode: 'cloud',
    title: 'Deployment note',
    text: 'The engine deploys to the cloud worker. Durable leases fence generation writes.',
  });
  assert.equal(ingested.ok, true);
  assert.equal(ingested.ok && ingested.value.embedding, 'lexical');

  const cloud = await store.search({
    ownerId: 'owner-test',
    mode: 'cloud',
    query: 'durable leases',
    k: 3,
  });
  assert.equal(cloud.embedding, 'lexical');
  assert.equal(cloud.hits.length, 1);
  assert.equal(cloud.hits[0]?.title, 'Deployment note');

  const privateSearch = await store.search({
    ownerId: 'owner-test',
    mode: 'private',
    query: 'durable leases',
    k: 3,
  });
  assert.deepEqual(privateSearch.hits, []);

  const listed = await store.list({ ownerId: 'owner-test', mode: 'cloud' });
  assert.equal(listed.documents.length, 1);
  assert.equal(listed.documents[0]?.chunks, 1);
});

test('semantic retrieval is reported only when embeddings answered', async () => {
  const store = createKnowledgeStore({
    clock,
    ids,
    embeddings: {
      id: 'test',
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    },
  });
  const ingested = await store.ingest({
    ownerId: 'owner-test',
    mode: 'cloud',
    title: 'Vector note',
    text: 'A vector document about embeddings.',
  });
  assert.equal(ingested.ok && ingested.value.embedding, 'semantic');
  const found = await store.search({
    ownerId: 'owner-test',
    mode: 'cloud',
    query: 'anything',
    k: 1,
  });
  assert.equal(found.embedding, 'semantic');
  assert.equal(found.hits[0]?.title, 'Vector note');
});
