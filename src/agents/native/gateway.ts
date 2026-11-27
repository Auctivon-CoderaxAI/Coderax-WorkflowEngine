import type { ModelRef, Usage } from '@coderax/contracts';
import type { ModelGateway } from './types.js';

/**
 * Reject provider endpoints that can never be an owner-authorized inference
 * destination. This is a static SSRF/credential guard; DNS rebinding needs the
 * deployment egress allow-list in addition to this check.
 */
export function validateProviderBaseURL(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error('provider baseURL must use https');
  }
  if (url.username || url.password) {
    throw new Error('provider baseURL must not contain credentials');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
    /^::ffff:/i.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)
  ) {
    throw new Error('provider baseURL must not target a loopback, private or link-local address');
  }
  return url;
}

/**
 * A real provider call over the OpenAI-compatible chat-completions shape.
 *
 * Coderax routes only to verified zero-cost endpoints, so the key here belongs to
 * such an endpoint. The key is read by the caller from the environment once and
 * is never returned, logged, placed in a URL or echoed in an error: a failure
 * carries the status and a bounded, sanitized message only.
 */
export function createOpenAiCompatibleGateway(input: {
  baseURL: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelGateway {
  const baseURL = validateProviderBaseURL(input.baseURL).toString().replace(/\/+$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;

  return {
    id: 'openai-compatible',
    complete: async ({ model, system, prompt, signal, maxOutputTokens }) => {
      const endpoint = `${baseURL}/chat/completions`;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({
            model: model.modelId,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            stream: false,
            ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
          }),
          signal: controller.signal,
          redirect: 'error',
        });

        if (!response.ok) {
          throw new Error(`provider responded with HTTP ${response.status}`);
        }
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const text = body.choices?.[0]?.message?.content;
        if (typeof text !== 'string') {
          throw new Error('provider response did not contain message content');
        }
        const usage: Usage = {
          ...(typeof body.usage?.prompt_tokens === 'number'
            ? { inputTokens: body.usage.prompt_tokens }
            : {}),
          ...(typeof body.usage?.completion_tokens === 'number'
            ? { outputTokens: body.usage.completion_tokens }
            : {}),
        };
        return { text, usage };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  } satisfies ModelGateway;
}

export type { ModelRef };
