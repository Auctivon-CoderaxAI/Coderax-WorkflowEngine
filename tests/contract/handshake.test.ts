import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
  ROUTE_INDEX,
  contractFingerprint,
  negotiateContract,
} from '@coderax/contracts';

test('the handshake is published exactly once and is reachable without auth', () => {
  const route = ROUTE_INDEX.get('getHandshake');
  assert.ok(route, 'getHandshake must be declared in the catalogue');
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/v1/handshake');
  assert.equal(route.auth, 'public');
  const samePath = [...ROUTE_INDEX.values()].filter((entry) => entry.path === '/v1/handshake');
  assert.equal(samePath.length, 1, 'one path, one operation');
});

test('negotiation accepts the served version and an older advertised one', () => {
  assert.equal(negotiateContract(CONTRACT_VERSION).negotiation, 'exact');
  const older = negotiateContract('1.0.0');
  assert.equal(older.compatible, true);
  assert.equal(older.negotiation, 'client_supported');
  assert.equal(older.negotiatedContractVersion, '1.0.0');
  assert.equal(negotiateContract(undefined).negotiation, 'no_request');
});

test('negotiation refuses a newer minor, a foreign major and an unparseable value', () => {
  assert.equal(negotiateContract('1.99.0').negotiation, 'client_ahead');
  assert.equal(negotiateContract('1.99.0').compatible, false);
  assert.equal(negotiateContract('2.0.0').negotiation, 'unsupported_major');
  assert.equal(negotiateContract('not-a-version').negotiation, 'unparseable');
});

test('a matching version with a different catalogue is a fingerprint mismatch', () => {
  const result = negotiateContract(CONTRACT_VERSION, {
    provided: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    expected: CONTRACT_FINGERPRINT,
  });
  assert.equal(result.compatible, false);
  assert.equal(result.negotiation, 'fingerprint_mismatch');

  const matching = negotiateContract(CONTRACT_VERSION, {
    provided: CONTRACT_FINGERPRINT,
    expected: CONTRACT_FINGERPRINT,
  });
  assert.equal(matching.compatible, true);
});

test('the fingerprint pins operation identity, so two versions cannot collide silently', () => {
  const first = contractFingerprint([{ operationId: 'a', method: 'GET', path: '/v1/a' }]);
  const second = contractFingerprint([{ operationId: 'a', method: 'GET', path: '/v1/b' }]);
  assert.notEqual(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.match(CONTRACT_FINGERPRINT, /^sha256:[0-9a-f]{64}$/);
});
