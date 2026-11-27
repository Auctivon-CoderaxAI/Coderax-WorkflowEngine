import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
  contractFingerprint,
  ROUTES,
} from '@coderax/contracts';
import { CoderaxClient, SDK_CONTRACT_VERSION, checkCompatibility } from '@coderax/sdk';
import { ENGINE_VERSION } from '../../src/version.js';
import { OWNER_TOKEN, startTestApp, testProviderPolicy } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('the handshake is built from the served route table, including media', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const handshake = await api.handshake();
    assert.equal(handshake.contractVersion, CONTRACT_VERSION);
    assert.equal(handshake.contractFingerprint, CONTRACT_FINGERPRINT);
    assert.equal(handshake.contractFingerprint, contractFingerprint(ROUTES));
    assert.deepEqual(
      handshake.operations.map((operation) => operation.operationId).sort(),
      ROUTES.map((route) => route.operationId).sort(),
    );
    assert.ok(handshake.operations.some((operation) => operation.operationId === 'intakeMedia'));
    assert.equal(handshake.operations.find((operation) => operation.operationId === 'submitChat')?.stream, false);
    assert.equal(handshake.operations.find((operation) => operation.operationId === 'streamTaskEvents')?.stream, true);
    assert.equal(handshake.capabilities.chatStreaming, false);
    assert.equal(handshake.capabilities.work, true);
    assert.equal(handshake.capabilities.idempotentSubmission, false);
    assert.equal(handshake.capabilities.media, true);
    assert.equal(handshake.capabilities.deliverables, true);
    assert.equal(handshake.capabilities.capabilities, true);
    assert.equal(handshake.capabilities.schedules, false);
    assert.equal(handshake.capabilities.paidModels, false);
    assert.equal(handshake.server.version, ENGINE_VERSION);
    assert.equal(handshake.limits.maxBodyBytes, 6 * 1024 * 1024);

    const report = checkCompatibility({
      handshake,
      requiredOperations: ['submitChat', 'intakeMedia', 'getHandshake'],
    });
    assert.deepEqual(report.problems, []);
    assert.equal(report.compatible, true);
  } finally {
    await started.close();
  }
});

test('negotiation refuses a newer minor, a foreign major and a conflicting fingerprint', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const exact = await api.handshake({ contract: CONTRACT_VERSION, fingerprint: CONTRACT_FINGERPRINT });
    assert.equal(exact.negotiation, 'exact');
    assert.equal(exact.compatible, true);

    const behind = await api.handshake({ contract: '1.2.0' });
    assert.equal(behind.negotiation, 'client_supported');
    assert.equal(behind.negotiatedContractVersion, '1.2.0');
    assert.equal(behind.compatible, true);

    const ahead = await api.handshake({ contract: '1.4.0' });
    assert.equal(ahead.negotiation, 'client_ahead');
    assert.equal(ahead.compatible, false);

    const foreign = await api.handshake({ contract: '2.0.0' });
    assert.equal(foreign.negotiation, 'unsupported_major');
    assert.equal(foreign.compatible, false);

    const collision = await api.handshake({ contract: CONTRACT_VERSION, fingerprint: 'sha256:nope' });
    assert.equal(collision.negotiation, 'fingerprint_mismatch');
    assert.equal(collision.compatible, false);
  } finally {
    await started.close();
  }
});

test('the engine version tracks package.json', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(manifest.version, ENGINE_VERSION);
  assert.equal(SDK_CONTRACT_VERSION, CONTRACT_VERSION);
});

test('text is available with a private route without advertising cloud eligibility', async () => {
  const started = await startTestApp({
    config: {
      models: {
        route: [{ providerId: 'free', modelId: 'coderax-small' }],
        policy: [testProviderPolicy('free', {
          modes: ['private'],
          credentials: 'owner-managed',
          grants: [{ operation: 'chat', mode: 'private', location: 'owner-region' }],
        })],
      },
    },
  });
  try {
    const report = await client(started.url).capabilities();
    const text = report.capabilities.find((entry) => entry.name === 'text.intelligence');
    assert.equal(text?.state, 'available');
    assert.equal(text.privacyEligible, false);
  } finally {
    await started.close();
  }
});
