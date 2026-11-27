import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, negotiateContract, ROUTES, ROUTE_INDEX } from '@coderax/contracts';
import { CoderaxClient } from '@coderax/sdk';
import { ENGINE_VERSION } from '../../src/version.js';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

function clientFor(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('the engine version matches package.json', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(ENGINE_VERSION, manifest.version);
});

test('negotiation accepts an older minor and refuses a newer or foreign one', () => {
  assert.deepEqual(negotiateContract(undefined), {
    compatible: true,
    negotiatedContractVersion: CONTRACT_VERSION,
    negotiation: 'no_request',
  });
  assert.deepEqual(negotiateContract(CONTRACT_VERSION), {
    compatible: true,
    negotiatedContractVersion: CONTRACT_VERSION,
    negotiation: 'exact',
  });
  assert.deepEqual(negotiateContract('1.0.0'), {
    compatible: true,
    negotiatedContractVersion: '1.0.0',
    negotiation: 'client_supported',
  });
  assert.equal(negotiateContract('1.9.0').compatible, false);
  assert.equal(negotiateContract('1.9.0').negotiation, 'client_ahead');
  assert.equal(negotiateContract('2.0.0').compatible, false);
  assert.equal(negotiateContract('2.0.0').negotiation, 'unsupported_major');
  assert.equal(negotiateContract('latest').compatible, false);
  assert.equal(negotiateContract('latest').negotiation, 'unparseable');
});

test('the handshake reports exactly the operations the registry serves', async () => {
  const started = await startTestApp();
  try {
    const handshake = await clientFor(started.url).handshake({ contract: CONTRACT_VERSION });

    assert.equal(handshake.contractVersion, CONTRACT_VERSION);
    assert.equal(handshake.apiPrefix, '/v1');
    assert.equal(handshake.compatible, true);
    assert.equal(handshake.negotiation, 'exact');
    assert.equal(handshake.negotiatedContractVersion, CONTRACT_VERSION);
    assert.deepEqual(handshake.supportedContractVersions, [
      '1.0.0',
      '1.1.0',
      '1.2.0',
      CONTRACT_VERSION,
    ]);
    assert.equal(handshake.server.version, ENGINE_VERSION);

    // Exactly the catalogue: no documented operation without a handler, and no
    // handler outside the catalogue.
    assert.equal(handshake.operations.length, ROUTES.length);
    for (const route of ROUTES) {
      const descriptor = handshake.operations.find(
        (operation) => operation.operationId === route.operationId,
      );
      assert.ok(descriptor, `handshake omits ${route.operationId}`);
      assert.equal(descriptor.method, route.method);
      assert.equal(descriptor.path, route.path);
      assert.equal(descriptor.auth, route.auth);
      assert.equal(descriptor.stream, route.stream === true);
    }
    for (const descriptor of handshake.operations) {
      assert.ok(ROUTE_INDEX.has(descriptor.operationId), `handshake invents ${descriptor.operationId}`);
    }
  } finally {
    await started.close();
  }
});

test('capability flags and limits describe this build, not an aspiration', async () => {
  const started = await startTestApp();
  try {
    const { capabilities, limits } = await clientFor(started.url).handshake();
    const config = started.app.dependencies.config;

    for (const flag of [
      'health',
      'discovery',
      'chat',
      'chatStreaming',
      'work',
      'workStreaming',
      'cursorReplay',
      'cancellation',
      'resume',
      'retry',
      'permissions',
      'notifications',
      'notificationRead',
      'schedules',
      'artifacts',
      'memory',
      'conversations',
      'idempotentSubmission',
      'browser',
      'games',
    ] as const) {
      assert.equal(capabilities[flag], true, `${flag} is published but not reported`);
    }
    // No external transport is injected in a test app, so this must be false
    // rather than optimistically true.
    assert.equal(capabilities.externalAgents, false);
    assert.equal(capabilities.paidModels, false);
    // This build publishes no memory write or search operation, so the flags
    // must say so rather than describing a surface that does not exist.
    assert.equal(capabilities.memorySearch, false);
    assert.equal(capabilities.taskList, false);

    assert.equal(limits.eventBufferSize, config.execution.eventBufferSize);
    assert.equal(limits.maxConcurrentTasks, config.execution.maxConcurrentTasks);
    assert.equal(limits.maxConcurrentScheduledRuns, config.schedules.maxConcurrentRuns);
    assert.equal(limits.artifactMaxBytes, config.artifacts.maxBytesPerArtifact);
    assert.ok(limits.maxBodyBytes > 0);
    assert.ok(limits.memoryMaxValueLength > 0);
  } finally {
    await started.close();
  }
});

test('the published OpenAPI document covers every operation', async () => {
  const started = await startTestApp();
  try {
    const document = started.app.router.registry.openapi();
    const operations = Object.values(document.paths).flatMap((entry) => Object.values(entry));
    assert.equal(operations.length, ROUTES.length);
    assert.equal(document.info.version, CONTRACT_VERSION);

    const events = document.paths['/v1/work/{taskId}/events']?.get;
    assert.ok(events);
    const eventsContent = (events.responses['200'] as { content: Record<string, unknown> }).content;
    assert.ok(eventsContent['text/event-stream']);
    assert.equal(eventsContent['application/json'], undefined);

    for (const route of ROUTES) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()];
      assert.ok(operation, `openapi omits ${route.method} ${route.path}`);
      assert.equal(operation.operationId, route.operationId);
    }
  } finally {
    await started.close();
  }
});
