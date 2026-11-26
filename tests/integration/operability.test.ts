import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

test('request ids are accepted, echoed and replaced when unsafe', async () => {
  const started = await startTestApp();
  const api = new CoderaxClient({ baseUrl: started.url, token: OWNER_TOKEN });
  try {
    const supplied = 'req_client-correlation-0001';
    const healthy = await fetch(`${started.url}/v1/health`, {
      headers: { 'x-request-id': supplied },
    });
    assert.equal(healthy.status, 200);
    assert.equal(healthy.headers.get('x-request-id'), supplied);

    const unauthorized = await fetch(`${started.url}/v1/work`, {
      headers: { 'x-request-id': 'safe-id-12345678' },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('x-request-id'), 'safe-id-12345678');
    const problem = (await unauthorized.json()) as { requestId: string };
    assert.equal(problem.requestId, 'safe-id-12345678');

    const unsafe = await fetch(`${started.url}/v1/health`, {
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    assert.equal(unsafe.status, 200);
    const generated = unsafe.headers.get('x-request-id');
    assert.ok(generated && generated !== 'bad id with spaces');
    assert.match(generated, /^req_[0-9a-f-]{36}$/);

    const accepted = await api.submitWork({
      objective: 'Metrics evidence',
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });
    await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });

    const metrics = await api.metrics();
    assert.equal(metrics.persistence.driver, 'in_memory');
    assert.equal(metrics.persistence.durable, false);
    assert.equal(metrics.persistence.ok, true);
    assert.equal(metrics.queue.maxConcurrent, 4);
    assert.equal(metrics.queue.active, 0);
    assert.equal(metrics.queue.pending, 0);
    assert.equal(metrics.tasks.byState.completed, 1);
    assert.equal(metrics.tasks.total, 1);
    assert.ok(metrics.audit.receipts >= 2);
    assert.ok(metrics.requests.total >= 5);
    assert.equal(metrics.requests.active, 1, 'the metrics request itself is still active');
    assert.equal(metrics.leases.renewFailed, 0);
    assert.equal(metrics.leases.renewError, 0);
    assert.equal(metrics.leases.fencingFailed, 0);
    assert.equal(metrics.events.dropped, 0);
  } finally {
    await started.close();
  }
});
