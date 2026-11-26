import type {
  BenchmarkScore,
  CapabilityClass,
  CostVerdict,
  DiscoveredModel,
  FreeTierAttestation,
  ModelCapabilities,
} from './types.js';

/**
 * Zero-cost verification.
 *
 * A provider key proves authentication, never price. The only two accepted
 * proofs are (1) the provider's own machine-readable price list says every text
 * price component is zero, or (2) an unexpired operator attestation names the
 * exact model and a verifiable evidence URL. A model identifier, a `:free`
 * suffix, an account tier or a marketing page is not evidence.
 */
export function verifyFreeTier(input: {
  model: DiscoveredModel;
  attestations: readonly FreeTierAttestation[];
  now: Date;
}): CostVerdict {
  const pricing = input.model.pricing;
  if (pricing !== null) {
    const verdict = verifyPricing(pricing);
    if (!verdict.zero) {
      return {
        costClass: 'paid',
        basis: 'pricing',
        detail: verdict.detail,
      };
    }
    return {
      costClass: 'free',
      basis: 'pricing',
      detail: 'The provider price list reports zero prompt, completion and request cost.',
    };
  }

  const matches = input.attestations.filter(
    (entry) =>
      entry.providerId === input.model.ref.providerId &&
      entry.modelId === input.model.ref.modelId,
  );
  if (matches.length === 0) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail:
        'The provider publishes no price for this model and no free-tier attestation exists, so it is not usable.',
    };
  }

  // A stale attestation must not mask a later active one for the same model.
  let failure: CostVerdict | null = null;
  for (const attestation of matches) {
    const verdict = verifyAttestation(attestation, input.now);
    if (verdict.costClass === 'free') return verdict;
    failure ??= verdict;
  }
  return failure ?? {
    costClass: 'paid',
    basis: 'none',
    detail: 'No active free-tier attestation exists for this exact model.',
  };
}

/** An attestation is a snapshot of provider terms; it is never a standing claim. */
export const MAX_ATTESTATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

const BILLING_BOUNDARIES = new Set(['no-payment-method', 'spend-cap', 'prepaid-credit-only']);

/**
 * An operator attestation is accepted only when it establishes a hard spending
 * boundary, not merely a free allowance.
 *
 * A configuration flag, an API key and a recorded price page are each
 * insufficient on their own. The key proves authentication; the page proves what
 * the provider advertises. Neither proves that *this* account cannot be charged.
 * So the record must name the account it was verified against, state why that
 * account cannot incur a charge, record a hard cap of exactly zero, denominate
 * the claim in USD, publish the allowance it relies on, and stay within a
 * bounded validity window. Anything else is reported `paid` and refused.
 */
function verifyAttestation(attestation: FreeTierAttestation, now: Date): CostVerdict {
  const reject = (detail: string): CostVerdict => ({ costClass: 'paid', basis: 'none', detail });
  const verifiedAt = Date.parse(attestation.verifiedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) {
    return reject('The free-tier attestation has invalid dates and is not evidence.');
  }
  if (verifiedAt > now.getTime()) {
    return reject('The free-tier attestation is dated in the future and is not evidence.');
  }
  if (expiresAt <= now.getTime()) {
    return reject('The free-tier attestation has expired; the model must be re-verified.');
  }
  if (expiresAt - verifiedAt > MAX_ATTESTATION_WINDOW_MS) {
    return reject(
      'The free-tier attestation claims a validity window longer than 90 days; provider terms are not that stable.',
    );
  }
  if (!attestation.evidenceUrl.startsWith('https://')) {
    return reject('The free-tier attestation does not cite an https evidence URL.');
  }
  if (attestation.currency !== 'USD') {
    return reject('The free-tier attestation is not denominated in USD, so a zero amount cannot be compared.');
  }
  if (attestation.accountRef.trim() === '') {
    return reject('The free-tier attestation does not name the account it was verified against.');
  }
  if (!BILLING_BOUNDARIES.has(attestation.billing)) {
    return reject('The free-tier attestation does not record a recognized billing boundary.');
  }
  if (attestation.spendCapUsd !== 0) {
    return reject(
      'The account has a non-zero spending cap, so exceeding the free allowance would be billed.',
    );
  }
  const requestsPerDay = attestation.quota?.requestsPerDay ?? 0;
  const tokensPerDay = attestation.quota?.tokensPerDay ?? 0;
  if (!(requestsPerDay >= 1) || !(tokensPerDay >= 1)) {
    return reject('The free-tier attestation does not publish a usable daily allowance.');
  }
  return {
    costClass: 'free',
    basis: 'attestation',
    detail:
      'An unexpired attestation records a zero-cap, USD-denominated free tier for this exact model and account.',
    expiresAt: attestation.expiresAt,
    quota: { requestsPerDay, tokensPerDay },
  };
}

function verifyPricing(pricing: Record<string, unknown>): { zero: boolean; detail: string } {
  const prompt = numeric(pricing.prompt);
  const completion = numeric(pricing.completion);
  if (prompt === null || completion === null) {
    return {
      zero: false,
      detail: 'The provider price object does not state prompt and completion prices.',
    };
  }
  if (pricing.overrides !== undefined) {
    return {
      zero: false,
      detail: 'The provider publishes conditional price overrides, so a zero cost cannot be proven.',
    };
  }
  for (const [key, raw] of Object.entries(pricing)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'boolean') {
      return {
        zero: false,
        detail: `The provider price field ${key} is not a numeric amount.`,
      };
    }
    if (typeof raw === 'object') {
      return {
        zero: false,
        detail: `The provider publishes structured pricing for ${key}, so a zero cost cannot be proven.`,
      };
    }
    const value = numeric(raw);
    if (value === null) {
      return {
        zero: false,
        detail: `The provider price field ${key} is not numeric.`,
      };
    }
    if (value !== 0 || !isExactZero(raw)) {
      return {
        zero: false,
        detail: `The provider price field ${key} is not exactly zero.`,
      };
    }
  }
  return { zero: true, detail: 'Every published price component is zero.' };
}

/**
 * `Number('1e-400')` is `0`, but the published amount is not zero. For a string
 * price, inspect the decimal mantissa so an underflowing nonzero value cannot
 * be mistaken for a free tier. Numeric zero and zero-valued decimal strings are
 * still accepted.
 */
function isExactZero(value: unknown): boolean {
  if (typeof value === 'number') return value === 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return false;
  const mantissa = trimmed.split(/[eE]/)[0] ?? '';
  return !/[1-9]/.test(mantissa);
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Capability classification.
 *
 * Vision, tool calling and streaming come from provider metadata. Reasoning can
 * additionally be declared by a provider parameter. Coding is never inferred
 * from a model name or a vendor claim: it is `verified` only by a reproducible
 * local benchmark, otherwise it remains `unknown`.
 */
export function classifyCapabilities(input: {
  discovered: DiscoveredModel;
  score: BenchmarkScore | null;
}): ModelCapabilities {
  const reasoning: CapabilityClass = input.score
    ? 'verified'
    : input.discovered.capabilities.reasoning
      ? 'declared'
      : 'unknown';
  return {
    text: true,
    coding: input.score ? 'verified' : 'unknown',
    reasoning,
    vision: input.discovered.capabilities.vision,
    toolCalling: input.discovered.capabilities.toolCalling,
    streaming: input.discovered.capabilities.streaming,
  };
}

export function scoreFor(
  scores: readonly BenchmarkScore[],
  model: DiscoveredModel,
  now: Date,
  maxAgeMs: number,
): BenchmarkScore | null {
  const score = scores.find(
    (entry) =>
      entry.providerId === model.ref.providerId && entry.modelId === model.ref.modelId,
  );
  if (!score) return null;
  const measured = Date.parse(score.measuredAt);
  if (!Number.isFinite(measured) || measured > now.getTime()) return null;
  if (now.getTime() - measured > maxAgeMs) return null;
  if (score.samples < 1) return null;
  return score;
}

/**
 * A conservative token estimate for context validation. Four characters per
 * token is optimistic for prose and wrong for code, so the router assumes three
 * and adds per-message overhead. Malformed estimates fail closed.
 */
export function estimateTokens(texts: readonly string[]): number {
  let total = 0;
  for (const text of texts) {
    total += Math.ceil(text.length / 3) + 4;
  }
  return total;
}

export function estimateMessageTokens(messages: readonly { text: string; images?: string[] }[]): number {
  let total = 16;
  for (const message of messages) {
    total += Math.ceil(message.text.length / 3) + 4;
    total += (message.images?.length ?? 0) * 1024;
  }
  return total;
}
