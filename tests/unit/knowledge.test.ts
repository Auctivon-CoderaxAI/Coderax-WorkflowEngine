import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, createKnowledgeStore, tokenize } from '../../src/knowledge/store.js';
import { createOpenAiProvider } from '../../src/models/providers/openai.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';

const clock = createClock();
const ids = createIdGenerator();

test('an empty or short document chunks predictably', () => {
  assert.deepEqual(chunkText('   '), []);
  assert.deepEqual(chunkText('x'.repeat(2401)).map(piece => piece.length), [1200, 1351]);
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

test('private ingestion and retrieval stay lexical with a cloud embedding provider', async () => {
  let calls = 0;
  const store = createKnowledgeStore({ clock, ids, embeddings: {
    id: 'cloud', cloudOnly: true, embed: async () => { calls++; return [[1]]; },
  } });
  const scope = { ownerId: 'owner', mode: 'private' as const };
  await store.ingest({ ...scope, title: 'Note', text: 'A private note.' });
  const found = await store.search({ ...scope, query: 'private', k: 1 });
  assert.equal(found.hits.length, 1);
  assert.equal(found.embedding, 'lexical');
  assert.equal(calls, 0);
});

test('the embeddings transport rejects plaintext remote endpoints before dispatch', async () => {
  const sent: string[] = [];
  const create = (baseURL: string) => createOpenAiProvider({
    id: 'fixture',
    baseURL,
    apiKey: 'fixture',
    fetchImpl: async (input: Parameters<typeof fetch>[0]) => {
      sent.push(String(input));
      return Response.json({ data: [{ embedding: [1] }] });
    },
  });
  const signal = new AbortController().signal;
  const model = { providerId: 'fixture', modelId: 'fixture' };
  for (const host of ['remote.example', 'localhost.example', '127.0.0.1.example']) {
    assert.throws(() => create('http://' + host), /HTTPS/);
  }
  for (const url of ['https://remote.example/v1', 'http://127.0.0.1', 'http://[::1]']) {
    const adapter = create(url);
    assert.ok(adapter.embed, 'the OpenAI-compatible adapter serves embeddings');
    await adapter.embed({ model, texts: ['test'], signal });
  }
  assert.deepEqual(sent, ['https://remote.example/v1/embeddings', 'http://127.0.0.1/embeddings',
    'http://[::1]/embeddings']);
});
