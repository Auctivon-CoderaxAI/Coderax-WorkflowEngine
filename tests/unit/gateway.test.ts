import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAiCompatibleGateway } from '../../src/agents/native/gateway.js';

const MODEL = { providerId: 'fixture', modelId: 'vision-model' };
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type SentRequest = { url: string; body: Record<string, unknown> };

function capture(): { requests: SentRequest[]; fetchImpl: typeof fetch } {
  const requests: SentRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { requests, fetchImpl };
}

test('the OpenAI-compatible gateway sends images as content parts on the user turn', async () => {
  const { requests, fetchImpl } = capture();
  const gateway = createOpenAiCompatibleGateway({
    baseURL: 'https://inference.example/v1',
    apiKey: 'fixture-key',
    fetchImpl,
  });

  const result = await gateway.complete({
    model: MODEL,
    system: 'You are Coderax Native.',
    prompt: 'What is in this image?',
    images: [IMAGE],
    signal: new AbortController().signal,
  });

  assert.equal(result.text, 'ok');
  assert.equal(requests.length, 1);
  const [sent] = requests;
  assert.ok(sent);
  assert.equal(sent.url, 'https://inference.example/v1/chat/completions');
  const messages = sent.body.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
  // The image is an OpenAI-compatible content part, not dropped and not inlined
  // into the text prompt.
  assert.deepEqual(messages[1]?.content, [
    { type: 'text', text: 'What is in this image?' },
    { type: 'image_url', image_url: { url: IMAGE } },
  ]);
});

test('a text-only turn keeps the plain string content shape', async () => {
  const { requests, fetchImpl } = capture();
  const gateway = createOpenAiCompatibleGateway({
    baseURL: 'https://inference.example/v1',
    apiKey: 'fixture-key',
    fetchImpl,
  });

  await gateway.complete({
    model: MODEL,
    system: 'You are Coderax Native.',
    prompt: 'Text only.',
    signal: new AbortController().signal,
  });

  const messages = requests[0]?.body.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages[1]?.content, 'Text only.');
  assert.equal(JSON.stringify(requests[0]?.body).includes('image_url'), false);
});
