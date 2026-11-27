import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * Event replay.
 *
 * A client may reconnect at any time. Replay honours the cursor, never returns a
 * duplicate event, preserves the per-task sequence, and closes on the terminal
 * event so a completed task does not leave a stream open.
 */

const principal = { ownerId: 'owner-test', isOwner: true as const };

type Frame = { eventId: string; seq: number; type: string };

async function completedTask(started: Awaited<ReturnType<typeof startTestApp>>): Promise<string> {
  const submitted = await started.app.service.submitWork(principal, {
    objective: 'replayable task',
    mode: 'cloud',
    requireApproval: true,
  });
  assert.ok(submitted.ok);
  await started.app.dependencies.scheduler.idle();
  return submitted.value.taskId;
}

test('replay from zero is ordered, unique and ends with the terminal event', async () => {
  const started = await startTestApp();
  try {
    const taskId = await completedTask(started);
    const replay = await started.app.dependencies.events.replay(taskId, 0);
    assert.equal(replay.truncated, false);
    const sequences = replay.events.map((event) => event.seq);
    assert.deepEqual(
      sequences,
      sequences.map((_value, index) => index + 1),
    );
    assert.equal(new Set(replay.events.map((event) => event.eventId)).size, replay.events.length);
    assert.equal(replay.events.at(-1)?.type, 'task.completed');
  } finally {
    await started.close();
  }
});

test('a cursor returns only newer events and never rewinds', async () => {
  const started = await startTestApp();
  try {
    const taskId = await completedTask(started);
    const all = await started.app.dependencies.events.replay(taskId, 0);
    const cursor = all.events[2]?.seq ?? 0;
    const tail = await started.app.dependencies.events.replay(taskId, cursor);
    assert.equal(tail.truncated, false);
    assert.ok(tail.events.length > 0);
    assert.ok(tail.events.every((event) => event.seq > cursor));
    assert.equal(
      tail.events.length,
      all.events.filter((event) => event.seq > cursor).length,
    );
  } finally {
    await started.close();
  }
});

test('the SSE endpoint replays once and closes on completion', async () => {
  const started = await startTestApp();
  try {
    const taskId = await completedTask(started);
    const response = await fetch(`${started.url}/v1/work/${taskId}/events?after=0`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const frames = (await response.text())
      .split('\n\n')
      .map((frame) => frame.trim())
      .filter((frame) => frame.length > 0 && frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.replace(/^data: /, '')) as Frame);
    assert.ok(frames.length > 0);
    assert.equal(frames.at(-1)?.type, 'task.completed');
    assert.equal(new Set(frames.map((frame) => frame.eventId)).size, frames.length);
    assert.deepEqual(
      frames.map((frame) => frame.seq),
      frames.map((_value, index) => index + 1),
    );
  } finally {
    await started.close();
  }
});

test('an event stream requires the owner token', async () => {
  const started = await startTestApp();
  try {
    const taskId = await completedTask(started);
    const response = await fetch(`${started.url}/v1/work/${taskId}/events`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'unauthorized');
  } finally {
    await started.close();
  }
});

test('a foreign owner cannot replay another owner task', async () => {
  const started = await startTestApp();
  try {
    const taskId = await completedTask(started);
    const foreign = await started.app.service.events(
      { ownerId: 'someone-else', isOwner: true },
      taskId,
      0,
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.code, 'not_found');
  } finally {
    await started.close();
  }
});
