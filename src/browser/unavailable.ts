import type {
  BrowserCapabilityReason,
  BrowserLimits,
} from '@coderax/contracts';
import type {
  BrowserProvider,
  ProviderFailure,
  ProviderResult,
} from './types.js';
import { unavailableCapabilities } from './capabilities.js';

/**
 * The fail-closed browser provider.
 *
 * It exists so the integration can be complete without a verified endpoint:
 * every operation is refused with a stable, honest reason, and the capability
 * report contains no fabricated features, screenshots or sessions. This is the
 * default in every deployment that has not proven a zero-cost provider.
 */

function refusal(reason: BrowserCapabilityReason, detail: string): ProviderFailure {
  const code =
    reason === 'disabled' || reason === 'not_configured' || reason === 'unverified' || reason === 'missing_features'
      ? 'not_configured'
      : reason === 'protocol_error'
        ? 'protocol_error'
        : 'unavailable';
  return { ok: false, code, detail };
}

export function createUnavailableBrowserProvider(input: {
  provider?: string;
  reason: BrowserCapabilityReason;
  detail: string;
  limits: BrowserLimits;
}): BrowserProvider {
  const provider = input.provider ?? 'none';
  const fail = (): Promise<ProviderResult<never>> =>
    Promise.resolve(refusal(input.reason, input.detail));

  return {
    kind: provider,
    describe: async () =>
      unavailableCapabilities({
        provider,
        reason: input.reason,
        detail: input.detail,
        limits: input.limits,
      }),
    create: () => fail(),
    act: () => fail(),
    pause: () => fail(),
    resume: () => fail(),
    takeover: () => fail(),
    release: () => fail(),
    close: () => fail(),
  };
}
