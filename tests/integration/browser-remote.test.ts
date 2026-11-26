import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { BrowserAction, BrowserSessionCreateRequest } from '@coderax/contracts';
import { startTestApp } from '../helpers.js';
import { PNG_1X1 } from '../fakes/browser.js';

/**
 * The remote adapter is exercised against a local server that implements
 * protocol v1. This proves the adapter, its strict parsing and its fail-closed
 * behavior; it does not prove that any cloud browser provider exists.
 */

const TOKEN = 'provider-token-0123456789abcdef';

type Behavior = 'ready' | 'paid' | 'missing' | 'malformed' | 'redirect' | 'unauthorized';

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

function features(overrides: Record<string, boolean> = {}) {
  return {
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
    ...overrides,
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function startProvider(behavior: Behavior): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const text = await readBody(request);
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        authorization: request.headers.authorization,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);

      if (behavior === 'redirect') {
        response.writeHead(302, { location: 'https://elsewhere.example.test/' });
        response.end();
        return;
      }
      if (behavior === 'unauthorized') {
        send(response, 401, { error: 'unauthorized' });
        return;
      }

      if (recorded.url === '/v1/capabilities' && recorded.method === 'GET') {
        if (behavior === 'malformed') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{not json');
          return;
        }
        send(response, 200, {
          protocolVersion: 1,
          provider: 'remote-test',
          costClass: behavior === 'paid' ? 'paid' : 'free',
          features: features(behavior === 'missing' ? { screenshots: false } : {}),
          limits: { maxSessionTtlSeconds: 3600 },
        });
        return;
      }

      if (recorded.url === '/v1/sessions' && recorded.method === 'POST') {
        send(response, 200, {
          providerSessionId: 'ps_remote_1',
          url: 'about:blank',
          title: '',
          tabs: [{ tabId: 'tab-remote', url: 'about:blank', title: '', active: true }],
        });
        return;
      }

      if (recorded.url === '/v1/sessions/ps_remote_1/actions') {
        const action = (recorded.body as { action?: BrowserAction }).action;
        if (action?.type === 'screenshot') {
          send(response, 200, {
            url: 'https://example.test/',
            title: 'Remote example',
            tabs: [{ tabId: 'tab-remote', url: 'https://example.test/', title: 'Remote', active: true }],
            observation: { text: 'Remote page text', elements: [], truncated: false },
            artifacts: [
              {
                kind: 'screenshot',
                contentType: 'image/png',
                dataBase64: PNG_1X1.toString('base64'),
              },
            ],
          });
          return;
        }
        send(response, 200, {
          url:
            action?.type === 'navigate' ? action.url : 'https://example.test/',
          title: 'Remote example',
          tabs: [
            {
              tabId: 'tab-remote',
              url: action?.type === 'navigate' ? action.url : 'https://example.test/',
              title: 'Remote example',
              active: true,
            },
          ],
          ...(action?.type === 'inspect'
            ? { observation: { text: 'Remote page text', elements: [], truncated: false } }
            : {}),
        });
        return;
      }

      if (recorded.url === '/v1/sessions/ps_remote_1/takeover') {
        send(response, 200, { interactiveUrl: 'https://live.example.test/remote' });
        return;
      }

      send(response, 200, { ok: true });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function browserConfig(baseURL: string, overrides: Record<string, unknown> = {}) {
  return {
    browsers: {
      enabled: true,
      provider: 'http',
      remote: {
        baseURL,
        tokenEnv: 'CODERAX_TEST_BROWSER_TOKEN',
        timeoutMs: 2_000,
        zeroCostAttested: true,
        ...overrides,
      },
    },
  };
}

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('a zero-cost provider that answers the handshake becomes operational', async () => {
  const provider = await startProvider('ready');
  const started = await startTestApp({
    config: browserConfig(provider.url),
    env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
  });
  try {
    const capabilities = await started.app.service.browserCapabilities();
    assert.equal(capabilities.operational, true);
    assert.equal(capabilities.reason, 'ready');
    assert.equal(capabilities.provider, 'remote-test');
    assert.equal(capabilities.costClass, 'free');
    assert.ok(Object.values(capabilities.features).every(Boolean));

    const created = await started.app.service.createBrowserSession(principal, {
      label: 'Remote research',
      purpose: 'research',
      origins: ['https://example.test'],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.state, 'ready');
    assert.equal(created.value.provider, 'http-contract');

    const acted = await started.app.service.browserAction(
      principal,
      created.value.sessionId,
      {
        type: 'navigate',
        url: 'https://example.test/page',
        intent: { category: 'navigate', description: 'Open the page' },
      } as unknown as BrowserAction,
    );
    assert.equal(acted.ok, true);

    const captured = await started.app.service.browserAction(
      principal,
      created.value.sessionId,
      { type: 'screenshot' } as unknown as BrowserAction,
    );
    assert.equal(captured.ok, true);
    if (captured.ok) {
      assert.equal(captured.value.artifact?.kind, 'screenshot');
      assert.equal(captured.value.artifact?.bytes, PNG_1X1.length);
    }

    const createdRequests = provider.requests.filter((entry) => entry.url === '/v1/sessions');
    assert.equal(createdRequests.length, 1);
    const actionRequest = provider.requests.find((entry) =>
      entry.url.endsWith('/actions'),
    );
    assert.ok(actionRequest);
    const actionBody = actionRequest.body as { action?: Record<string, unknown> };
    assert.equal(actionBody.action?.type, 'navigate');
    assert.equal('intent' in (actionBody.action ?? {}), false);
    assert.equal('approvalId' in (actionBody.action ?? {}), false);

    // The token is a bearer header only; it never appears in a URL.
    assert.ok(provider.requests.every((entry) => entry.authorization === `Bearer ${TOKEN}`));
    assert.ok(provider.requests.every((entry) => !entry.url.includes(TOKEN)));
    assert.equal(JSON.stringify(capabilities).includes(TOKEN), false);
  } finally {
    await started.close();
    await provider.close();
  }
});

test('a paid provider is refused and no session is created', async () => {
  const provider = await startProvider('paid');
  const started = await startTestApp({
    config: browserConfig(provider.url),
    env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
  });
  try {
    const capabilities = await started.app.service.browserCapabilities();
    assert.equal(capabilities.operational, false);
    assert.equal(capabilities.reason, 'paid_refused');
    assert.equal(capabilities.costClass, 'paid');

    const created = await started.app.service.createBrowserSession(principal, {
      label: 'Paid should fail',
      purpose: 'research',
      origins: ['https://example.test'],
    });
    assert.equal(created.ok, false);
    assert.equal(created.ok === false && created.code, 'engine_not_configured');
    assert.equal(provider.requests.filter((entry) => entry.url === '/v1/sessions').length, 0);
  } finally {
    await started.close();
    await provider.close();
  }
});

test('a provider missing a required feature is not operational', async () => {
  const provider = await startProvider('missing');
  const started = await startTestApp({
    config: browserConfig(provider.url),
    env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
  });
  try {
    const capabilities = await started.app.service.browserCapabilities();
    assert.equal(capabilities.operational, false);
    assert.equal(capabilities.reason, 'missing_features');
    assert.equal(capabilities.features.screenshots, false);
    assert.equal(capabilities.features.navigation, true);

    const created = await started.app.service.createBrowserSession(principal, {
      label: 'Missing feature',
      purpose: 'testing',
      origins: ['https://example.test'],
    });
    assert.equal(created.ok, false);
  } finally {
    await started.close();
    await provider.close();
  }
});

test('malformed, redirected and unauthorized providers fail closed', async () => {
  for (const [behavior, reason, code] of [
    ['malformed', 'protocol_error', 'protocol_error'],
    ['redirect', 'unreachable', 'browser_unavailable'],
    ['unauthorized', 'unverified', 'engine_not_configured'],
  ] as const) {
    const provider = await startProvider(behavior);
    const started = await startTestApp({
      config: browserConfig(provider.url),
      env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
    });
    try {
      const capabilities = await started.app.service.browserCapabilities();
      assert.equal(capabilities.operational, false, behavior);
      assert.equal(capabilities.reason, reason, behavior);

      const created = await started.app.service.createBrowserSession(principal, {
        label: behavior,
        purpose: 'research',
        origins: ['https://example.test'],
      });
      assert.equal(created.ok, false);
      assert.equal(created.ok === false && created.code, code, behavior);
      assert.equal(JSON.stringify(capabilities).includes(TOKEN), false);
    } finally {
      await started.close();
      await provider.close();
    }
  }
});

test('an unattested endpoint is never contacted', async () => {
  const provider = await startProvider('ready');
  const started = await startTestApp({
    config: browserConfig(provider.url, { zeroCostAttested: false }),
    env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
  });
  try {
    const capabilities = await started.app.service.browserCapabilities();
    assert.equal(capabilities.operational, false);
    assert.equal(capabilities.reason, 'unverified');
    assert.equal(provider.requests.length, 0);
  } finally {
    await started.close();
    await provider.close();
  }
});

test('a missing provider token is reported by variable name, never invented', async () => {
  const provider = await startProvider('ready');
  const started = await startTestApp({ config: browserConfig(provider.url), env: {} });
  try {
    const capabilities = await started.app.service.browserCapabilities();
    assert.equal(capabilities.operational, false);
    assert.equal(capabilities.reason, 'not_configured');
    assert.match(capabilities.detail, /CODERAX_TEST_BROWSER_TOKEN/);
    assert.equal(provider.requests.length, 0);
  } finally {
    await started.close();
    await provider.close();
  }
});

test('remote take over returns a live view without persisting it', async () => {
  const provider = await startProvider('ready');
  const started = await startTestApp({
    config: browserConfig(provider.url),
    env: { CODERAX_TEST_BROWSER_TOKEN: TOKEN },
  });
  try {
    const created = await started.app.service.createBrowserSession(principal, {
      label: 'Takeover',
      purpose: 'testing',
      origins: ['https://example.test'],
      ttlSeconds: 120,
    } as BrowserSessionCreateRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const takeover = await started.app.service.takeoverBrowserSession(
      principal,
      created.value.sessionId,
      { active: true },
    );
    assert.equal(takeover.ok, true);
    if (!takeover.ok) return;
    assert.equal(takeover.value.session.state, 'owner_controlled');
    assert.equal(takeover.value.interactiveUrl, 'https://live.example.test/remote');

    const receipts = await started.app.service.browserReceipts(principal, created.value.sessionId);
    assert.equal(receipts.ok, true);
    assert.equal(JSON.stringify(receipts).includes('live.example.test'), false);
  } finally {
    await started.close();
    await provider.close();
  }
});
