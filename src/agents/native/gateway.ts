import type { ModelRef, Usage } from '@coderax/contracts';
import type { ModelGateway } from './types.js';
import { foldStreamUsage } from '../../models/tokens.js';
import { retryAfterMs as parseRetryAfter } from '../../models/circuit.js';

/**
 * A real provider call over the OpenAI-compatible chat-completions shape.
 *
 * Coderax routes only to verified zero-cost endpoints, so the key here belongs to
 * such an endpoint. The key is read by the caller from the environment once and
 * is never returned, logged, placed in a URL or echoed in an error: a failure
 * carries the status and a bounded, sanitized message only.
 *
 * Streaming is opt-in per call. When it is used, text deltas are accumulated and
 * the provider's usage frame is folded in, so a streamed turn is accounted for
 * exactly like a buffered one instead of appearing free.
 */

/** A provider failure with the status and retry window a caller may act on. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    if (retryAfter !== undefined) this.retryAfterMs = retryAfter;
  }
}

type StreamUsageFrame = { prompt_tokens?: unknown; completion_tokens?: unknown };

function frameText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';
  let text = '';
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (typeof delta !== 'object' || delta === null) continue;
    const content = (delta as { content?: unknown }).content;
    if (typeof content === 'string') text += content;
  }
  return text;
}

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
    complete: async ({ model, system, prompt, signal, maxOutputTokens, stream }) => {
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
            accept: stream ? 'text/event-stream, application/json' : 'application/json',
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({
            model: model.modelId,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            stream: stream === true,
            ...(stream === true ? { stream_options: { include_usage: true } } : {}),
            ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryAfter = parseRetryAfter(response.headers);
          throw new ProviderHttpError(
            response.status,
            `provider responded with HTTP ${response.status}`,
            retryAfter,
          );
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (stream === true && contentType.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let text = '';
          let usage: { inputTokens: number; outputTokens: number } = {
            inputTokens: 0,
            outputTokens: 0,
          };
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const payload = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('');
              if (payload.length > 0 && payload !== '[DONE]') {
                try {
                  const parsed = JSON.parse(payload) as {
                    choices?: unknown;
                    usage?: StreamUsageFrame;
                  };
                  text += frameText(parsed);
                  if (parsed.usage) usage = foldStreamUsage(usage, parsed.usage);
                } catch {
                  // A non-JSON keepalive frame is not an error.
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
          if (text.length === 0) {
            throw new ProviderHttpError(502, 'provider stream did not contain message content');
          }
          const reported: Usage = {
            ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
          };
          return { text, usage: reported };
        }

        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: StreamUsageFrame;
        };
        const text = body.choices?.[0]?.message?.content;
        if (typeof text !== 'string') {
          throw new ProviderHttpError(502, 'provider response did not contain message content');
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
