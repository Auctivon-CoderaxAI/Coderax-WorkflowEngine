import type { CostClass, ModelRef } from '@coderax/contracts';
import { modelKey } from '@coderax/contracts';

/**
 * Zero-cost eligibility is evidence, never a label.
 *
 * A configured route or a working API key proves that a provider answers; it
 * proves nothing about what that answer costs. The only thing that can make a
 * model eligible is a recorded price list, taken from the provider's published
 * terms, for that exact model, that says every billed unit is zero and is still
 * current. Anything else — a missing record, a partial price, an expired
 * observation, a price we cannot parse — resolves to `paid`, and a paid model is
 * refused rather than routed.
 */

export type PriceList = {
  currency: 'USD';
  /** USD per one million input tokens, as published. */
  inputPerMillionTokens: number;
  /** USD per one million output tokens, as published. */
  outputPerMillionTokens: number;
  /** USD per call, when the provider bills calls separately. */
  requestPerCall: number;
};

export type EligibilityRecord = {
  providerId: string;
  modelId: string;
  /** HTTPS location of the published terms this observation was read from. */
  source: string;
  /** When the terms were observed. */
  observedAt: string;
  /** When this observation must be re-verified. */
  expiresAt: string;
  pricing: PriceList;
};

export type Eligibility = {
  costClass: CostClass;
  verifiedFree: boolean;
  /** Stable reason code; `verified_zero_price_list` only when verified. */
  reason: EligibilityReason;
  source?: string;
  expiresAt?: string;
};

export type EligibilityReason =
  | 'verified_zero_price_list'
  | 'terms_missing'
  | 'model_mismatch'
  | 'source_not_https'
  | 'observed_at_invalid'
  | 'observed_at_in_future'
  | 'expiry_invalid'
  | 'expired'
  | 'window_too_long'
  | 'currency_unsupported'
  | 'price_invalid'
  | 'price_not_zero';

/** A future-dated observation is allowed this much clock skew, and no more. */
const MAX_CLOCK_SKEW_MS = 60_000;
/** An observation older than this is not evidence, even if it has not expired. */
const MAX_EVIDENCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const PAID_FALLBACK: Eligibility = {
  costClass: 'paid',
  verifiedFree: false,
  reason: 'terms_missing',
};

function paid(reason: EligibilityReason): Eligibility {
  return { costClass: 'paid', verifiedFree: false, reason };
}

function isHttpsSource(source: string): boolean {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:') return false;
    if (url.hostname.length === 0) return false;
    // A URL carrying credentials would be a committed secret.
    if (url.username.length > 0 || url.password.length > 0) return false;
    return true;
  } catch {
    return false;
  }
}

function isZeroPrice(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value === 0;
}

/**
 * The single decision point for "is this model free". Pure, so the same rule is
 * enforced at startup, at route time and in tests.
 */
export function evaluateEligibility(record: EligibilityRecord, at: Date): Eligibility {
  if (record.providerId.trim().length === 0 || record.modelId.trim().length === 0) {
    return paid('model_mismatch');
  }
  if (!isHttpsSource(record.source)) return paid('source_not_https');

  const observedAt = Date.parse(record.observedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(observedAt)) return paid('observed_at_invalid');
  if (!Number.isFinite(expiresAt)) return paid('expiry_invalid');
  if (observedAt > at.getTime() + MAX_CLOCK_SKEW_MS) return paid('observed_at_in_future');
  if (expiresAt <= at.getTime()) return paid('expired');
  if (expiresAt <= observedAt) return paid('expiry_invalid');
  if (expiresAt - observedAt > MAX_EVIDENCE_WINDOW_MS) return paid('window_too_long');

  const pricing = record.pricing;
  if (pricing.currency !== 'USD') return paid('currency_unsupported');
  const prices = [pricing.inputPerMillionTokens, pricing.outputPerMillionTokens, pricing.requestPerCall];
  if (prices.some((price) => !Number.isFinite(price) || price < 0)) return paid('price_invalid');
  if (prices.some((price) => !isZeroPrice(price))) return paid('price_not_zero');

  return {
    costClass: 'free',
    verifiedFree: true,
    reason: 'verified_zero_price_list',
    source: record.source,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export type EligibilityIndex = {
  /** The verdict for one model, or the paid fallback when nothing was recorded. */
  get: (ref: ModelRef) => Eligibility;
  /** Every verdict, in configuration order. */
  entries: () => Array<{ ref: ModelRef; eligibility: Eligibility }>;
  /** Models whose recorded terms exist but do not currently prove zero cost. */
  refused: () => Array<{ ref: ModelRef; eligibility: Eligibility }>;
};

/**
 * Indexes records by exact `provider/model` key. A duplicate record for one
 * model is refused rather than merged: two conflicting price observations are
 * not proof of anything.
 */
export function createEligibilityIndex(records: EligibilityRecord[], at: Date): EligibilityIndex {
  const verdicts = new Map<string, Eligibility>();
  for (const record of records) {
    const key = modelKey({ providerId: record.providerId, modelId: record.modelId });
    if (verdicts.has(key)) {
      verdicts.set(key, paid('model_mismatch'));
      continue;
    }
    verdicts.set(key, evaluateEligibility(record, at));
  }

  return {
    get: (ref) => verdicts.get(modelKey(ref)) ?? PAID_FALLBACK,
    entries: () =>
      [...verdicts.entries()].map(([key, eligibility]) => {
        const [providerId, ...rest] = key.split('/');
        return {
          ref: { providerId: providerId ?? '', modelId: rest.join('/') },
          eligibility,
        };
      }),
    refused: () =>
      [...verdicts.entries()]
        .filter(([, eligibility]) => !eligibility.verifiedFree)
        .map(([key, eligibility]) => {
          const [providerId, ...rest] = key.split('/');
          return {
            ref: { providerId: providerId ?? '', modelId: rest.join('/') },
            eligibility,
          };
        }),
  };
}

/** Human-readable, user-safe explanation for a refusal. */
export function describeRefusal(eligibility: Eligibility): string {
  switch (eligibility.reason) {
    case 'verified_zero_price_list':
      return 'This model has verified zero-cost terms.';
    case 'terms_missing':
      return 'No published zero-cost terms are recorded for this model, so its cost is unknown.';
    case 'model_mismatch':
      return 'The recorded terms or duplicate records do not identify one exact model.';
    case 'source_not_https':
      return 'The recorded terms source is not a plain HTTPS URL and cannot be verified.';
    case 'observed_at_invalid':
      return 'The recorded observation time is not a valid timestamp.';
    case 'observed_at_in_future':
      return 'The recorded observation time is in the future and cannot be trusted.';
    case 'expiry_invalid':
      return 'The recorded terms have no usable expiry.';
    case 'expired':
      return 'The recorded zero-cost terms have expired and must be verified again.';
    case 'window_too_long':
      return 'The recorded observation window is too old to count as current evidence.';
    case 'currency_unsupported':
      return 'The recorded price list is not in the supported currency.';
    case 'price_invalid':
      return 'The recorded price list contains a value that is not a valid price.';
    case 'price_not_zero':
      return 'The recorded price list is not zero, so this model is paid.';
  }
}
