import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonLogger } from '../../src/observability/logger.js';
import { createMetricsRegistry } from '../../src/observability/metrics.js';
import { createClock } from '../../src/support/clock.js';

test('structured logs redact credentials and home paths and omit objects', () => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    clock: {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      iso: () => '2026-01-01T00:00:00.000Z',
    },
    write: (line) => lines.push(line),
  });

  logger.warn('provider.failed', {
    requestId: 'req_12345678',
    detail: 'Authorization: Bearer abcdefghijklmnop and /home/owner/private',
    body: { objective: 'do not log me' },
  });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed['level'], 'warn');
  assert.equal(parsed['event'], 'provider.failed');
  assert.equal(parsed['requestId'], 'req_12345678');
  assert.equal(String(parsed['detail']).includes('abcdefghijklmnop'), false);
  assert.equal(String(parsed['detail']).includes('/home/owner'), false);
  assert.equal(parsed['body'], '[omitted]');
});

test('request and lease counters are independent snapshots', () => {
  const metrics = createMetricsRegistry({ clock: createClock() });
  metrics.requestStarted();
  metrics.requestStarted();
  metrics.requestFinished(200);
  metrics.requestFinished(404);
  metrics.requestFinished(500);
  metrics.recordLeaseFailure('renewFailed');
  metrics.recordLeaseFailure('fencingFailed');

  const counters = metrics.counters();
  assert.deepEqual(counters.requests, {
    total: 2,
    active: 0,
    succeeded: 1,
    rejected: 1,
    failed: 1,
  });
  assert.equal(counters.leases.renewFailed, 1);
  assert.equal(counters.leases.renewError, 0);
  assert.equal(counters.leases.fencingFailed, 1);
  assert.ok(metrics.uptimeMs() >= 0);
});
