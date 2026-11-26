import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, negotiateContract } from '@coderax/contracts';

test('the handshake names an advertised version, never the one it echoed back', () => {
  // 1.0.x is compatible with this build but 1.0.7 is not a version it serves.
  const patch = negotiateContract('1.0.7');
  assert.equal(patch.compatible, true);
  assert.equal(patch.negotiation, 'client_supported');
  assert.equal(patch.negotiatedContractVersion, '1.0.0');

  // An unadvertised patch above the current minor still lands on a served version.
  const newer = negotiateContract('1.1.9');
  assert.equal(newer.compatible, true);
  assert.equal(newer.negotiatedContractVersion, CONTRACT_VERSION);

  // The exact served version is still reported as exact.
  const exact = negotiateContract(CONTRACT_VERSION);
  assert.equal(exact.negotiation, 'exact');
  assert.equal(exact.negotiatedContractVersion, CONTRACT_VERSION);
});
