import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  authorizeUrl,
  hostAllowed,
  isPublicAddress,
  pinnedRequest,
} from '../../src/security/network.js';

test('non-public address ranges are classified as private', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('host allowlisting is exact or an explicit dot-suffix', () => {
  assert.equal(hostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(hostAllowed('api.example.com', ['.example.com']), true);
  assert.equal(hostAllowed('evil-example.com', ['.example.com']), false);
  assert.equal(hostAllowed('example.com.evil.test', ['.example.com']), false);
  assert.equal(hostAllowed('API.EXAMPLE.COM', ['api.example.com']), true);
});

test('https, allowlisting, credentials and resolved address are all enforced', async () => {
  const plain = await authorizeUrl('http://1.1.1.1/', { allowedHosts: ['1.1.1.1'] });
  assert.equal(plain.ok, false);

  const notAllowed = await authorizeUrl('https://1.1.1.1/', { allowedHosts: ['api.example.com'] });
  assert.equal(notAllowed.ok, false);

  const credentials = await authorizeUrl('https://user:pass@1.1.1.1/', { allowedHosts: ['1.1.1.1'] });
  assert.equal(credentials.ok, false);

  const privateTarget = await authorizeUrl('https://127.0.0.1/', { allowedHosts: ['127.0.0.1'] });
  assert.equal(privateTarget.ok, false);
  assert.match(privateTarget.ok === false ? privateTarget.detail : '', /non-public/);

  const loopback = await authorizeUrl('http://127.0.0.1:8080/mcp', {
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
  });
  assert.equal(loopback.ok, true);
});

test('a redirect is surfaced, never followed, so it cannot escape the policy', async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (request.url === '/secret') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('secret');
      return;
    }
    response.writeHead(302, { location: '/secret' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const policy = { allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true };
    const authorized = await authorizeUrl(`http://127.0.0.1:${address.port}/start`, policy);
    assert.equal(authorized.ok, true);
    if (!authorized.ok) return;
    const response = await pinnedRequest(
      { target: authorized.target, method: 'GET' },
      { ...policy, maxBytes: 1_000, timeoutMs: 5_000 },
    );
    assert.equal(response.status, 302);
    assert.equal(response.text, '');
    assert.equal(hits, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
