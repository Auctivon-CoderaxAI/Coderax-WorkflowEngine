import type {
  Availability,
  CostClass,
  ModelDescriptor,
  ModelList,
  ModelRef,
  ProviderStatus,
  RouterModel,
  RoutingMode,
  RoutingReport,
} from '@coderax/contracts';
import { modelKey } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Provider-independent zero-cost routing.
 *
 * The router owns the only decision about which model is used. A provider is
 * admitted only when its cost evidence is recorded as verified-free and every
 * model it exposes is free; a model whose cost cannot be established is refused
 * rather than "assumed free". Quotas are counted locally per provider and day,
 * so an exhausted free tier fails closed instead of reaching a paid path.
 */

export type ModelProfile = {
  coding: number;
  reasoning: number;
  speed: number;
  toolCalling: boolean;
  multimodal: boolean;
  contextTokens: number;
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
  profile: ModelProfile;
  availability: Availability;
};

export type ProviderDescriptor = {
  id: string;
  /** `verified-free` is an owner record; `unverified` is refused. */
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
};

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
  reserve: (model: ProviderModel, at: Date) => ServiceResult<ModelRef>;
  recordUsage: (model: ProviderModel, usage: { inputTokens?: number; outputTokens?: number }, at: Date) => void;
};

type UsageWindow = {
  minute: number[];
  day: string;
  requests: number;
  tokens: number;
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

function isFree(provider: ProviderDescriptor, model: ProviderModel): boolean {
  return provider.costEvidence === 'verified-free' && model.costClass === 'free';
}

export function createRouter(input: {
  providers: ProviderDescriptor[];
  /** Bounds the published route so discovery stays a useful, short list. */
  routeLimit?: number;
  /** Injectable clock so quota windows are testable. */
  now?: () => Date;
}): Router {
  const providers = input.providers.slice();
  const routeLimit = input.routeLimit ?? 8;
  const now = input.now ?? (() => new Date());
  const windows = new Map<string, UsageWindow>();

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
    const created: UsageWindow = { minute: [], day, requests: 0, tokens: 0 };
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
      requestsThisMinute: Math.max(0, provider.quota.requestsPerMinute - window.minute.length),
      requestsToday: Math.max(0, provider.quota.requestsPerDay - window.requests),
      tokensToday: Math.max(0, provider.quota.tokensPerDay - window.tokens),
    };
  }

  /**
   * Every reason a model cannot serve now. A model is never silently excluded:
   * the report states the availability it would carry.
   */
  function availabilityOf(provider: ProviderDescriptor, model: ProviderModel, at: Date): Availability {
    if (provider.costEvidence !== 'verified-free') {
      return {
        available: false,
        reason: 'forbidden',
        detail: 'This provider has no recorded zero-cost evidence.',
      };
    }
    if (model.costClass !== 'free') {
      return {
        available: false,
        reason: 'forbidden',
        detail: 'Paid models are refused by the zero-cost gate.',
      };
    }
    if (!model.availability.available) return model.availability;
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

  function eligible(
    request: RoutingRequest,
    at: Date,
    requireTools = request.requireTools ?? false,
  ): ProviderModel[] {
    const admitted: ProviderModel[] = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        if (!isFree(provider, model)) continue;
        if (!availabilityOf(provider, model, at).available) continue;
        if (requireTools && !model.profile.toolCalling) continue;
        if (request.requireVision && !model.profile.multimodal) continue;
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
      if (found.provider.costEvidence !== 'verified-free' || found.model.costClass !== 'free') {
        return fail(
          'paid_model_refused',
          'Coderax does not route to paid models; choose a verified zero-cost model.',
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
    const ranked = eligible(request, now(), request.requireTools ?? false);
    return ranked
      .filter((model) => modelKey(model.ref) !== modelKey(primary.ref))
      .slice(0, limit);
  }

  function reserve(model: ProviderModel, at: Date): ServiceResult<ModelRef> {
    const provider = providerFor(model.ref);
    if (!provider) {
      return fail('model_missing', 'That provider is not registered.');
    }
    const availability = availabilityOf(provider, model, at);
    if (!availability.available) {
      return fail('model_missing', availability.detail);
    }
    const window = windowFor(model, at);
    window.minute.push(at.getTime());
    window.requests += 1;
    return ok(model.ref);
  }

  function recordUsage(
    model: ProviderModel,
    usage: { inputTokens?: number; outputTokens?: number },
    at: Date,
  ): void {
    const window = windowFor(model, at);
    window.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
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
            tokensToday: total.tokensToday + window.tokens,
          };
        },
        { requestsThisMinute: 0, requestsToday: 0, tokensToday: 0 },
      );
      return {
        id: provider.id,
        costEvidence: provider.costEvidence,
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
        });
      }
    }
    const route = eligible({ mode: 'auto' }, at).slice(0, routeLimit);
    return { models: descriptors, route: route.map((model) => model.ref), allowPaid: false };
  }

  return { list, report, select, fallbacks, reserve, recordUsage };
}
