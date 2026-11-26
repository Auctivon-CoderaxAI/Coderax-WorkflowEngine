import { ProviderError, type RateLimitFacts } from '../types.js';

/**
 * Shared HTTP failure normalization. Provider bodies are untrusted: they are
 * inspected only for stable error markers and are never returned to a client or
 * written to a log. The message a caller receives names the provider status, not
 * the payload.
 */

export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function parseRateLimit(headers: Headers): RateLimitFacts {
  const number = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const duration = (name: string): number | undefined => {
    const raw = headers.get(name)?.trim();
    if (!raw) return undefined;
    const milliseconds = raw.match(/^(\d+(?:\.\d+)?)ms$/i);
    if (milliseconds) return Math.ceil(Number(milliseconds[1]));
    // Groq and OpenAI publish composite windows such as `2m59.56s`.
    const match = raw.match(
      /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i,
    );
    if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    return Math.ceil((hours * 3_600 + minutes * 60 + seconds) * 1_000);
  };
  return {
    remainingRequests: number('x-ratelimit-remaining-requests'),
    remainingTokens: number('x-ratelimit-remaining-tokens'),
    resetRequestsMs: duration('x-ratelimit-reset-requests'),
    resetTokensMs: duration('x-ratelimit-reset-tokens'),
    retryAfterMs: parseRetryAfter(headers),
  };
}

export type ErrorHints = {
  code?: string;
  type?: string;
  status?: string;
  message?: string;
  retryDelayMs?: number;
};

export function parseErrorBody(text: string): ErrorHints {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const root = parsed as Record<string, unknown>;
    const error =
      root.error !== null && typeof root.error === 'object'
        ? (root.error as Record<string, unknown>)
        : root;
    const string = (value: unknown): string | undefined =>
      typeof value === 'string' ? value.slice(0, 500) : undefined;
    const details = Array.isArray(error.details) ? error.details : [];
    let retryDelayMs: number | undefined;
    for (const detail of details) {
      if (detail === null || typeof detail !== 'object') continue;
      const record = detail as Record<string, unknown>;
      if (typeof record.retryDelay === 'string') {
        const match = record.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (match) retryDelayMs = Math.ceil(Number(match[1]) * 1000);
      }
    }
    return {
      code: string(error.code),
      type: string(error.type),
      status: string(error.status),
      message: string(error.message),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    };
  } catch {
    return {};
  }
}

function quotaSignal(hints: ErrorHints, status: number): boolean {
  if (status === 402) return true;
  const haystack = `${hints.code ?? ''} ${hints.type ?? ''} ${hints.status ?? ''} ${hints.message ?? ''}`.toLowerCase();
  return (
    haystack.includes('insufficient_quota') ||
    haystack.includes('resource_exhausted') ||
    haystack.includes('per day') ||
    haystack.includes('perday') ||
    haystack.includes('daily limit') ||
    haystack.includes('quota exceeded') ||
    haystack.includes('billing')
  );
}

export async function providerErrorFromResponse(input: {
  response: Response;
  provider: string;
}): Promise<ProviderError> {
  const status = input.response.status;
  const text = await input.response.text().catch(() => '');
  const hints = parseErrorBody(text.slice(0, 8_000));
  const rateLimit = parseRateLimit(input.response.headers);
  const retryAfterMs = rateLimit.retryAfterMs ?? hints.retryDelayMs;
  const exhausted =
    quotaSignal(hints, status) ||
    (status === 429 &&
      rateLimit.remainingRequests === 0 &&
      (rateLimit.resetRequestsMs ?? 0) > 60_000);

  if (exhausted) {
    return new ProviderError('quota', `${input.provider} reports its free allowance is exhausted.`, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      quotaExhausted: true,
      retryable: true,
      rateLimit,
    });
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `${input.provider} rate-limited the request.`, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      retryable: true,
      rateLimit,
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${input.provider} rejected the configured credential.`, {
      status,
      retryable: false,
      rateLimit,
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('timeout', `${input.provider} timed out.`, {
      status,
      retryable: true,
      rateLimit,
    });
  }
  if (status === 413 || (status === 400 && /context|token/i.test(`${hints.code} ${hints.message}`))) {
    return new ProviderError('context', `${input.provider} rejected the request size.`, {
      status,
      retryable: true,
      rateLimit,
    });
  }
  if (status >= 500) {
    return new ProviderError('server', `${input.provider} is unavailable (HTTP ${status}).`, {
      status,
      retryable: true,
      rateLimit,
    });
  }
  return new ProviderError(
    'invalid',
    `${input.provider} rejected the request (HTTP ${status}).`,
    { status, retryable: false, rateLimit },
  );
}

export function abortedError(provider: string, signal: AbortSignal): ProviderError {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
    return new ProviderError('timeout', `${provider} did not respond in time.`, {
      retryable: true,
    });
  }
  return new ProviderError('cancelled', 'The run was cancelled.', { retryable: false });
}

export function toProviderError(provider: string, error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal.aborted) return abortedError(provider, signal);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ProviderError('timeout', `${provider} did not respond in time.`, {
      retryable: true,
    });
  }
  return new ProviderError('network', `${provider} could not be reached.`, {
    retryable: true,
  });
}

export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
