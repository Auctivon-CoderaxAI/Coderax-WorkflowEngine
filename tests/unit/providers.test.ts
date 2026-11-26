import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiProvider } from '../../src/models/providers/gemini.js';
import { parseRateLimit, parseRetryAfter } from '../../src/models/providers/http.js';
import {
  createOpenAiProvider,
  parseCompletion,
  parseModelList,
} from '../../src/models/providers/openai.js';
import { ProviderError } from '../../src/models/types.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const openAiRequest = {
  model: { providerId: 'openrouter', modelId: 'inclusionai/ling-3.2-flash:free' },
  system: 'system',
  prompt: 'hello',
  signal: new AbortController().signal,
  maxOutputTokens: 64,
};

test('OpenRouter discovery uses published pricing, modalities and parameters', () => {
  const models = parseModelList('openrouter', {
    data: [
      {
        id: 'inclusionai/ling-3.2-flash:free',
        name: 'inclusionAI: Ling 3.2 Flash (free)',
        context_length: 1_048_576,
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        pricing: { prompt: '0', completion: '0', request: '0' },
        supported_parameters: ['tools', 'reasoning', 'include_reasoning'],
        top_provider: { max_completion_tokens: 262_144 },
      },
      {
        id: 'paid/model',
        name: 'Paid',
        context_length: 8_192,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['tools'],
      },
      {
        id: 'image/only',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        pricing: { prompt: '0', completion: '0' },
      },
    ],
  });
  assert.equal(models.length, 2);
  const free = models[0];
  assert.equal(free?.ref.modelId, 'inclusionai/ling-3.2-flash:free');
  assert.equal(free?.contextTokens, 1_048_576);
  assert.equal(free?.maxOutputTokens, 262_144);
  assert.equal(free?.capabilities.vision, true);
  assert.equal(free?.capabilities.toolCalling, true);
  assert.equal(free?.capabilities.reasoning, true);
  assert.deepEqual(free?.pricing, { prompt: '0', completion: '0', request: '0' });
});

test('OpenAI-compatible streaming reassembles fragmented tool arguments', async () => {
  const provider = createOpenAiProvider({
    id: 'openrouter',
    baseURL: 'https://openrouter.example/api/v1',
    apiKey: 'secret-key',
    fetchImpl: (async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ])) as typeof fetch,
  });
  const events = [];
  for await (const event of provider.stream?.(openAiRequest) ?? []) events.push(event);
  assert.equal(
    events.filter((event) => event.type === 'text').map((event) => (event.type === 'text' ? event.text : '')).join(''),
    'Hello',
  );
  const tool = events.find((event) => event.type === 'tool');
  assert.equal(tool?.type === 'tool' && tool.call.name, 'read_file');
  assert.deepEqual(tool?.type === 'tool' && tool.call.arguments, { path: 'README.md' });
  const usage = events.find((event) => event.type === 'usage');
  assert.deepEqual(usage?.type === 'usage' && usage.usage, { inputTokens: 10, outputTokens: 3 });
  assert.equal(events.filter((event) => event.type === 'usage').length, 1);
  assert.equal(events.at(-1)?.type, 'done');
});

test('OpenAI-compatible SSE accepts CRLF frames and emits usage once', async () => {
  const provider = createOpenAiProvider({
    id: 'openrouter',
    baseURL: 'https://openrouter.example/api/v1',
    apiKey: 'key',
    fetchImpl: (async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ])) as typeof fetch,
  });
  const events = [];
  for await (const event of provider.stream?.(openAiRequest) ?? []) events.push(event);
  assert.equal(
    events.filter((event) => event.type === 'text').map((event) => (event.type === 'text' ? event.text : '')).join(''),
    'Hi',
  );
  assert.equal(events.filter((event) => event.type === 'usage').length, 1);
  const usage = events.find((event) => event.type === 'usage');
  assert.deepEqual(usage?.type === 'usage' && usage.usage, { inputTokens: 4, outputTokens: 2 });
});

test('a fragmented or invalid tool payload is preserved, not silently dropped', () => {
  const completion = parseCompletion('p', {
    choices: [
      {
        message: {
          tool_calls: [
            { id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.equal(completion.toolCalls.length, 1);
  assert.equal(completion.toolCalls[0]?.rawArguments, '{"path":');
});

test('429 quota, ordinary rate limit and secret redaction are distinguished', async () => {
  const quota = createOpenAiProvider({
    id: 'groq',
    baseURL: 'https://groq.example/openai/v1',
    apiKey: 'never-print-this-key',
    fetchImpl: (async () =>
      json(
        { error: { code: 'insufficient_quota', message: 'add credits' } },
        429,
      )) as typeof fetch,
  });
  await assert.rejects(
    () => quota.complete(openAiRequest),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'quota');
      assert.equal(error.quotaExhausted, true);
      assert.ok(!error.message.includes('never-print-this-key'));
      assert.ok(!error.message.includes('add credits'));
      return true;
    },
  );

  const limited = createOpenAiProvider({
    id: 'groq',
    baseURL: 'https://groq.example/openai/v1',
    apiKey: 'key',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      })) as typeof fetch,
  });
  await assert.rejects(
    () => limited.complete(openAiRequest),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.retryAfterMs, 7_000);
      return true;
    },
  );
});

test('Gemini discovery keeps the key in a header and marks generateContent models', async () => {
  const seen: Array<{ url: string; key: string | null }> = [];
  const provider = createGeminiProvider({
    id: 'gemini',
    baseURL: 'https://generativelanguage.example/v1beta',
    apiKey: 'gemini-secret',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), key: headers.get('x-goog-api-key') });
      return json({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      });
    }) as typeof fetch,
  });
  const models = await provider.discover();
  assert.equal(models.length, 1);
  assert.equal(models[0]?.ref.modelId, 'gemini-2.5-flash');
  assert.equal(models[0]?.pricing, null);
  assert.equal(models[0]?.capabilities.toolCalling, true);
  assert.equal(models[0]?.capabilities.vision, true);
  assert.equal(seen[0]?.key, 'gemini-secret');
  assert.ok(!seen[0]?.url.includes('gemini-secret'));
});

test('Gemini normalizes text and functionCall parts', async () => {
  const provider = createGeminiProvider({
    id: 'gemini',
    baseURL: 'https://generativelanguage.example/v1beta',
    apiKey: 'key',
    fetchImpl: (async () =>
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: 'hello' },
                { functionCall: { name: 'read_file', args: { path: 'README.md' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      })) as typeof fetch,
  });
  const completion = await provider.complete({
    ...openAiRequest,
    model: { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
  });
  assert.equal(completion.text, 'hello');
  assert.equal(completion.toolCalls[0]?.name, 'read_file');
  assert.deepEqual(completion.toolCalls[0]?.arguments, { path: 'README.md' });
  assert.deepEqual(completion.usage, { inputTokens: 5, outputTokens: 3 });
});

test('Gemini SSE accepts CRLF frames and emits normalized usage', async () => {
  const provider = createGeminiProvider({
    id: 'gemini',
    baseURL: 'https://generativelanguage.example/v1beta',
    apiKey: 'key',
    fetchImpl: (async () =>
      sse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\r\n\r\n',
        'data: {"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\r\n\r\n',
      ])) as typeof fetch,
  });
  const events = [];
  for await (const event of provider.stream?.({
    ...openAiRequest,
    model: { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
  }) ?? []) events.push(event);
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
  assert.equal(events.filter((event) => event.type === 'usage').length, 1);
  assert.equal(events.at(-1)?.type, 'done');
});

test('provider reset headers are parsed, including composite Groq windows', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '7' })), 7_000);
  const facts = parseRateLimit(
    new Headers({
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-remaining-tokens': '100',
      'x-ratelimit-reset-requests': '2m59.56s',
      'x-ratelimit-reset-tokens': '7.66s',
    }),
  );
  assert.equal(facts.remainingRequests, 0);
  assert.equal(facts.remainingTokens, 100);
  assert.equal(facts.resetRequestsMs, 179_560);
  assert.equal(facts.resetTokensMs, 7_660);
});

test('Gemini RESOURCE_EXHAUSTED becomes a quota failure', async () => {
  const provider = createGeminiProvider({
    id: 'gemini',
    baseURL: 'https://generativelanguage.example/v1beta',
    apiKey: 'key',
    fetchImpl: (async () =>
      json(
        {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exceeded for quota metric PerDay',
          },
        },
        429,
      )) as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.complete({
        ...openAiRequest,
        model: { providerId: 'gemini', modelId: 'gemini-2.5-flash' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'quota');
      return true;
    },
  );
});
