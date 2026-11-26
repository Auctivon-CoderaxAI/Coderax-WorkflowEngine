import type { ModelRef, Usage } from '@coderax/contracts';
import type { ModelGateway } from './types.js';

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
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;

  return {
    id: 'openai-compatible',
    complete: async ({ model, system, prompt, signal, maxOutputTokens }) => {
      const endpoint = `${input.baseURL.replace(/\/+$/, '')}/chat/completions`;
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
