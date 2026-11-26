import type { ModelRef, Usage } from '@coderax/contracts';
import type { ModelGateway, ModelToolCall } from './types.js';

/**
 * A real provider call over the OpenAI-compatible chat-completions shape.
 *
 * Native function calling is attempted only when the caller supplies tool
 * definitions, which the agent does only for a model whose evidence records
 * verified tool support. A provider that rejects the `tools` field raises
 * `ToolCallingUnsupportedError`; the agent then retries the same model with the
 * documented JSON action protocol instead of silently failing. That is the
 * verification path: support is proven on the wire, not assumed from a name.
 *
 * The key is read by the caller from the environment once and is never returned,
 * logged, placed in a URL or echoed in an error.
 */

export class ToolCallingUnsupportedError extends Error {
  constructor() {
    super('The provider does not accept native tool definitions.');
    this.name = 'ToolCallingUnsupportedError';
  }
}

function isLoopback(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createOpenAiCompatibleGateway(input: {
  baseURL: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelGateway {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const endpoint = `${input.baseURL.replace(/\/+$/, '')}/chat/completions`;

  /**
   * A credential may only travel over TLS, except to a loopback development
   * endpoint on the same machine.
   */
  function endpointIssue(): string | null {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return 'The configured inference endpoint is not a valid URL.';
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return 'The inference endpoint may not carry credentials in the URL.';
    }
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && isLoopback(url.origin)) return null;
    return 'The inference endpoint must use https so the API key is never sent in cleartext.';
  }

  return {
    id: 'openai-compatible',
    supportsNativeTools: true,
    complete: async ({ model, system, prompt, signal, maxOutputTokens, tools }) => {
      const issue = endpointIssue();
      if (issue) throw new Error(issue);

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: model.modelId,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          stream: false,
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        };
        if (tools && tools.length > 0) {
          body.tools = tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          }));
          body.tool_choice = 'auto';
        }

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          // A 400/422 that names tools is the provider saying it does not accept
          // the field. That is a capability answer, not a transient failure.
          if (tools && tools.length > 0 && (response.status === 400 || response.status === 422)) {
            const detail = await response.text().catch(() => '');
            if (/tool|function/i.test(detail)) throw new ToolCallingUnsupportedError();
          }
          throw new Error(`provider responded with HTTP ${response.status}`);
        }
        const parsedBody = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: unknown;
              tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
            };
          }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const message = parsedBody.choices?.[0]?.message;
        const text = typeof message?.content === 'string' ? message.content : '';
        const rawCall = Array.isArray(message?.tool_calls) ? message.tool_calls[0] : undefined;
        const callName = rawCall?.function?.name;
        const toolCall: ModelToolCall | undefined =
          typeof callName === 'string' && callName.trim().length > 0
            ? { name: callName.trim().slice(0, 120), arguments: parseArguments(rawCall?.function?.arguments) }
            : undefined;

        if (text.trim().length === 0 && !toolCall) {
          throw new Error('provider response did not contain message content');
        }
        const usage: Usage = {
          ...(typeof parsedBody.usage?.prompt_tokens === 'number'
            ? { inputTokens: parsedBody.usage.prompt_tokens }
            : {}),
          ...(typeof parsedBody.usage?.completion_tokens === 'number'
            ? { outputTokens: parsedBody.usage.completion_tokens }
            : {}),
        };
        return { text, usage, ...(toolCall ? { toolCall } : {}) };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  } satisfies ModelGateway;
}

export type { ModelRef };
