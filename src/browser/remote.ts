import type { z } from 'zod';
import {
  allFeaturesPresent,
  unavailableCapabilities,
} from './capabilities.js';
import type {
  BrowserProvider,
  ProviderActInput,
  ProviderActionOutcome,
  ProviderCreateInput,
  ProviderFailure,
  ProviderResult,
  ProviderSession,
} from './types.js';
import {
  ProviderActionResponse,
  ProviderCapabilitiesResponse,
  ProviderOkResponse,
  ProviderSessionResponse,
  ProviderTakeoverResponse,
} from './protocol.js';
import type {
  BrowserAction,
  BrowserActionType,
  BrowserCapabilities,
  BrowserFeatures,
  BrowserLimits,
  BROWSER_PROTOCOL_VERSION,
} from '@coderax/contracts';

/**
 * The HTTP adapter for a browser provider that implements protocol v1.
 *
 * It is wired only when the owner attests that the endpoint is authorized,
 * cloud-hosted and zero-cost. Even then it reports operational only after a
 * successful handshake that advertises every required feature and a free cost
 * class. A paid, partial, unreachable or malformed provider is refused, never
 * downgraded to a local browser or a fabricated result.
 */

const CACHE_FRESH_MS = 15_000;
const MAX_PROVIDER_RESPONSE = 16_000_000;
const REQUIRED_PROTOCOL_VERSION: typeof BROWSER_PROTOCOL_VERSION = 1;

const FEATURE_FOR_ACTION: Readonly<Record<BrowserActionType, keyof BrowserFeatures>> =
  Object.freeze({
    navigate: 'navigation',
    inspect: 'inspection',
    screenshot: 'screenshots',
    find: 'accessibleElements',
    click: 'forms',
    fill: 'forms',
    press: 'keyboard',
    mouse: 'mouse',
    tab: 'tabs',
    upload: 'uploads',
    download: 'downloads',
  });

function strippedAction(action: BrowserAction): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(action)) as Record<string, unknown>;
  // The provider performs an action; it never receives or evaluates consent.
  delete copy.approvalId;
  delete copy.intent;
  return copy;
}

export function createHttpBrowserProvider(input: {
  baseURL: string;
  token: string;
  timeoutMs: number;
  limits: BrowserLimits;
  trusted: boolean;
  provider?: string;
  fetchImpl?: typeof fetch;
}): BrowserProvider {
  const providerName = input.provider ?? 'http-contract';
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseURL.replace(/\/+$/, '');
  const baseOrigin = new URL(base).origin;
  let cached: { at: number; value: BrowserCapabilities } | null = null;

  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    let url: URL;
    try {
      url = new URL(`${base}${path}`);
    } catch {
      return { ok: false, code: 'protocol_error', detail: 'The provider URL could not be composed.' };
    }
    if (url.origin !== baseOrigin) {
      return {
        ok: false,
        code: 'protocol_error',
        detail: 'The provider path resolved outside the configured endpoint.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    timer.unref();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect could carry the authorization header to another origin.
        redirect: 'error',
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            code: 'forbidden',
            detail: 'The browser provider rejected the configured credentials.',
          };
        }
        if (response.status === 429 || response.status >= 500) {
          return {
            ok: false,
            code: 'unavailable',
            detail: `The browser provider is unavailable (HTTP ${response.status}).`,
          };
        }
        return {
          ok: false,
          code: 'protocol_error',
          detail: `The browser provider rejected the request (HTTP ${response.status}).`,
        };
      }

      const length = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE) {
        controller.abort();
        return {
          ok: false,
          code: 'protocol_error',
          detail: 'The browser provider response exceeded the protocol limit.',
        };
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_PROVIDER_RESPONSE) {
              controller.abort();
              void reader.cancel().catch(() => {});
              return { ok: false, code: 'protocol_error', detail: 'The browser provider response exceeded the protocol limit.' };
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ok: false,
          code: 'protocol_error',
          detail: 'The browser provider response was not valid JSON.',
        };
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'protocol_error',
          detail: 'The browser provider response did not match protocol v1.',
        };
      }
      return { ok: true, value: parsed.data };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return {
          ok: false,
          code: 'timeout',
          detail: 'The browser provider did not answer before the timeout.',
        };
      }
      return {
        ok: false,
        code: 'unavailable',
        detail: 'The browser provider could not be reached.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handshake(): Promise<ProviderResult<BrowserCapabilities>> {
    const response = await request(
      '/v1/capabilities',
      'GET',
      undefined,
      ProviderCapabilitiesResponse,
    );
    if (!response.ok) return response;
    if (response.value.protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
      return {
        ok: false,
        code: 'protocol_error',
        detail: 'The browser provider speaks a different protocol version.',
      };
    }

    const reported = response.value;
    const limits: BrowserLimits = {
      ...input.limits,
      maxSessionTtlSeconds: Math.min(
        input.limits.maxSessionTtlSeconds,
        reported.limits.maxSessionTtlSeconds,
      ),
    };

    if (reported.costClass !== 'free') {
      return {
        ok: true,
        value: unavailableCapabilities({
          provider: reported.provider,
          reason: 'paid_refused',
          detail:
            'The browser provider reports a paid cost class; the zero-cost charter refuses it.',
          limits,
          costClass: 'paid',
          features: reported.features,
        }),
      };
    }
    if (!allFeaturesPresent(reported.features)) {
      return {
        ok: true,
        value: unavailableCapabilities({
          provider: reported.provider,
          reason: 'missing_features',
          detail:
            'The browser provider does not implement every feature the integration contract requires.',
          limits,
          costClass: 'free',
          features: reported.features,
        }),
      };
    }

    return {
      ok: true,
      value: {
        provider: reported.provider,
        operational: true,
        reason: 'ready',
        detail:
          'The browser provider answered the versioned handshake with every required feature and a free cost class.',
        scope: 'browser',
        costClass: 'free',
        features: reported.features,
        limits,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async function describe(): Promise<BrowserCapabilities> {
    if (!input.trusted) {
      return unavailableCapabilities({
        provider: providerName,
        reason: 'unverified',
        detail:
          'The browser provider endpoint is not owner-attested as authorized and zero-cost.',
        limits: input.limits,
      });
    }
    const now = Date.now();
    if (cached && now - cached.at < CACHE_FRESH_MS) return cached.value;

    const handshakeResult = await handshake();
    const value = handshakeResult.ok
      ? handshakeResult.value
      : unavailableCapabilities({
          provider: providerName,
          reason:
            handshakeResult.code === 'protocol_error'
              ? 'protocol_error'
              : handshakeResult.code === 'forbidden'
                ? 'unverified'
                : 'unreachable',
          detail: handshakeResult.detail,
          limits: input.limits,
        });
    cached = { at: now, value };
    return value;
  }

  async function ensure(): Promise<ProviderResult<BrowserCapabilities>> {
    const capabilities = await describe();
    if (!capabilities.operational) {
      return {
        ok: false,
        code:
          capabilities.reason === 'protocol_error'
            ? 'protocol_error'
            : capabilities.reason === 'unreachable'
              ? 'unavailable'
              : 'not_configured',
        detail: capabilities.detail,
      };
    }
    return { ok: true, value: capabilities };
  }

  function requireFeature(
    capabilities: BrowserCapabilities,
    feature: keyof BrowserFeatures,
  ): ProviderFailure | null {
    if (capabilities.features[feature]) return null;
    return {
      ok: false,
      code: 'unsupported',
      detail: `The browser provider does not support ${feature}.`,
    };
  }

  async function okOnly(
    path: string,
    feature: keyof BrowserFeatures,
  ): Promise<ProviderResult<void>> {
    const gate = await ensure();
    if (!gate.ok) return gate;
    const missing = requireFeature(gate.value, feature);
    if (missing) return missing;
    return acknowledge(path);
  }

  async function acknowledge(path: string): Promise<ProviderResult<void>> {
    const result = await request(path, 'POST', {}, ProviderOkResponse);
    if (!result.ok) return result;
    return { ok: true, value: undefined };
  }

  return {
    kind: providerName,
    describe,

    create: async (requestInput: ProviderCreateInput) => {
      const gate = await ensure();
      if (!gate.ok) return gate;
      const missing = requireFeature(gate.value, 'sessions');
      if (missing) return missing;
      const result = await request(
        '/v1/sessions',
        'POST',
        {
          // Never ask for a longer session than the verified capability allows.
          ttlSeconds: Math.min(
            requestInput.ttlSeconds,
            gate.value.limits.maxSessionTtlSeconds,
          ),
          allowedOrigins: requestInput.allowedOrigins,
          label: requestInput.label,
          purpose: requestInput.purpose,
          ...(requestInput.viewport ? { viewport: requestInput.viewport } : {}),
        },
        ProviderSessionResponse,
      );
      if (!result.ok) return result;
      const session: ProviderSession = {
        providerSessionId: result.value.providerSessionId,
        url: result.value.url,
        title: result.value.title,
        tabs: result.value.tabs,
      };
      return { ok: true, value: session };
    },

    act: async (requestInput: ProviderActInput) => {
      const gate = await ensure();
      if (!gate.ok) return gate;
      const missing = requireFeature(
        gate.value,
        FEATURE_FOR_ACTION[requestInput.action.type],
      );
      if (missing) return missing;
      const result = await request(
        `/v1/sessions/${encodeURIComponent(requestInput.providerSessionId)}/actions`,
        'POST',
        {
          action: strippedAction(requestInput.action),
          allowedOrigins: requestInput.allowedOrigins,
        },
        ProviderActionResponse,
      );
      if (!result.ok) return result;
      const observation = result.value.observation;
      const artifacts = (result.value.artifacts ?? []).map((artifact) => ({
        kind: artifact.kind,
        contentType: artifact.contentType,
        data: Buffer.from(artifact.dataBase64, 'base64'),
      }));
      const outcome: ProviderActionOutcome = {
        url: result.value.url,
        title: result.value.title,
        ...(result.value.tabs ? { tabs: result.value.tabs } : {}),
        ...(observation
          ? {
              observation: {
                ...(observation.text !== undefined ? { text: observation.text } : {}),
                ...(observation.elements !== undefined ? { elements: observation.elements } : {}),
                ...(observation.truncated !== undefined ? { truncated: observation.truncated } : {}),
              },
            }
          : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
      return { ok: true, value: outcome };
    },

    pause: (providerSessionId) =>
      okOnly(`/v1/sessions/${encodeURIComponent(providerSessionId)}/pause`, 'pauseResume'),

    resume: (providerSessionId) =>
      okOnly(`/v1/sessions/${encodeURIComponent(providerSessionId)}/resume`, 'pauseResume'),

    takeover: async (providerSessionId) => {
      const gate = await ensure();
      if (!gate.ok) return gate;
      const missing = requireFeature(gate.value, 'takeover');
      if (missing) return missing;
      const result = await request(
        `/v1/sessions/${encodeURIComponent(providerSessionId)}/takeover`,
        'POST',
        {},
        ProviderTakeoverResponse,
      );
      if (!result.ok) return result;
      return { ok: true, value: { interactiveUrl: result.value.interactiveUrl } };
    },

    release: (providerSessionId) =>
      okOnly(`/v1/sessions/${encodeURIComponent(providerSessionId)}/release`, 'takeover'),

    close: async (providerSessionId) => {
      if (!input.trusted) {
        return { ok: false, code: 'not_configured', detail: 'The browser endpoint is not owner-attested.' };
      }
      return acknowledge(`/v1/sessions/${encodeURIComponent(providerSessionId)}/close`);
    },
  };
}
