import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, ROUTES } from '@coderax/contracts';
import {
  CoderaxClient,
  SDK_CONTRACT_VERSION,
  SDK_OPERATION_COVERAGE,
  SDK_VERSION,
  sdkMetadata,
} from '@coderax/sdk';

/**
 * The SDK is the only client. If an operation exists without a client method,
 * Coderax or CoderaxCLI has to hand-roll a request, which is exactly the second
 * contract this repository forbids.
 */
test('every published operation has an SDK method and no method is unpublished', () => {
  const published = new Set(ROUTES.map((route) => route.operationId));
  const covered = Object.keys(SDK_OPERATION_COVERAGE);

  for (const operationId of published) {
    assert.ok(
      SDK_OPERATION_COVERAGE[operationId],
      `operation ${operationId} has no SDK method`,
    );
  }
  for (const operationId of covered) {
    assert.ok(published.has(operationId), `SDK covers ${operationId}, which is not published`);
  }
  assert.equal(covered.length, published.size);

  const methods = Object.values(SDK_OPERATION_COVERAGE);
  assert.equal(new Set(methods).size, methods.length, 'two operations map to one method');

  const prototype = CoderaxClient.prototype as unknown as Record<string, unknown>;
  for (const method of [...methods, 'chatStream']) {
    assert.equal(typeof prototype[method], 'function', `CoderaxClient.${method} is missing`);
  }
});

test('every published package version tracks the contract version', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  for (const packagePath of ['packages/contracts/package.json', 'packages/sdk/package.json']) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, packagePath), 'utf8')) as {
      version: string;
    };
    assert.equal(manifest.version, CONTRACT_VERSION, `${packagePath} version drifted`);
  }
});

test('the SDK reports the contract version it was built against', () => {
  assert.equal(SDK_VERSION, sdkMetadata().version);
  assert.equal(SDK_CONTRACT_VERSION, CONTRACT_VERSION);
  assert.equal(sdkMetadata().contractVersion, CONTRACT_VERSION);
  assert.deepEqual(sdkMetadata().supportedContractVersions, ['1.0.0', '1.1.0', CONTRACT_VERSION]);
  assert.equal(typeof CoderaxClient.metadata.version, 'string');
});
