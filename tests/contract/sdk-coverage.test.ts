import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  ROUTES,
  ROUTE_INDEX,
} from '@coderax/contracts';
import {
  CoderaxClient,
  CoderaxCompatibilityError,
  SDK_COVERAGE,
  SDK_MANIFEST,
  SDK_STREAM_METHODS,
  SDK_VERSION,
  checkCompatibility,
} from '@coderax/sdk';

test('every published operation has one SDK method and no unpublished extras', () => {
  const published = new Set(ROUTES.map((route) => route.operationId));
  for (const operationId of published) {
    const method = SDK_COVERAGE[operationId];
    assert.ok(method, `operation ${operationId} has no SDK coverage entry`);
    assert.equal(
      typeof (CoderaxClient.prototype as unknown as Record<string, unknown>)[method],
      'function',
      `operation ${operationId} maps to ${method}, which is not a client method`,
    );
  }
  for (const operationId of Object.keys(SDK_COVERAGE)) {
    assert.ok(
      published.has(operationId),
      `SDK covers ${operationId}, which the contract does not publish`,
    );
  }
  assert.deepEqual([...SDK_MANIFEST.operations].sort(), [...published].sort());
});

test('the streaming entrypoints are real client methods', () => {
  for (const [operationId, method] of Object.entries(SDK_STREAM_METHODS)) {
    assert.ok(ROUTE_INDEX.has(operationId), `${operationId} is not published`);
    assert.equal(
      typeof (CoderaxClient.prototype as unknown as Record<string, unknown>)[method],
      'function',
      `${method} is not implemented`,
    );
  }
});

test('SDK and contract versions are the same distribution line', () => {
  assert.equal(SDK_MANIFEST.sdkVersion, SDK_VERSION);
  assert.equal(SDK_MANIFEST.contractVersion, CONTRACT_VERSION);
  assert.equal(SDK_MANIFEST.eventSchemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(SDK_VERSION, '1.1.0');
  assert.equal(CONTRACT_VERSION, '1.1.0');
});

test('compatibility refuses an older contract or a different event schema', () => {
  assert.equal(
    checkCompatibility({ contractVersion: CONTRACT_VERSION, eventSchemaVersion: EVENT_SCHEMA_VERSION })
      .compatible,
    true,
  );
  assert.equal(
    checkCompatibility({ contractVersion: '1.0.0', eventSchemaVersion: EVENT_SCHEMA_VERSION })
      .compatible,
    false,
  );
  assert.equal(
    checkCompatibility({ contractVersion: '2.0.0', eventSchemaVersion: EVENT_SCHEMA_VERSION })
      .compatible,
    false,
  );
  assert.equal(
    checkCompatibility({ contractVersion: CONTRACT_VERSION, eventSchemaVersion: 2 }).compatible,
    false,
  );
  assert.equal(
    checkCompatibility({
      contractVersion: CONTRACT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      chatStreamSchemaVersion: 2,
    }).compatible,
    false,
  );
  assert.equal(
    checkCompatibility({
      contractVersion: CONTRACT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      minSdkVersion: '1.2.0',
    }).compatible,
    false,
  );
  assert.throws(
    () => {
      const report = checkCompatibility({
        contractVersion: '1.0.0',
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
      });
      if (!report.compatible) throw new CoderaxCompatibilityError(report.problems);
    },
    (error: unknown) => error instanceof CoderaxCompatibilityError,
  );
});
