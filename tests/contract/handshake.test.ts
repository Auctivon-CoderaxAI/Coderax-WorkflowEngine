import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONTRACT_VERSION,
  negotiateContract,
  ROUTES,
  ROUTE_INDEX,
} from '@coderax/contracts';
import { ENGINE_VERSION } from '../../src/version.js';
import { clientFor, startTestApp } from '../helpers.js';

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
    assert.deepEqual(handshake.supportedContractVersions, ['1.0.0', CONTRACT_VERSION]);
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

test('capability flags describe this build, not an aspiration', async () => {
  const started = await startTestApp();
  try {
    const { capabilities, limits } = await clientFor(started.url).handshake();

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
      'memorySearch',
      'conversations',
      'taskList',
      'idempotentSubmission',
    ] as const) {
      assert.equal(capabilities[flag], true, `${flag} is published but not reported`);
    }
    // No external transport is injected in a test app, so this must be false
    // rather than optimistically true.
    assert.equal(capabilities.externalAgents, false);
    assert.equal(capabilities.paidModels, false);

    assert.equal(limits.eventBufferSize, started.app.dependencies.config.execution.eventBufferSize);
    assert.equal(limits.maxConcurrentTasks, started.app.dependencies.config.execution.maxConcurrentTasks);
    assert.equal(limits.scheduleMinIntervalMs, 60_000);
    assert.ok(limits.artifactMaxBytes > 0);
    assert.ok(limits.memoryMaxValueLength > 0);
  } finally {
    await started.close();
  }
});

test('the published OpenAPI document covers every operation and documents negotiation', async () => {
  const started = await startTestApp();
  try {
    const document = started.app.router.registry.openapi();
    const operations = Object.values(document.paths).flatMap((entry) => Object.values(entry));
    assert.equal(operations.length, ROUTES.length);
    assert.equal(document.info.version, CONTRACT_VERSION);

    const chat = document.paths['/v1/chat']?.post;
    assert.ok(chat);
    assert.ok(chat.responses['200']);
    const chatContent = (chat.responses['200'] as { content: Record<string, unknown> }).content;
    assert.ok(chatContent['text/event-stream'], 'chat must document its SSE frames');
    assert.ok(chatContent['application/json'], 'chat must document its JSON reply');

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
