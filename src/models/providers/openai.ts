import type {
  DiscoveredModel,
  NormalizedMessage,
  ProviderAdapter,
  ProviderCompletionRequest,
  ProviderStreamEvent,
  ToolCall,
} from '../types.js';
import { ProviderError } from '../types.js';
import { assertSecureBaseURL, providerErrorFromResponse, toProviderError } from './http.js';

const MAX_SSE_BUFFER_BYTES = 1_048_576;
const MAX_TOOL_ARGUMENT_BYTES = 4_194_304;

/**
 * OpenAI-compatible discovery and chat completions.
 *
 * One adapter covers OpenRouter, Groq, Cerebras, an OpenCode server and any other
 * endpoint that speaks the same shapes. No provider name changes routing unless
 * its metadata says so; no `:free` suffix and no successful key check is treated
 * as proof of a zero price.
 */
export function createOpenAiProvider(input: {
  id: string;
  baseURL: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}): ProviderAdapter {
  assertSecureBaseURL(input.baseURL);
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseURL.replace(/\/+$/, '');
  const authHeaders = {
    authorization: `Bearer ${input.apiKey}`,
    ...input.headers,
  };

  return {
    id: input.id,
    kind: 'openai',
    discover: async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/models`, {
          method: 'GET',
          headers: { accept: 'application/json', ...authHeaders },
          redirect: 'error',
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw toProviderError(input.id, error, signal ?? new AbortController().signal);
      }
      if (!response.ok) throw await providerErrorFromResponse({ response, provider: input.id });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError('invalid', `${input.id} returned an unreadable model list.`, {
          retryable: false,
        });
      }
      return parseModelList(input.id, body);
    },
    complete: async (request) => {
      const response = await call(fetchImpl, base, authHeaders, input.id, request, false);
      const body = await readJson(response, input.id);
      return parseCompletion(input.id, body);
    },
    embed: async (request) => {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/embeddings`, {
          method: 'POST',
          // A redirect must never forward document text or the key elsewhere.
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ model: request.model.modelId, input: request.texts }),
          signal: request.signal,
        });
      } catch (error) {
        throw toProviderError(input.id, error, request.signal);
      }
      if (!response.ok) throw await providerErrorFromResponse({ response, provider: input.id });
      const body = await readJson(response, input.id);
      return parseEmbeddings(input.id, body, request.texts.length);
    },
    stream: async function* (request): AsyncGenerator<ProviderStreamEvent> {
      const response = await call(fetchImpl, base, authHeaders, input.id, request, true);
      yield* parseStream(input.id, response, request.signal);
    },
  };
}

async function call(
  fetchImpl: typeof fetch,
  base: string,
  headers: Record<string, string>,
  provider: string,
  request: ProviderCompletionRequest,
  stream: boolean,
): Promise<Response> {
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      // A redirect must never forward a prompt or key to another origin.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        model: request.model.modelId,
        messages: toMessages(request),
        stream,
        ...(request.maxOutputTokens === undefined
          ? {}
          : { max_tokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  ...(tool.description === undefined ? {} : { description: tool.description }),
                  parameters: tool.parameters,
                },
              })),
              tool_choice: 'auto',
            }
          : {}),
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: request.signal,
    });
    if (!response.ok) throw await providerErrorFromResponse({ response, provider });
    return response;
  } catch (error) {
    throw toProviderError(provider, error, request.signal);
  }
}

function toMessages(request: ProviderCompletionRequest): unknown[] {
  if (!request.messages || request.messages.length === 0) {
    return [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
  }
  return request.messages.map(toMessage);
}

function toMessage(message: NormalizedMessage): unknown {
  if (message.images && message.images.length > 0) {
    const parts: unknown[] = [];
    if (message.text.length > 0) parts.push({ type: 'text', text: message.text });
    for (const image of message.images) {
      parts.push({ type: 'image_url', image_url: { url: image } });
    }
    return { role: message.role, content: parts };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.text,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.name === undefined ? {} : { name: message.name }),
    };
  }
  return { role: message.role, content: message.text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseModelList(providerId: string, body: unknown): DiscoveredModel[] {
  const root = asRecord(body);
  const data = root?.data;
  if (!Array.isArray(data)) {
    throw new ProviderError('invalid', `${providerId} returned an unexpected model list.`, {
      retryable: false,
    });
  }
  const discovered: DiscoveredModel[] = [];
  for (const entry of data) {
    const model = asRecord(entry);
    if (!model || typeof model.id !== 'string' || model.id.length === 0) continue;
    const architecture = asRecord(model.architecture);
    const outputs = Array.isArray(architecture?.output_modalities)
      ? architecture.output_modalities.filter((value): value is string => typeof value === 'string')
      : [];
    if (outputs.length > 0 && !outputs.includes('text')) continue;
    const inputs = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities.filter((value): value is string => typeof value === 'string')
      : [];
    const parameters = Array.isArray(model.supported_parameters)
      ? model.supported_parameters.filter((value): value is string => typeof value === 'string')
      : [];
    const top = asRecord(model.top_provider);
    const context = firstPositive(model.context_length, top?.context_length, model.context_window);
    const maxOutput = firstPositive(top?.max_completion_tokens, model.max_completion_tokens);
    // An absent pricing object may be covered by an attestation. A present but
    // malformed one is different: it is a published claim we cannot verify, so
    // it must not silently fall through to the attestation path.
    if (model.pricing !== undefined && model.pricing !== null && asRecord(model.pricing) === null) {
      continue;
    }
    const pricing = model.pricing === undefined || model.pricing === null
      ? null
      : asRecord(model.pricing);
    const expiration = typeof model.expiration_date === 'string' ? Date.parse(model.expiration_date) : NaN;
    discovered.push({
      ref: { providerId, modelId: model.id },
      label:
        typeof model.name === 'string' && model.name.length > 0
          ? model.name.slice(0, 160)
          : model.id.slice(0, 160),
      ...(context === undefined ? {} : { contextTokens: context }),
      ...(maxOutput === undefined ? {} : { maxOutputTokens: maxOutput }),
      capabilities: {
        vision: inputs.includes('image'),
        toolCalling: parameters.includes('tools') || parameters.includes('tool_choice'),
        reasoning:
          parameters.includes('reasoning') ||
          parameters.includes('include_reasoning'),
        streaming: true,
      },
      pricing,
      ...(Number.isFinite(expiration) && expiration > 0 ? { deprecated: expiration <= Date.now() } : {}),
    });
  }
  return discovered;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

/**
 * An embeddings body is either a complete numeric batch or an invalid response.
 * A short batch, a string component or a non-finite number is refused rather than
 * padded, so a partial vector can never be stored as if it were an embedding.
 */
export function parseEmbeddings(
  provider: string,
  body: unknown,
  expected: number,
): number[][] {
  const rows = (body as { data?: unknown }).data;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new ProviderError(
      'invalid',
      `${provider} returned an embeddings batch that did not match the request.`,
      { retryable: false },
    );
  }
  return rows.map((row) => {
    const embedding = (row as { embedding?: unknown }).embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new ProviderError('invalid', `${provider} returned a non-numeric embedding.`, {
        retryable: false,
      });
    }
    return embedding as number[];
  });
}

async function readJson(response: Response, provider: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError('invalid', `${provider} returned an unreadable response.`, {
      retryable: false,
    });
  }
}

export function parseCompletion(provider: string, body: unknown): {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
} {
  const root = asRecord(body);
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('invalid', `${provider} returned no completion choice.`, {
      retryable: false,
    });
  }
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const text = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = parseToolCalls(message?.tool_calls, message?.function_call);
  if (text.length === 0 && toolCalls.length === 0) {
    throw new ProviderError('invalid', `${provider} returned neither text nor a tool call.`, {
      retryable: false,
    });
  }
  const usage = asRecord(root?.usage);
  const inputTokens = numberOrUndefined(usage?.prompt_tokens);
  const outputTokens = numberOrUndefined(usage?.completion_tokens);
  return {
    text,
    toolCalls,
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : {
          usage: {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          },
        }),
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function parseToolCalls(rawCalls: unknown, legacy: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((entry, index) => {
      const record = asRecord(entry);
      const fn = asRecord(record?.function);
      const name = typeof fn?.name === 'string' ? fn.name : '';
      if (name.length === 0) return;
      const rawArguments =
        typeof fn?.arguments === 'string'
          ? fn.arguments
          : fn?.arguments === undefined
            ? ''
            : JSON.stringify(fn.arguments);
      calls.push({
        id:
          typeof record?.id === 'string' && record.id.length > 0
            ? record.id
            : `call_${index}`,
        name,
        arguments: parseArguments(rawArguments),
        ...(parseArguments(rawArguments) === rawArguments ? { rawArguments } : {}),
      });
    });
  }
  const legacyFn = asRecord(legacy);
  if (calls.length === 0 && typeof legacyFn?.name === 'string') {
    const raw = typeof legacyFn.arguments === 'string' ? legacyFn.arguments : '';
    calls.push({
      id: 'call_legacy',
      name: legacyFn.name,
      arguments: parseArguments(raw),
      ...(parseArguments(raw) === raw ? { rawArguments: raw } : {}),
    });
  }
  return calls;
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * SSE normalization. OpenAI-compatible providers stream content deltas and
 * fragmented tool-call arguments; the adapter reassembles calls by index and
 * emits a complete tool call only at the end of the stream.
 */
export async function* parseStream(
  provider: string,
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  if (!response.body) {
    throw new ProviderError('invalid', `${provider} returned no response stream.`, {
      retryable: false,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let finishReason: string | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(
          'invalid',
          `${provider} sent an SSE frame larger than the safety limit.`,
          { retryable: false },
        );
      }
      for (;;) {
        // LF, CRLF and lone CR are all valid SSE line endings. Do not split a
        // delimiter that arrives across two reads.
        const delimiter = buffer.match(/\r\n\r\n|\n\n|\r\r/);
        if (!delimiter || delimiter.index === undefined) break;
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        for (const line of frame.split(/\r\n|\n|\r/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const root = asRecord(parsed);
          if (root?.error !== undefined && root?.error !== null) {
            await reader.cancel().catch(() => undefined);
            throw new ProviderError('server', `${provider} reported a stream error.`, {
              retryable: true,
            });
          }
          const firstChoice = Array.isArray(root?.choices) ? asRecord(root.choices[0]) : null;
          if (firstChoice?.finish_reason === 'error') {
            await reader.cancel().catch(() => undefined);
            throw new ProviderError('server', `${provider} reported a stream error.`, {
              retryable: true,
            });
          }
          for (const event of normalizeChunk(parsed, calls)) {
            // Some servers send usage twice (a chunk and a final total); retain
            // only the last total and emit it once at the end.
            if (event.type === 'usage') {
              usage = event.usage;
              continue;
            }
            if (event.type === 'done') {
              finishReason = event.finishReason;
              continue;
            }
            yield event;
          }
          const oversized = [...calls.values()].some(
            (call) => call.arguments.length > MAX_TOOL_ARGUMENT_BYTES || call.name.length > 4_096,
          );
          if (oversized) {
            await reader.cancel().catch(() => undefined);
            throw new ProviderError(
              'invalid',
              `${provider} accumulated a tool call larger than the safety limit.`,
              { retryable: false },
            );
          }
        }
      }
    }
  } catch (error) {
    throw toProviderError(provider, error, signal);
  } finally {
    reader.releaseLock();
  }

  // Some compatible servers close the stream without a [DONE] frame; the
  // accumulated content and tool calls are still complete, so it is not an error.
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    const parsed = parseArguments(call.arguments);
    yield {
      type: 'tool',
      call: {
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: parsed,
        ...(parsed === call.arguments ? { rawArguments: call.arguments } : {}),
      },
    };
  }
  if (usage) yield { type: 'usage', usage };
  yield { type: 'done', ...(finishReason === undefined ? {} : { finishReason }) };
}

function normalizeChunk(
  parsed: unknown,
  calls: Map<number, { id: string; name: string; arguments: string }>,
): ProviderStreamEvent[] {
  const root = asRecord(parsed);
  const usageRecord = asRecord(root?.usage);
  const events: ProviderStreamEvent[] = [];
  if (usageRecord) {
    const inputTokens = numberOrUndefined(usageRecord.prompt_tokens);
    const outputTokens = numberOrUndefined(usageRecord.completion_tokens);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      events.push({
        type: 'usage',
        usage: {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        },
      });
    }
  }
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return events;
  const choice = asRecord(choices[0]);
  const delta = asRecord(choice?.delta);
  const text = delta?.content;
  if (typeof text === 'string' && text.length > 0) events.push({ type: 'text', text });
  const reasoning =
    typeof delta?.reasoning === 'string'
      ? delta.reasoning
      : typeof delta?.reasoning_content === 'string'
        ? delta.reasoning_content
        : undefined;
  if (reasoning) events.push({ type: 'reasoning', text: reasoning });

  const toolCalls = delta?.tool_calls;
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach((entry, fallbackIndex) => {
      const record = asRecord(entry);
      const index = numberOrUndefined(record?.index) ?? fallbackIndex;
      const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
      const fn = asRecord(record?.function);
      if (typeof record?.id === 'string' && record.id.length > 0) current.id = record.id;
      if (typeof fn?.name === 'string' && fn.name.length > 0) current.name += fn.name;
      if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
      calls.set(index, current);
    });
  }
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
    events.push({ type: 'done', finishReason: choice.finish_reason });
  }
  return events;
}
