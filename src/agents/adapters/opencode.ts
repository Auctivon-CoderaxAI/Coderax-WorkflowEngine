import { credentialEndpoint } from '../../security/endpoint.js';
import type { AgentReport, AgentRunOutcome, AgentRunRequest } from '../types.js';
import type { ExternalAgentTransport } from './external.js';

/**
 * The OpenCode agent over its HTTP server API.
 *
 * This transport is a client of an already-running OpenCode server; the engine
 * never spawns, bundles or installs one, and Coderax Native never depends on it.
 * Readiness is a real request, a run creates a session and streams the assistant
 * message, and cancellation aborts the request and best-effort deletes the
 * session. Server text is bounded and never trusted as an instruction.
 */

type FetchLike = typeof fetch;

function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function textFromParts(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (typeof part !== 'object' || part === null) return '';
      const typed = part as { type?: unknown; text?: unknown };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter((part) => part.length > 0)
    .join('');
}

export function createOpenCodeHttpTransport(input: {
  baseURL: string;
  /** Read by the caller from the environment; never logged or put in a URL. */
  password?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): ExternalAgentTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { password } = input;
  const base = trimBase(password ? credentialEndpoint(input.baseURL).href : input.baseURL);
  const timeoutMs = input.timeoutMs ?? 120_000;

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(password ? { authorization: basicAuth(password) } : {}),
      ...(extra ?? {}),
    };
  }

  async function request(pathname: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`${base}${pathname}`, {
        ...init,
        headers: headers(init?.headers as Record<string, string> | undefined),
        signal: controller.signal,
        redirect: 'manual',
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(): Promise<void> {
    const response = await request('/app');
    if (!response.ok) throw new Error('OpenCode did not answer its readiness probe.');
  }

  return {
    probe,
    run: async (run: AgentRunRequest, report: AgentReport): Promise<AgentRunOutcome> => {
      let sessionId: string | null = null;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      run.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();

      const cleanup = async (): Promise<void> => {
        if (!sessionId) return;
        await fetchImpl(`${base}/session/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: headers(),
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined);
      };

      try {
        const created = await fetchImpl(`${base}/session`, {
          method: 'POST',
          headers: headers(),
          redirect: 'error',
          body: JSON.stringify({ title: 'Coderax task' }),
          signal: controller.signal,
        });
        if (!created.ok) {
          return {
            ok: false,
            code: 'server_unavailable',
            detail: `OpenCode refused to create a session (HTTP ${created.status}).`,
            retryable: created.status >= 500,
          };
        }
        const session = (await created.json()) as { id?: unknown };
        if (typeof session.id !== 'string') {
          return {
            ok: false,
            code: 'protocol_error',
            detail: 'OpenCode did not return a session id.',
            retryable: false,
          };
        }
        sessionId = session.id;
        report({ type: 'step.started', stepId: 'opencode-1', title: 'Execute with OpenCode' });

        // The router already resolved and admitted this model. The adapter must
        // not substitute a configured preference after admission.
        const model = run.model;
        const prompt = [
          `Objective:\n${run.objective}`,
          '',
          'Execute the objective and return the concrete result. Do not ask a question unless you are blocked.',
        ].join('\n');

        const response = await fetchImpl(`${base}/session/${encodeURIComponent(sessionId)}/message`, {
          method: 'POST',
          headers: headers(),
          redirect: 'error',
          body: JSON.stringify({
            model: { providerID: model.providerId, modelID: model.modelId },
            parts: [{ type: 'text', text: prompt }],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          return {
            ok: false,
            code: 'provider_error',
            detail: `OpenCode run failed (HTTP ${response.status}).`,
            retryable: response.status === 429 || response.status >= 500,
          };
        }

        const type = response.headers.get('content-type') ?? '';
        let text = '';
        if (type.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
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
                  const event = JSON.parse(payload) as {
                    type?: unknown;
                    properties?: { part?: unknown; delta?: unknown };
                  };
                  const part = event.properties?.part;
                  const partText = textFromParts({ parts: [part] });
                  const delta = event.properties?.delta;
                  if (typeof delta === 'string' && delta.length > 0) {
                    text += delta;
                    report({ type: 'text.delta', text: delta });
                  } else if (partText.length > 0 && !text.endsWith(partText)) {
                    text += partText;
                    report({ type: 'text.delta', text: partText });
                  }
                } catch {
                  // Ignore a non-JSON keepalive frame.
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } else {
          const body = (await response.json()) as unknown;
          text = textFromParts(body) || textFromParts((body as { message?: unknown }).message);
          if (text.length > 0) report({ type: 'text.delta', text });
        }

        report({ type: 'step.completed', stepId: 'opencode-1', title: 'Execute with OpenCode' });
        if (text.trim().length === 0) {
          return {
            ok: false,
            code: 'protocol_error',
            detail: 'OpenCode completed without returning assistant text.',
            retryable: false,
          };
        }
        return { ok: true, summary: text.trim() };
      } catch {
        if (run.signal.aborted) {
          return { ok: false, code: 'cancelled', detail: 'The run was cancelled.', retryable: false };
        }
        return {
          ok: false,
          code: 'server_unavailable',
          detail: 'The OpenCode transport failed.',
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
        run.signal.removeEventListener('abort', onAbort);
        await cleanup();
      }
    },
  };
}
