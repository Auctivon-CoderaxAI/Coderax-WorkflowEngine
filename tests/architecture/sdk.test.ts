import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSdk } from '../../scripts/gate/sdk.js';

test('the SDK calls every catalogue operation on its published method and path', async () => {
  const result = await checkSdk();
  assert.deepEqual(result.findings, []);
});

test('the SDK has no second contract of its own', async () => {
  const result = await checkSdk();
  assert.equal(result.findings.filter((finding) => finding.rule === 'sdk-second-contract').length, 0);
});
