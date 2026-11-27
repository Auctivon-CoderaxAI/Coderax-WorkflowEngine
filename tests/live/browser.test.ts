import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BROWSER_PROTOCOL_VERSION } from '@coderax/contracts';
import { createHttpBrowserProvider } from '../../src/browser/remote.js';

/**
 * Live provider boundary.
 *
 * The integration suite covers the adapter with a stubbed `fetch`. This suite
 * opens a real socket to a protocol-v1 provider and proves the handshake and the
 * zero-cost refusal over HTTP, so an adapter that only works against a fake
 * transport cannot pass.
 */

const TOKEN = 'live-provider-token-0123456789abcdef';

const limits = {
  maxSessionTtlSeconds: 900,
  maxSessionsPerOwner: 3,
  maxScreenshotBytes: 2_097_152,
  maxUploadBytes: 524_288,
};

const features = {
  sessions: true,
  navigation: true,
  inspection: true,
  screenshots: true,
  accessibleElements: true,
  forms: true,
  keyboard: true,
  mouse: true,
  tabs: true,
  uploads: true,
  downloads: true,
  sessionPersistence: true,
  pauseResume: true,
  takeover: true,
};

async function startProvider(costClass: 'free' | 'paid'): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/capabilities') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      provider: 'live-boundary',
      costClass,
      features,
      limits: { maxSessionTtlSeconds: limits.maxSessionTtlSeconds },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test('a real provider socket answers the versioned handshake and is operational', async () => {
  const provider = await startProvider('free');
  try {
    const adapter = createHttpBrowserProvider({
      baseURL: provider.url,
      token: TOKEN,
      timeoutMs: 2_000,
      limits,
      trusted: true,
    });
    const capabilities = await adapter.describe();
    assert.equal(capabilities.operational, true, capabilities.detail);
    assert.equal(capabilities.costClass, 'free');
    assert.equal(capabilities.reason, 'ready');
  } finally {
    await provider.close();
  }
});

test('a real provider that reports a paid cost class is refused over the wire', async () => {
  const provider = await startProvider('paid');
  try {
    const adapter = createHttpBrowserProvider({
      baseURL: provider.url,
      token: TOKEN,
      timeoutMs: 2_000,
      limits,
      trusted: true,
    });
    const capabilities = await adapter.describe();
    assert.equal(capabilities.operational, false);
    assert.equal(capabilities.reason, 'paid_refused');
    assert.equal(capabilities.costClass, 'paid');
  } finally {
    await provider.close();
  }
});
