import type { BrowserProvider } from '../browser/types.js';
import { createHttpBrowserProvider } from '../browser/remote.js';
import { createUnavailableBrowserProvider } from '../browser/unavailable.js';
import { browserLimits, type EngineConfig } from '../configuration/schema.js';

/**
 * Browser provider selection.
 *
 * There is no implicit provider and no fallback to a local browser. The only
 * wired implementation is the versioned HTTP protocol; it is constructed only
 * when the owner enabled it, attested that it is authorized and zero-cost, and
 * named the variable that holds its token. Every other state constructs the
 * fail-closed provider with the precise reason it cannot run.
 */
export function buildBrowserProvider(input: {
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): BrowserProvider {
  const settings = input.config.browsers;
  const limits = browserLimits(settings);

  if (!settings.enabled) {
    return createUnavailableBrowserProvider({
      reason: 'disabled',
      detail: 'Cloud browser integration is disabled in this deployment.',
      limits,
    });
  }
  if (settings.provider === 'none') {
    return createUnavailableBrowserProvider({
      reason: 'not_configured',
      detail:
        'No verified zero-cost cloud browser provider is configured; browser sessions are refused.',
      limits,
    });
  }

  const baseURL = settings.remote.baseURL;
  if (!baseURL) {
    return createUnavailableBrowserProvider({
      provider: 'http-contract',
      reason: 'not_configured',
      detail: 'browsers.remote.baseURL is not configured.',
      limits,
    });
  }
  if (!settings.remote.zeroCostAttested) {
    return createUnavailableBrowserProvider({
      provider: 'http-contract',
      reason: 'unverified',
      detail:
        'The browser provider is not owner-attested as authorized and zero-cost; it is refused.',
      limits,
    });
  }
  const token = input.env[settings.remote.tokenEnv]?.trim();
  if (!token) {
    return createUnavailableBrowserProvider({
      provider: 'http-contract',
      reason: 'not_configured',
      detail: `The browser provider token variable ${settings.remote.tokenEnv} is not set.`,
      limits,
    });
  }

  return createHttpBrowserProvider({
    baseURL,
    token,
    timeoutMs: settings.remote.timeoutMs,
    limits,
    trusted: true,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}
