import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { ChatStreamEvent, ExecutionEvent } from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient, CoderaxContractError } from '@coderax/sdk';
import { clientFor, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

test('Chat streams typed frames that end at a terminal frame', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  try {
    const frames: ChatStreamEvent[] = [];
    for await (const frame of client.chatStream({ message: 'Stream this turn' })) {
      frames.push(frame);
    }

    assert.equal(frames[0]?.type, 'chat.started');
    const last = frames.at(-1);
    if (!last || last.type !== 'chat.completed') {
      throw new Error(`the stream ended with ${last?.type ?? 'no frame'}`);
    }
    assert.ok(frames.some((frame) => frame.type === 'chat.delta'));
    assert.ok(last.reply.text.startsWith('A verified result.'));

    // The streamed turn is persisted exactly once, so a reconnect sees it.
    const conversation = await client.conversation(last.reply.conversationId);
    assert.equal(conversation.messages.at(-1)?.text, last.reply.text);
    assert.equal(conversation.messages.filter((m) => m.role === 'assistant').length, 1);

    const startedFrame = frames[0];
    if (!startedFrame || startedFrame.type !== 'chat.started') throw new Error('no start frame');
    assert.equal(startedFrame.messageId, last.reply.messageId);
    assert.equal(startedFrame.conversationId, last.reply.conversationId);
  } finally {
    await started.close();
  }
});

test('a Chat failure before the stream is a Problem, not a 200', async () => {
  // The default agent is named but disabled, so selection fails closed before a
  // single SSE frame is written: the caller must get a Problem, not a 200 stream
  // that reports the failure as an event.
  const started = await startTestApp({ config: { engines: { default: 'freebuff' } } });
  const client = clientFor(started.url);
  try {
    // The agent is named explicitly: a Chat default never silently selects a
    // different engine than the caller asked for.
    const stream = client.chatStream({ message: 'no agent is available', agent: 'freebuff' });
    // The first pull performs the request, so a preflight failure surfaces here
    // as a Problem rather than as a frame the caller has to interpret.
    await assert.rejects(
      () => stream.next(),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 503,
    );
  } finally {
    await started.close();
  }
});

test('Work events are contiguous, unique and replayable from a cursor', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  try {
    const accepted = await client.submitWork({ objective: 'Stream durable events' });

    const first: ExecutionEvent[] = [];
    for await (const event of client.events(accepted.taskId, { after: 0 })) first.push(event);

    assert.equal(first.at(-1)?.type, 'task.completed');
    assert.deepEqual(
      first.map((event) => event.seq),
      first.map((_event, index) => index + 1),
      'sequences must be contiguous from 1',
    );
    assert.equal(
      new Set(first.map((event) => event.eventId)).size,
      first.length,
      'event ids must be unique',
    );
    assert.ok(first.some((event) => event.type === 'step.started'));
    assert.ok(first.some((event) => event.type === 'text.delta'));

    // A mid cursor delivers only the remainder, and still terminates.
    const cursor = first[1]?.seq ?? 0;
    const rest: ExecutionEvent[] = [];
    for await (const event of client.events(accepted.taskId, { after: cursor })) rest.push(event);
    assert.deepEqual(rest.map((event) => event.seq), first.slice(2).map((event) => event.seq));
    assert.equal(rest.at(-1)?.type, 'task.completed');

    // A cursor at the end closes immediately: nothing will ever be published again.
    const tail: ExecutionEvent[] = [];
    for await (const event of client.events(accepted.taskId, { after: first.at(-1)?.seq })) {
      tail.push(event);
    }
    assert.deepEqual(tail, []);
  } finally {
    await started.close();
  }
});

test('a cursor older than the retained window starts with stream.truncated', async () => {
  const started = await startTestApp({
    config: { execution: { eventBufferSize: 16, leaseTtlMs: 3_000, heartbeatIntervalMs: 500 } },
  });
  const client = clientFor(started.url);
  const deps = started.app.dependencies;
  try {
    const agent = deps.agents.get('coderax');
    assert.ok(agent);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let ready = false;
    agent.run = async (_request, report) => {
      for (let index = 0; index < 40; index += 1) {
        report({ type: 'text.delta', text: `chunk ${index} ` });
      }
      ready = true;
      await pending;
      return { ok: true, summary: 'chatty run' };
    };

    const accepted = await client.submitWork({ objective: 'produce many events' });
    await waitFor(async () => ready || null);
    deps.events.publish({ taskId: accepted.taskId, agent: 'coderax', generation: 0,
      type: 'task.completed', payload: {} });

    const frames: ExecutionEvent[] = [];
    for await (const event of client.events(accepted.taskId, { after: 0, signal: AbortSignal.timeout(5000) })) {
      frames.push(event);
      if (event.type === 'stream.truncated') finish();
    }

    const truncated = frames[0];
    if (!truncated || truncated.type !== 'stream.truncated') {
      throw new Error('the stream did not report the truncated cursor');
    }
    assert.equal(truncated.payload.after, 0);
    assert.equal(frames[1]?.seq, truncated.payload.oldestSeq);
    assert.equal(frames[16]?.generation, 0, 'the old terminal ends the bounded 16-frame replay');
    assert.equal(frames[16]?.type, 'task.completed');
    assert.equal(frames.at(-1)?.generation, 1);
    assert.equal(frames.at(-1)?.type, 'task.completed');

    const legacy = await fetch(`${started.url}${accepted.eventsPath}?after=0`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(legacy.status, 200);
    const retained = (await legacy.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as ExecutionEvent);
    assert.ok(retained[0] && retained[0].seq >= truncated.payload.oldestSeq);
    assert.ok(retained.every((event) => event.type !== 'stream.truncated'));
    assert.equal(retained.at(-1)?.eventId, frames.at(-1)?.eventId);
  } finally {
    await started.close();
  }
});

test('a successful HTTP response without terminal chat data is incomplete', async () => {
  const client = new CoderaxClient({
    baseUrl: 'http://localhost', token: 'test',
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(client.chatStream({ message: 'incomplete' }).next(), CoderaxContractError);
});

test('assistant persistence failure emits one safe terminal failure', async () => {
  const started = await startTestApp();
  const conversations = started.app.dependencies.conversations;
  const append = conversations.appendMessage;
  let attempts = 0;
  conversations.appendMessage = async (message) => {
    if (message.role !== 'assistant') return append(message);
    attempts++;
    throw new Error('private storage diagnostic');
  };
  try {
    const frames: ChatStreamEvent[] = [];
    for await (const frame of clientFor(started.url).chatStream({ message: 'save reply' })) frames.push(frame);
    assert.equal(frames[0]?.type, 'chat.started');
    assert.equal(frames.at(-1)?.type, 'chat.failed');
    assert.ok(!JSON.stringify(frames).includes('private storage diagnostic'));
    assert.equal(attempts, 1);
  } finally {
    await started.close();
  }
});

test('disconnecting during Chat still persists the redacted assistant summary', async () => {
  const started = await startTestApp();
  const client = clientFor(started.url);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let disconnected = false;
  const requests = channel('http.server.request.start');
  const port = Number(new URL(started.url).port);
  const observeChat = (event: unknown) => {
    const { request, response } = event as { request: IncomingMessage; response: ServerResponse };
    if (request.socket.localPort === port && request.url === '/v1/chat') {
      response.once('close', () => { disconnected = !response.writableEnded; });
    }
  };
  requests.subscribe(observeChat);
  try {
    const adapter = started.app.dependencies.agents.get('coderax');
    assert.ok(adapter);
    adapter.run = async (_request, report) => {
      await gate;
      report({ type: 'text.delta', text: 'an intermediate delta ' });
      return { ok: true, summary: 'api_key=syntheticcredential' };
    };
    const controller = new AbortController();
    const stream = client.chatStream({ message: 'disconnect' }, { signal: controller.signal });
    const first = await stream.next();
    assert.ok(!first.done && first.value.type === 'chat.started');
    const conversationId = first.value.conversationId;
    controller.abort();
    await stream.return(undefined);
    await waitFor(async () => disconnected);
    finish();
    const reply = await waitFor(async () => (await client.conversation(conversationId))
      .messages.find((message) => message.role === 'assistant'));
    assert.equal(reply.text, 'api_key=[redacted]');
  } finally {
    requests.unsubscribe(observeChat);
    finish();
    await started.close();
  }
});
