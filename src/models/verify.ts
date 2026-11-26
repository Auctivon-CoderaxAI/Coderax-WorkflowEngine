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

  const attestation = input.attestations.find(
    (entry) =>
      entry.providerId === input.model.ref.providerId &&
      entry.modelId === input.model.ref.modelId,
  );
  if (!attestation) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail:
        'The provider publishes no price for this model and no free-tier attestation exists, so it is not usable.',
    };
  }

  const verifiedAt = Date.parse(attestation.verifiedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail: 'The free-tier attestation has invalid dates and is not evidence.',
    };
  }
  if (verifiedAt > input.now.getTime()) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail: 'The free-tier attestation is dated in the future and is not evidence.',
    };
  }
  if (expiresAt <= input.now.getTime()) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail: 'The free-tier attestation has expired; the model must be re-verified.',
    };
  }
  if (!attestation.evidenceUrl.startsWith('https://')) {
    return {
      costClass: 'paid',
      basis: 'none',
      detail: 'The free-tier attestation does not cite an https evidence URL.',
    };
  }

  return {
    costClass: 'free',
    basis: 'attestation',
    detail: 'An unexpired operator attestation cites the zero-cost tier for this exact model.',
    expiresAt: attestation.expiresAt,
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
    if (value > 0) {
      return {
        zero: false,
        detail: `The provider price field ${key} is above zero.`,
      };
    }
  }
  return { zero: true, detail: 'Every published price component is zero.' };
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
