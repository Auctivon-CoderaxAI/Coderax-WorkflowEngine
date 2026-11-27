import type {
  BrowserCapabilities,
  BrowserCapabilityReason,
  BrowserFeatures,
  BrowserLimits,
} from '@coderax/contracts';

/**
 * Capability reporting is the integration's honesty boundary.
 *
 * Nothing may report a browser feature as available because it is configured,
 * funded or planned. A provider is operational only when it answered the
 * versioned handshake with every required feature and a free cost class.
 */

export const REQUIRED_FEATURES = [
  'sessions',
  'navigation',
  'inspection',
  'screenshots',
  'accessibleElements',
  'forms',
  'keyboard',
  'mouse',
  'tabs',
  'uploads',
  'downloads',
  'sessionPersistence',
  'pauseResume',
  'takeover',
] as const satisfies readonly (keyof BrowserFeatures)[];

export function emptyFeatures(): BrowserFeatures {
  return {
    sessions: false,
    navigation: false,
    inspection: false,
    screenshots: false,
    accessibleElements: false,
    forms: false,
    keyboard: false,
    mouse: false,
    tabs: false,
    uploads: false,
    downloads: false,
    sessionPersistence: false,
    pauseResume: false,
    takeover: false,
  };
}

export function allFeaturesPresent(features: BrowserFeatures): boolean {
  return REQUIRED_FEATURES.every((feature) => features[feature] === true);
}

export function unavailableCapabilities(input: {
  provider: string;
  reason: BrowserCapabilityReason;
  detail: string;
  limits: BrowserLimits;
  costClass?: 'free' | 'paid' | 'unknown';
  features?: BrowserFeatures;
}): BrowserCapabilities {
  return {
    provider: input.provider,
    operational: false,
    reason: input.reason,
    detail: input.detail,
    scope: 'browser',
    costClass: input.costClass ?? 'unknown',
    features: input.features ?? emptyFeatures(),
    limits: input.limits,
    checkedAt: new Date().toISOString(),
  };
}
