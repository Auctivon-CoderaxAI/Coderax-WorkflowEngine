import type {
  DiscoveredModel,
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
 * Google Gemini's native generateContent API.
 *
 * Gemini's model list has no price at all. This adapter therefore publishes
 * `pricing: null` and the router refuses every Gemini model unless the operator
 * supplies an unexpired attestation with an evidence URL. A configured
 * GEMINI_API_KEY never makes a model free by itself.
 */
export function createGeminiProvider(input: {
  id: string;
  baseURL: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ProviderAdapter {
  assertSecureBaseURL(input.baseURL);
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseURL.replace(/\/+$/, '');
  const headers = { 'x-goog-api-key': input.apiKey, accept: 'application/json' };

  return {
    id: input.id,
    kind: 'gemini',
    discover: async (signal) => {
      const models: DiscoveredModel[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const url = new URL(`${base}/models`);
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        let response: Response;
        try {
          response = await fetchImpl(url.toString(), {
            method: 'GET',
            headers,
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
        const record = asRecord(body);
        const list = record?.models;
        if (!Array.isArray(list)) {
          throw new ProviderError('invalid', `${input.id} returned an unexpected model list.`, {
            retryable: false,
          });
        }
        for (const entry of list) {
          const model = asRecord(entry);
          if (!model || typeof model.name !== 'string') continue;
          const methods = Array.isArray(model.supportedGenerationMethods)
            ? model.supportedGenerationMethods.filter(
                (value): value is string => typeof value === 'string',
              )
            : [];
          if (!methods.includes('generateContent')) continue;
          const modelId = model.name.replace(/^models\//, '');
          if (modelId.length === 0) continue;
          models.push({
            ref: { providerId: input.id, modelId },
            label:
              typeof model.displayName === 'string' && model.displayName.length > 0
                ? model.displayName.slice(0, 160)
                : modelId.slice(0, 160),
            ...(positive(model.inputTokenLimit) === undefined
              ? {}
              : { contextTokens: positive(model.inputTokenLimit) }),
            ...(positive(model.outputTokenLimit) === undefined
              ? {}
              : { maxOutputTokens: positive(model.outputTokenLimit) }),
            capabilities: {
              vision: supportsVision(modelId),
              // generateContent is Gemini's function-calling surface.
              toolCalling: true,
              reasoning: modelId.toLowerCase().includes('thinking'),
              streaming: true,
            },
            pricing: null,
          });
        }
        pageToken =
          typeof record?.nextPageToken === 'string' && record.nextPageToken.length > 0
            ? record.nextPageToken
            : undefined;
        if (!pageToken) break;
      }
      return models;
    },
    complete: async (request) => {
      const response = await call(fetchImpl, base, headers, input.id, request, false);
      const body = await response.json().catch(() => {
        throw new ProviderError('invalid', `${input.id} returned an unreadable response.`, {
          retryable: false,
        });
      });
      return parseCompletion(input.id, body);
    },
    stream: async function* (request): AsyncGenerator<ProviderStreamEvent> {
      const response = await call(fetchImpl, base, headers, input.id, request, true);
      yield* parseStream(input.id, response, request.signal);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * The Gemini discovery document does not expose input modalities. These families
 * are multimodal on the generateContent surface; older text-only Gemini endpoints
 * are deliberately excluded. This is a capability declaration, not a price claim.
 */
function supportsVision(modelId: string): boolean {
  if (/embedding|aqa|imagen|veo/i.test(modelId)) return false;
  if (/vision/i.test(modelId)) return true;
  if (/^gemini-1\.0-pro/i.test(modelId) || /^gemini-pro$/i.test(modelId)) return false;
  return /^gemini-(1\.5|2|2\.5|3|exp)/i.test(modelId);
}

async function call(
  fetchImpl: typeof fetch,
  base: string,
  headers: Record<string, string>,
  provider: string,
  request: ProviderCompletionRequest,
  stream: boolean,
): Promise<Response> {
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const endpoint = `${base}/models/${encodeURIComponent(request.model.modelId)}:${action}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      // A redirect must never forward the API key or prompt to another origin.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        ...headers,
      },
      body: JSON.stringify(toBody(request)),
      signal: request.signal,
    });
    if (!response.ok) throw await providerErrorFromResponse({ response, provider });
    return response;
  } catch (error) {
    throw toProviderError(provider, error, request.signal);
  }
}

function toBody(request: ProviderCompletionRequest): unknown {
  const contents =
    request.messages && request.messages.length > 0
      ? request.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [
              ...(message.text.length > 0 ? [{ text: message.text }] : []),
              ...(message.images ?? []).map(imagePart),
            ],
          }))
      : [{ role: 'user', parts: [{ text: request.prompt }] }];
  return {
    ...(request.system.length > 0
      ? { systemInstruction: { parts: [{ text: request.system }] } }
      : {}),
    contents,
    generationConfig: {
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(request.tools && request.tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: geminiSchema(tool.parameters),
              })),
            },
          ],
        }
      : {}),
  };
}

function imagePart(url: string): Record<string, unknown> {
  const data = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data) {
    return { inlineData: { mimeType: data[1], data: data[2] } };
  }
  // Gemini accepts a data URL only as inline base64 data. A remote image stays
  // a file reference that Gemini can fetch.
  return { fileData: { fileUri: url, mimeType: mimeTypeOf(url) } };
}

function mimeTypeOf(url: string): string {
  const match = url.match(/^data:([^;,]+)[;,]/);
  if (match) return match[1];
  if (/\.png($|\?)/i.test(url)) return 'image/png';
  if (/\.webp($|\?)/i.test(url)) return 'image/webp';
  return 'image/jpeg';
}

/** Gemini reports thinking separately from visible candidate tokens. */
function generationOutputTokens(metadata: Record<string, unknown> | null | undefined): number | undefined {
  const candidates = positive(metadata?.candidatesTokenCount);
  const thoughts = positive(metadata?.thoughtsTokenCount);
  if (candidates === undefined && thoughts === undefined) return undefined;
  return (candidates ?? 0) + (thoughts ?? 0);
}

/** Gemini rejects some JSON Schema keywords; keep the portable subset. */
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete clone.$schema;
  delete clone.additionalProperties;
  return clone;
}

export function parseCompletion(provider: string, body: unknown): {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
} {
  const root = asRecord(body);
  const feedback = asRecord(root?.promptFeedback);
  if (typeof feedback?.blockReason === 'string') {
    throw new ProviderError('invalid', `${provider} blocked the prompt.`, { retryable: false });
  }
  const candidates = root?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ProviderError('invalid', `${provider} returned no completion candidate.`, {
      retryable: false,
    });
  }
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  parts.forEach((entry, index) => {
    const part = asRecord(entry);
    if (typeof part?.text === 'string') text += part.text;
    const call = asRecord(part?.functionCall);
    if (typeof call?.name === 'string' && call.name.length > 0) {
      toolCalls.push({
        id: `gemini_call_${index}_${call.name}`.slice(0, 120),
        name: call.name,
        arguments: call.args ?? {},
      });
    }
  });
  if (text.length === 0 && toolCalls.length === 0) {
    throw new ProviderError('invalid', `${provider} returned neither text nor a tool call.`, {
      retryable: false,
    });
  }
  const metadata = asRecord(root?.usageMetadata);
  const inputTokens = positive(metadata?.promptTokenCount);
  const outputTokens = generationOutputTokens(metadata);
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
    ...(typeof candidate?.finishReason === 'string'
      ? { finishReason: candidate.finishReason }
      : {}),
  };
}

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
  let toolCallCount = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        // LF, CRLF and lone CR are all valid SSE line endings.
        const delimiter = buffer.match(/\r\n\r\n|\n\n|\r\r/);
        if (!delimiter || delimiter.index === undefined) break;
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        if (Buffer.byteLength(frame, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderError(
            'invalid',
            `${provider} sent an SSE frame larger than the safety limit.`,
            { retryable: false },
          );
        }
        for (const line of frame.split(/\r\n|\n|\r/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === '[DONE]') continue;
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
          const feedback = asRecord(root?.promptFeedback);
          if (typeof feedback?.blockReason === 'string') {
            await reader.cancel().catch(() => undefined);
            throw new ProviderError('invalid', `${provider} blocked the prompt.`, {
              retryable: false,
            });
          }
          const metadata = asRecord(root?.usageMetadata);
          const inputTokens = positive(metadata?.promptTokenCount);
          const outputTokens = generationOutputTokens(metadata);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            usage = {
              ...(inputTokens === undefined
                ? usage?.inputTokens === undefined
                  ? {}
                  : { inputTokens: usage.inputTokens }
                : { inputTokens }),
              ...(outputTokens === undefined
                ? usage?.outputTokens === undefined
                  ? {}
                  : { outputTokens: usage.outputTokens }
                : { outputTokens }),
            };
          }
          const candidates = root?.candidates;
          if (!Array.isArray(candidates) || candidates.length === 0) continue;
          const candidate = asRecord(candidates[0]);
          const content = asRecord(candidate?.content);
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (const entry of parts) {
            const part = asRecord(entry);
            if (typeof part?.text === 'string' && part.text.length > 0) {
              yield { type: 'text', text: part.text };
            }
            const call = asRecord(part?.functionCall);
            if (typeof call?.name === 'string' && call.name.length > 0) {
              const args = call.args ?? {};
              if (JSON.stringify(args).length > MAX_TOOL_ARGUMENT_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new ProviderError(
                  'invalid',
                  `${provider} returned a tool call larger than the safety limit.`,
                  { retryable: false },
                );
              }
              const toolCall: ToolCall = {
                id: `gemini_call_${toolCallCount}_${call.name}`.slice(0, 120),
                name: call.name,
                arguments: args,
              };
              toolCallCount += 1;
              yield { type: 'tool', call: toolCall };
            }
          }
          if (typeof candidate?.finishReason === 'string') {
            finishReason = candidate.finishReason;
          }
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(
          'invalid',
          `${provider} sent an SSE frame larger than the safety limit.`,
          { retryable: false },
        );
      }
    }
  } catch (error) {
    throw toProviderError(provider, error, signal);
  } finally {
    reader.releaseLock();
  }

  if (usage) yield { type: 'usage', usage };
  yield { type: 'done', ...(finishReason === undefined ? {} : { finishReason }) };
}
