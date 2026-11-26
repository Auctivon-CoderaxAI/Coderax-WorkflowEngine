import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOpenAiCompatibleGateway,
  validateProviderBaseURL,
} from '../../src/agents/native/gateway.js';

test('provider endpoints reject plaintext, credentials and private SSRF targets', () => {
  for (const value of [
    'http://provider.test',
    'https://user:secret@provider.test',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://192.168.1.10',
    'https://172.16.0.1',
    'https://169.254.169.254',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
  ]) {
    assert.throws(() => validateProviderBaseURL(value), Error, value);
  }
  assert.equal(validateProviderBaseURL('https://provider.test/v1').hostname, 'provider.test');
});

test('the gateway refuses redirects and never follows a provider redirect', async () => {
  const calls: Array<{ url: string; redirect?: string }> = [];
  const gateway = createOpenAiCompatibleGateway({
    baseURL: 'https://provider.test/v1',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'verified' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await gateway.complete({
    model: { providerId: 'free', modelId: 'test' },
    system: 'system',
    prompt: 'prompt',
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'verified');
  assert.equal(calls[0]?.url, 'https://provider.test/v1/chat/completions');
  assert.equal(calls[0]?.redirect, 'error');
});

test('a provider endpoint with an unsafe scheme fails before any fetch', () => {
  assert.throws(
    () =>
      createOpenAiCompatibleGateway({
        baseURL: 'http://provider.test',
        apiKey: 'test-key',
        fetchImpl: async () => new Response('{}'),
      }),
    /https/,
  );
});
