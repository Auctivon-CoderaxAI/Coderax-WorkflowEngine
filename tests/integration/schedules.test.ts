import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * Schedule editing over the published contract.
 *
 * Editing is a `PATCH` on the schedule itself. The operation is advertised in the
 * handshake and has an SDK method, so this suite proves the method reaches a real
 * handler and that the rules that make an edit safe are enforced: only a schedule
 * that has not run can change, and an empty edit is refused rather than silently
 * rewriting `updatedAt`.
 */

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

async function createSchedule(api: CoderaxClient, intervalMs?: number) {
  return api.createSchedule({
    objective: 'Nightly dependency review',
    runAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    mode: 'cloud',
    agent: 'coderax',
    requireApproval: true,
  });
}

test('a schedule can be edited before it runs and the edit is durable', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const schedule = await createSchedule(api, 86_400_000);
    const nextRunAt = new Date(Date.now() + 7_200_000).toISOString();

    const updated = await api.updateSchedule(schedule.scheduleId, {
      objective: 'Nightly dependency review, revised',
      runAt: nextRunAt,
      requireApproval: false,
    });
    assert.equal(updated.scheduleId, schedule.scheduleId);
    assert.equal(updated.objective, 'Nightly dependency review, revised');
    assert.equal(updated.runAt, nextRunAt);
    assert.equal(updated.nextRunAt, nextRunAt);
    assert.equal(updated.requireApproval, false);
    assert.equal(updated.state, 'scheduled');
    // Interval is untouched when the request does not mention it.
    assert.equal(updated.intervalMs, 86_400_000);

    const reread = await api.schedule(schedule.scheduleId);
    assert.equal(reread.objective, 'Nightly dependency review, revised');
    assert.equal(reread.runAt, nextRunAt);
  } finally {
    await started.close();
  }
});

test('editing an interval to null turns a repeating schedule into a one-shot', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const schedule = await createSchedule(api, 3_600_000);
    assert.equal(schedule.intervalMs, 3_600_000);

    const updated = await api.updateSchedule(schedule.scheduleId, { intervalMs: null });
    assert.equal(updated.intervalMs, undefined);
    assert.equal((await api.schedule(schedule.scheduleId)).intervalMs, undefined);
  } finally {
    await started.close();
  }
});

test('an empty edit is refused and a cancelled schedule cannot be edited', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const schedule = await createSchedule(api);

    const empty = await fetch(`${started.url}/v1/schedules/${schedule.scheduleId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { code: string }).code, 'validation_failed');

    await api.cancelSchedule(schedule.scheduleId);
    await assert.rejects(
      api.updateSchedule(schedule.scheduleId, { objective: 'Too late' }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'conflict');
        assert.equal(error.status, 409);
        return true;
      },
    );
  } finally {
    await started.close();
  }
});

test('an unknown schedule is reported as not found, and the operation is advertised', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const handshake = await api.negotiate();
    const descriptor = handshake.operations.find(
      (operation) => operation.operationId === 'updateSchedule',
    );
    assert.ok(descriptor, 'updateSchedule must be part of the handshake');
    assert.equal(descriptor.method, 'PATCH');
    assert.equal(descriptor.path, '/v1/schedules/{scheduleId}');

    await assert.rejects(
      api.updateSchedule('schedule-does-not-exist', { objective: 'Anything' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'not_found');
        return true;
      },
    );
  } finally {
    await started.close();
  }
});
