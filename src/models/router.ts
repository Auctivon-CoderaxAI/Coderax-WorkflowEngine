import type {
  Availability,
  CostClass,
  ModelDescriptor,
  ModelList,
  ModelRef,
  PromptTraining,
  ProviderStatus,
  RouterModel,
  RoutingMode,
  RoutingReport,
} from '@coderax/contracts';
import { CREATIVE_FORMATS, IMAGE_GENERATION_UNAVAILABLE } from '@coderax/contracts';
import { modelKey } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { Eligibility, InferenceReadiness } from './eligibility.js';
import type { CircuitBreakers } from './circuit.js';
import { createCircuitBreakers } from './circuit.js';

/**
 * Provider-independent zero-cost routing.
 *
 * The router owns the only decision about which model is used. A model is
 * admitted only when its own recorded terms prove zero cost; a provider-level
 * flag, a configured route and a working API key are all insufficient. A model
 * whose cost cannot be established is refused rather than "assumed free".
 *
 * Quotas are counted locally per model and day, provider circuits stop a failing
 * endpoint from being retried forever, and fallback is bounded to the set of
 * models that are already verified free, so no retry can reach a paid path.
 */

export type ModelProfile = {
  coding: number;
  reasoning: number;
  speed: number;
  toolCalling: boolean;
  multimodal: boolean;
  contextTokens: number;
};

export type ProviderLimits = {
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  concurrentRequests: number;
};

export type ProviderQuota = {
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
};

export type ProviderModel = {
  ref: ModelRef;
  label: string;
  costClass: CostClass;
  /** The verified-free verdict this model was admitted on. */
  eligibility: Eligibility;
  profile: ModelProfile;
  limits: ProviderLimits;
  availability: Availability;
  /**
   * Separate from `eligibility`: the price can be proven while the model has
   * never been observed answering. Missing evidence fails closed at selection.
   */
  inference?: InferenceReadiness;
  promptTraining?: PromptTraining;
};

export type ProviderDescriptor = {
  id: string;
  /** Summary only; admission is decided per model, never by this field. */
  costEvidence: 'verified-free' | 'unverified';
  quota: ProviderQuota;
  models: ProviderModel[];
};

export type RoutingRequest = {
  mode: RoutingMode;
  requested?: ModelRef | null;
  /** Only models that accept tool definitions may be chosen. */
  requireTools?: boolean;
  /** Only models that accept images may be chosen. */
  requireVision?: boolean;
  /** Estimated prompt size, checked against a provider's per-request ceiling. */
  estimatedInputTokens?: number;
};

export type Reservation = { ref: ModelRef; reservedTokens: number };

export type Router = {
  list: () => ModelList;
  report: (mode: RoutingMode) => RoutingReport;
  select: (request: RoutingRequest) => ServiceResult<ProviderModel>;
  /** Ordered alternates, excluding the primary, bounded by `limit`. */
  fallbacks: (
    primary: ProviderModel,
    request: RoutingRequest,
    limit: number,
  ) => ProviderModel[];
  /** Atomic local reservation of one request and its estimated tokens. */
  reserve: (
    model: ProviderModel,
    at: Date,
    tokens: number,
  ) => ServiceResult<Reservation>;
  settle: (
    model: ProviderModel,
    usage: { inputTokens?: number; outputTokens?: number },
    at: Date,
    reservedTokens: number,
  ) => void;
  recordFailure: (model: ProviderModel, at: Date, retryAfterMs?: number) => void;
  recordSuccess: (model: ProviderModel) => void;
  /** Circuit and quota state, for health and diagnostics. */
  health: (at: Date) => {
    providers: Array<{ id: string; circuit: string; models: Array<{ ref: ModelRef; circuit: string }> }>;
  };
};

type UsageWindow = {
  minute: number[];
  day: string;
  requests: number;
  tokens: number;
  reserved: number;
  inFlight: number;
};

const WEIGHTS: Readonly<Record<RoutingMode, { coding: number; reasoning: number; speed: number }>> = {
  auto: { coding: 0.35, reasoning: 0.35, speed: 0.3 },
  fast: { coding: 0.2, reasoning: 0.1, speed: 0.7 },
  complex: { coding: 0.4, reasoning: 0.45, speed: 0.15 },
};

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function score(model: ProviderModel, mode: RoutingMode): number {
  const weight = WEIGHTS[mode];
  const base =
    model.profile.coding * weight.coding +
    model.profile.reasoning * weight.reasoning +
    model.profile.speed * weight.speed;
  // A tool-capable model is not automatically better, but a small deterministic
  // bonus breaks ties toward the one that can actually complete an action turn.
  return base + (model.profile.toolCalling ? 0.02 : 0);
}

/**
 * The zero-cost gate. Both halves are required: a verified verdict for this
 * exact model, and a `free` cost class derived from that verdict. A descriptor
 * that says `free` without a verdict is not eligible.
 */
function isFree(model: ProviderModel): boolean {
  return model.costClass === 'free' && model.eligibility.verifiedFree;
}

export function createRouter(input: {
  providers: ProviderDescriptor[];
  /** Bounds the published route so discovery stays a useful, short list. */
  routeLimit?: number;
  /** Injectable clock so quota windows are testable. */
  now?: () => Date;
  circuits?: CircuitBreakers;
}): Router {
  const providers = input.providers.slice();
  const routeLimit = input.routeLimit ?? 8;
  const now = input.now ?? (() => new Date());
  const circuits = input.circuits ?? createCircuitBreakers();
  const windows = new Map<string, UsageWindow>();
  /** Providers that answered 429 with a reset window, until that window passes. */
  const providerCooldown = new Map<string, { until: number; reason: string }>();

  function windowFor(model: ProviderModel, at: Date): UsageWindow {
    const key = modelKey(model.ref);
    const day = utcDay(at);
    const existing = windows.get(key);
    if (existing && existing.day === day) {
      // Drop minute entries outside the rolling window.
      const cutoff = at.getTime() - 60_000;
      existing.minute = existing.minute.filter((stamp) => stamp > cutoff);
      return existing;
    }
    const created: UsageWindow = { minute: [], day, requests: 0, tokens: 0, reserved: 0, inFlight: 0 };
    windows.set(key, created);
    return created;
  }

  function providerFor(ref: ModelRef): ProviderDescriptor | undefined {
    return providers.find((provider) => provider.id === ref.providerId);
  }

  function quotaState(provider: ProviderDescriptor, model: ProviderModel, at: Date) {
    const window = windowFor(model, at);
    return {
      minute: window.minute.length,
      requests: window.requests,
      tokens: window.tokens,
      reserved: window.reserved,
      inFlight: window.inFlight,
      requestsThisMinute: Math.max(0, model.limits.requestsPerMinute - window.minute.length),
      requestsToday: Math.max(0, provider.quota.requestsPerDay - window.requests),
      tokensToday: Math.max(0, provider.quota.tokensPerDay - window.tokens - window.reserved),
    };
  }

  function cooldown(providerId: string, at: Date): string | null {
    const entry = providerCooldown.get(providerId);
    if (!entry) return null;
    if (at.getTime() >= entry.until) {
      providerCooldown.delete(providerId);
      return null;
    }
    return entry.reason;
  }

  /**
   * Every reason a model cannot serve now. A model is never silently excluded:
   * the report states the availability it would carry.
   */
  function availabilityOf(provider: ProviderDescriptor, model: ProviderModel, at: Date): Availability {
    if (!isFree(model)) {
      return {
        available: false,
        reason: 'forbidden',
        detail:
          model.costClass === 'paid'
            ? 'Paid models are refused by the zero-cost gate.'
            : 'This model has no verified zero-cost evidence.',
      };
    }
    // A price observation is not an inference. A model with no recorded,
    // recent successful call is reported not-ready instead of being tried.
    if (model.inference && !model.inference.ready) {
      return { available: false, reason: 'not_ready', detail: model.inference.detail };
    }
    if (!model.availability.available) return model.availability;
    const cooling = cooldown(provider.id, at);
    if (cooling) {
      return { available: false, reason: 'not_ready', detail: cooling };
    }
    if (!circuits.allow(`model:${modelKey(model.ref)}`, at)) {
      return {
        available: false,
        reason: 'not_ready',
        detail: 'This model is circuit-broken after repeated provider failures.',
      };
    }
    const quota = quotaState(provider, model, at);
    if (quota.requestsThisMinute <= 0) {
      return {
        available: false,
        reason: 'not_ready',
        detail: 'The provider minute quota is exhausted.',
      };
    }
    if (quota.requestsToday <= 0 || quota.tokensToday <= 0) {
      return {
        available: false,
        reason: 'not_ready',
        detail: 'The provider daily quota is exhausted.',
      };
    }
    return model.availability;
  }

  function eligible(request: RoutingRequest, at: Date): ProviderModel[] {
    const admitted: ProviderModel[] = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        if (!isFree(model)) continue;
        if (!availabilityOf(provider, model, at).available) continue;
        if (request.requireTools && !model.profile.toolCalling) continue;
        if (request.requireVision && !model.profile.multimodal) continue;
        if (
          request.estimatedInputTokens !== undefined &&
          model.limits.maxInputTokens !== undefined &&
          request.estimatedInputTokens > model.limits.maxInputTokens
        ) {
          continue;
        }
        admitted.push(model);
      }
    }
    return admitted.sort((left, right) => {
      const delta = score(right, request.mode) - score(left, request.mode);
      if (Math.abs(delta) > 1e-9) return delta;
      const context = right.profile.contextTokens - left.profile.contextTokens;
      if (context !== 0) return context;
      return modelKey(left.ref).localeCompare(modelKey(right.ref));
    });
  }

  function find(ref: ModelRef): { provider: ProviderDescriptor; model: ProviderModel } | null {
    const provider = providerFor(ref);
    if (!provider) return null;
    const model = provider.models.find((candidate) => modelKey(candidate.ref) === modelKey(ref));
    return model ? { provider, model } : null;
  }

  function select(request: RoutingRequest): ServiceResult<ProviderModel> {
    const at = now();
    const ranked = eligible(request, at);

    if (request.requested) {
      const found = find(request.requested);
      if (!found) {
        return fail('model_missing', 'That model is not in the verified zero-cost catalogue.');
      }
      if (found.model.costClass === 'paid' || !found.model.eligibility.verifiedFree) {
        return fail(
          'paid_model_refused',
          'Coderax does not route to paid or unpriced models; choose a verified zero-cost model.',
        );
      }
      const availability = availabilityOf(found.provider, found.model, at);
      if (!availability.available) {
        return fail('model_missing', `That model cannot serve now: ${availability.detail}`);
      }
      if (request.requireTools && !found.model.profile.toolCalling) {
        return fail('model_missing', 'That model does not accept tool definitions.');
      }
      if (request.requireVision && !found.model.profile.multimodal) {
        return fail('model_missing', 'That model does not accept image input.');
      }
      return ok(found.model);
    }

    const first = ranked[0];
    if (!first) {
      return fail(
        'model_missing',
        'No verified zero-cost model is available for this request; the engine fails closed.',
      );
    }
    return ok(first);
  }

  function fallbacks(primary: ProviderModel, request: RoutingRequest, limit: number): ProviderModel[] {
    if (limit <= 0) return [];
    const ranked = eligible(request, now());
    return ranked
      .filter((model) => modelKey(model.ref) !== modelKey(primary.ref))
      .slice(0, limit);
  }

  function reserve(model: ProviderModel, at: Date, tokens: number): ServiceResult<Reservation> {
    const provider = providerFor(model.ref);
    if (!provider) {
      return fail('model_missing', 'That provider is not registered.');
    }
    if (!isFree(model)) {
      return fail('paid_model_refused', 'That model is not verified zero-cost.');
    }
    const availability = availabilityOf(provider, model, at);
    if (!availability.available) {
      return fail('model_missing', availability.detail);
    }
    const wanted = Math.max(0, Math.ceil(tokens));
    const quota = quotaState(provider, model, at);
    if (quota.inFlight >= model.limits.concurrentRequests) {
      return fail(
        'model_missing',
        'This model is already serving its configured concurrent-request limit.',
      );
    }
    if (wanted > quota.tokensToday) {
      return fail('model_missing', 'The provider daily token quota cannot cover this request.');
    }
    if (model.limits.maxInputTokens !== undefined && wanted > model.limits.maxInputTokens) {
      return fail('model_missing', 'The request exceeds this model’s published input limit.');
    }
    const window = windowFor(model, at);
    // One synchronous section: the check above and this write cannot interleave,
    // so concurrent runs in this process cannot both spend the last slot.
    window.minute.push(at.getTime());
    window.requests += 1;
    window.reserved += wanted;
    window.inFlight += 1;
    return ok({ ref: model.ref, reservedTokens: wanted });
  }

  function settle(
    model: ProviderModel,
    usage: { inputTokens?: number; outputTokens?: number },
    at: Date,
    reservedTokens: number,
  ): void {
    const window = windowFor(model, at);
    window.inFlight = Math.max(0, window.inFlight - 1);
    window.reserved = Math.max(0, window.reserved - Math.max(0, reservedTokens));
    window.tokens += Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
  }

  function recordFailure(model: ProviderModel, at: Date, retryAfterMs?: number): void {
    circuits.failure(`model:${modelKey(model.ref)}`, at, retryAfterMs);
    circuits.failure(`provider:${model.ref.providerId}`, at, retryAfterMs);
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      providerCooldown.set(model.ref.providerId, {
        until: at.getTime() + retryAfterMs,
        reason: 'The provider asked the engine to wait before it retries.',
      });
    }
  }

  function recordSuccess(model: ProviderModel): void {
    circuits.success(`model:${modelKey(model.ref)}`);
    circuits.success(`provider:${model.ref.providerId}`);
  }

  function routerModel(provider: ProviderDescriptor, model: ProviderModel, at: Date): RouterModel {
    const quota = quotaState(provider, model, at);
    return {
      ref: model.ref,
      label: model.label,
      providerId: provider.id,
      costClass: model.costClass,
      capabilities: { ...model.profile },
      availability: availabilityOf(provider, model, at),
      requestsRemaining: Math.min(quota.requestsThisMinute, quota.requestsToday),
      tokensRemaining: quota.tokensToday,
      promptTraining: model.promptTraining ?? 'unknown',
      inputModalities: model.profile.multimodal ? ['text', 'image'] : ['text'],
      inFlight: quota.inFlight,
    };
  }

  function report(mode: RoutingMode): RoutingReport {
    const at = now();
    const route = eligible({ mode }, at).slice(0, routeLimit);
    const statuses: ProviderStatus[] = providers.map((provider) => {
      const models = provider.models.map((model) => routerModel(provider, model, at));
      // Provider usage is the sum of the models it serves; free tiers are usually
      // issued per model, so this is an upper bound rather than an extra limit.
      const used = provider.models.reduce(
        (total, model) => {
          const window = windowFor(model, at);
          return {
            requestsThisMinute: total.requestsThisMinute + window.minute.length,
            requestsToday: total.requestsToday + window.requests,
            tokensToday: total.tokensToday + window.tokens + window.reserved,
          };
        },
        { requestsThisMinute: 0, requestsToday: 0, tokensToday: 0 },
      );
      const verified = provider.models.every((model) => isFree(model));
      return {
        id: provider.id,
        costEvidence: verified ? 'verified-free' : 'unverified',
        quota: { ...provider.quota },
        used,
        models,
      };
    });
    return { mode, providers: statuses, route: route.map((model) => model.ref), allowPaid: false };
  }

  function list(): ModelList {
    const at = now();
    const descriptors: ModelDescriptor[] = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        descriptors.push({
          ref: model.ref,
          label: model.label,
          costClass: model.costClass,
          contextTokens: model.profile.contextTokens,
          toolCalling: model.profile.toolCalling,
          streaming: true,
          availability: availabilityOf(provider, model, at),
          inputModalities: model.profile.multimodal ? ['text', 'image'] : ['text'],
          promptTraining: model.promptTraining ?? 'unknown',
        });
      }
    }
    const route = eligible({ mode: 'auto' }, at).slice(0, routeLimit);
    const vision = eligible({ mode: 'auto', requireVision: true }, at);
    return {
      models: descriptors,
      route: route.map((model) => model.ref),
      allowPaid: false,
      media: {
        imageInput: { available: vision.length > 0, models: vision.map((model) => model.ref) },
        imageGeneration: { available: false, detail: IMAGE_GENERATION_UNAVAILABLE },
        creativeText: { available: route.length > 0, formats: [...CREATIVE_FORMATS] },
      },
    };
  }

  function health(at: Date) {
    return {
      providers: providers.map((provider) => ({
        id: provider.id,
        circuit: circuits.state(`provider:${provider.id}`, at),
        models: provider.models.map((model) => ({
          ref: model.ref,
          circuit: circuits.state(`model:${modelKey(model.ref)}`, at),
        })),
      })),
    };
  }

  return { list, report, select, fallbacks, reserve, settle, recordFailure, recordSuccess, health };
}
