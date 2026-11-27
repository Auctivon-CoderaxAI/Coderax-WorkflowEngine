import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_FINGERPRINT, CONTRACT_VERSION, negotiateContract } from '@coderax/contracts';

test('the handshake names an advertised version, never the one it echoed back', () => {
  // 1.0.x is compatible with this build but 1.0.7 is not a version it serves.
  const patch = negotiateContract('1.0.7');
  assert.equal(patch.compatible, true);
  assert.equal(patch.negotiation, 'client_supported');
  assert.equal(patch.negotiatedContractVersion, '1.0.0');

  // A patch above an advertised minor lands on that minor, not on the newest one.
  const newer = negotiateContract('1.1.9');
  assert.equal(newer.compatible, true);
  assert.equal(newer.negotiatedContractVersion, '1.1.0');

  const olderPatch = negotiateContract('1.2.9');
  assert.equal(olderPatch.compatible, true);
  assert.equal(olderPatch.negotiatedContractVersion, '1.2.0');

  const newestPatch = negotiateContract('1.3.9');
  assert.equal(newestPatch.compatible, true);
  assert.equal(newestPatch.negotiatedContractVersion, CONTRACT_VERSION);

  // The exact served version is still reported as exact.
  const exact = negotiateContract(CONTRACT_VERSION);
  assert.equal(exact.negotiation, 'exact');
  assert.equal(exact.negotiatedContractVersion, CONTRACT_VERSION);
});

test('a catalogue that shares the version string but not the wire is refused', () => {
  const agreed = negotiateContract(CONTRACT_VERSION, {
    provided: CONTRACT_FINGERPRINT,
    expected: CONTRACT_FINGERPRINT,
  });
  assert.equal(agreed.compatible, true);
  assert.equal(agreed.negotiation, 'exact');

  // A zero-padded patch still parses as the served version, so the fingerprint
  // is what decides whether the wire agrees.
  assert.equal(
    negotiateContract('1.03.0', {
      provided: 'different',
      expected: CONTRACT_FINGERPRINT,
    }).negotiation,
    'fingerprint_mismatch',
  );

  const different = negotiateContract(CONTRACT_VERSION, {
    provided: `sha256:${'0'.repeat(64)}`,
    expected: CONTRACT_FINGERPRINT,
  });
  assert.equal(different.compatible, false);
  assert.equal(different.negotiation, 'fingerprint_mismatch');
  assert.equal(different.negotiatedContractVersion, CONTRACT_VERSION);
});
