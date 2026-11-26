import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatStreamEvent, ExecutionEvent } from '@coderax/contracts';
import { CoderaxApiError } from '@coderax/sdk';
import { clientFor, startTestApp } from '../helpers.js';

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
    agent.run = async (_request, report) => {
      for (let index = 0; index < 40; index += 1) {
        report({ type: 'text.delta', text: `chunk ${index} ` });
      }
      return { ok: true, summary: 'chatty run' };
    };

    const accepted = await client.submitWork({ objective: 'produce many events' });
    await deps.scheduler.idle();

    const frames: ExecutionEvent[] = [];
    for await (const event of client.events(accepted.taskId, { after: 0 })) frames.push(event);

    const truncated = frames[0];
    if (!truncated || truncated.type !== 'stream.truncated') {
      throw new Error('the stream did not report the truncated cursor');
    }
    assert.equal(truncated.payload.after, 0);
    assert.equal(frames[1]?.seq, truncated.payload.oldestSeq);
    assert.equal(frames.length - 1, 16, 'the retained window must stay bounded');
    assert.equal(frames.at(-1)?.type, 'task.completed');
  } finally {
    await started.close();
  }
});
