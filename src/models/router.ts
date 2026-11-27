import type {
  DataMode,
  ModelDescriptor,
  ModelList,
  ModelRef,
  ProblemCode,
  ProviderStatus,
  RouterModel,
  RoutingReport,
  Usage,
} from '@coderax/contracts';
import { modelKey } from '@coderax/contracts';
import type { BudgetLedger } from './budget.js';
import { createCircuit, type Circuit, type CircuitAdmission } from './circuit.js';
import type {
  PolicyDecision,
  ProcessingOperation,
  ProviderPolicyRegistry,
} from './policy.js';
import { createProviderLimiter, type ProviderLimiter } from './rate.js';
import type {
  BenchmarkScore,
  DiscoveredModel,
  FreeTierAttestation,
  GatewayCompletion,
  GatewayRequest,
  GatewayStreamEvent,
  ModelGateway,
  ModelHealth,
  ModelState,
  ProviderAdapter,
  ProviderCompletion,
  ProviderSettings,
  ProviderStreamEvent,
  RankedCandidate,
  RegisteredProvider,
  RouterHealth,
  RoutingMode,
  ToolSpec,
} from './types.js';
import { ModelRoutingError, ProviderError } from './types.js';
import { classifyCapabilities, estimateMessageTokens, estimateTokens, scoreFor, verifyFreeTier } from './verify.js';

/**
 * The one model router.
 *
 * Discovery, cost verification, capability classification, ranking, budgets,
 * provider limits, circuits, fallback, streaming normalization and health all
 * live here. A caller receives a resolved model; an adapter receives a model id.
 * If no currently usable model has verified zero cost, routing fails closed with
 * `model_missing` rather than falling through to a paid endpoint.
 */

export type ResolveOptions = {
  /** The exact processing operation; authorization is granted per operation. */
  operation: ProcessingOperation;
  routing?: RoutingMode;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  requireVision?: boolean;
  requireTools?: boolean;
};

export type PlanningInput = ResolveOptions & {
  requested?: ModelRef | null;
  mode: DataMode;
  allowFallback?: boolean;
  messages?: Array<{ text: string; images?: string[] }>;
};

export type RoutePlan = {
  mode: RoutingMode;
  candidates: RankedCandidate[];
  /** False when an explicitly named model is pinned by the caller. */
  fallbackAllowed: boolean;
};

export type RefreshReport = {
  at: string;
  providers: Array<{
    providerId: string;
    ok: boolean;
    models: number;
    verifiedFree: number;
    detail?: string;
  }>;
  verifiedFree: number;
};

export type ModelRouterOptions = {
  providers: RegisteredProvider[];
  attestations?: readonly FreeTierAttestation[];
  benchmarks?: readonly BenchmarkScore[];
  preferredRoute?: readonly ModelRef[];
  budget: BudgetLedger;
  /** The only authority on whether a provider may process a request. */
  policy: ProviderPolicyRegistry;
  maxCandidates?: number;
  maxFallbacks?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  discoveryIntervalMs?: number;
  defaultMaxOutputTokens?: number;
  contextMarginTokens?: number;
  benchmarkMaxAgeMs?: number;
  now?: () => Date;
};

export type ModelRouter = ModelGateway & {
  /** The published routing report: real usage joined with recorded quota. */
  report: (mode: RoutingMode) => RoutingReport;
  /** The router always offers normalized streaming, even for one-shot adapters. */
  stream: NonNullable<ModelGateway['stream']>;
  list: () => ModelList;
  route: (mode?: RoutingMode) => ModelRef[];
  resolve: (
    requested: ModelRef | null | undefined,
    mode: DataMode,
    options: ResolveOptions,
  ) => { ok: true; value: ModelDescriptor } | { ok: false; code: ProblemCode; detail: string; retryable: boolean };
  plan: (input: PlanningInput) => { ok: true; value: RoutePlan } | { ok: false; code: ProblemCode; detail: string; retryable: boolean };
  refresh: () => Promise<RefreshReport>;
  health: () => RouterHealth;
  hasVerifiedFreeRoute: () => boolean;
  start: () => void;
  stop: () => void;
};

type ProviderRuntime = {
  adapter: ProviderAdapter;
  settings: ProviderSettings;
  limiter: ProviderLimiter;
  circuit: Circuit;
  lastDiscoveryAt: Date | null;
  /** Discovery admission; a failed model call is the circuit's concern. */
  discoveryOk: boolean;
  lastError: string | null;
  latencyMs: number;
  verifiedFree: number;
  quotaUntil: Date | null;
  /** Real usage observed since UTC midnight; the routing report is not invented. */
  usedRequests: number;
  usedTokens: number;
  recentRequests: number[];
  usageDay: string;
};

type ModelRuntime = {
  state: ModelState;
  circuit: Circuit;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencyMs: number;
  lastFailureAt: Date | null;
};

type AttemptFailure = {
  error: ProviderError;
  provider: ProviderRuntime;
  runtime: ModelRuntime;
};

const DEFAULT_DISCOVERY_MS = 600_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 1024;
const DEFAULT_CONTEXT_MARGIN = 64;
const DEFAULT_BENCHMARK_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PROVIDER_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ewma(previous: number, sample: number): number {
  if (previous <= 0) return sample;
  return previous * 0.7 + sample * 0.3;
}

function sanitizeDetail(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

function msUntilUtcMidnight(at: Date): number {
  const next = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.max(1_000, next - at.getTime());
}

export function inferRoutingMode(input: {
  objective: string;
  toolCount?: number;
  imageCount?: number;
}): RoutingMode {
  const text = input.objective;
  if ((input.toolCount ?? 0) > 0 || (input.imageCount ?? 0) > 0) return 'complex';
  if (text.length >= 1_500) return 'complex';
  if (/```|\b(refactor|implement|debug|prove|architect|analyse|analyze|multi-step|benchmark)\b/i.test(text)) {
    return 'complex';
  }
  if (text.length <= 280 && !/\b(code|design|plan|why|compare|explain in detail)\b/i.test(text)) {
    return 'fast';
  }
  return 'auto';
}

export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  const now = options.now ?? (() => new Date());
  const maxCandidates = clamp(options.maxCandidates ?? 4, 1, 8);
  const maxFallbacks = clamp(options.maxFallbacks ?? 2, 0, 4);
  const failureThreshold = clamp(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD, 1, 10);
  const cooldownMs = clamp(options.cooldownMs ?? DEFAULT_COOLDOWN_MS, 1_000, 600_000);
  const discoveryIntervalMs = clamp(
    options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_MS,
    60_000,
    3_600_000,
  );
  const defaultMaxOutput = clamp(options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT, 32, 32_768);
  const contextMargin = clamp(options.contextMarginTokens ?? DEFAULT_CONTEXT_MARGIN, 0, 8_192);
  const benchmarkMaxAgeMs = Math.max(60_000, options.benchmarkMaxAgeMs ?? DEFAULT_BENCHMARK_AGE_MS);
  const attestations = [...(options.attestations ?? [])];
  const benchmarks = [...(options.benchmarks ?? [])];
  const preferred = [...(options.preferredRoute ?? [])];
  const budget = options.budget;
  const policy = options.policy;
  if (!policy || typeof policy.evaluate !== 'function') {
    // A router without a policy registry would authorize every provider by
    // omission. Refuse construction instead of routing unprotected.
    throw new Error('A provider policy registry is required to construct the model router.');
  }

  const providers = new Map<string, ProviderRuntime>();
  for (const registration of options.providers) {
    providers.set(registration.adapter.id, {
      adapter: registration.adapter,
      settings: registration.settings,
      limiter: createProviderLimiter(registration.settings),
      circuit: createCircuit({ failureThreshold, cooldownMs }),
      lastDiscoveryAt: null,
      discoveryOk: false,
      lastError: null,
      latencyMs: 0,
      verifiedFree: 0,
      quotaUntil: null,
      usedRequests: 0,
      usedTokens: 0,
      recentRequests: [],
      usageDay: '',
    });
  }

  /**
   * Record what the provider actually served. The routing report publishes these
   * counters, so they count admitted requests and reported tokens rather than an
   * estimate that would look like usage without being usage.
   */
  function noteUsage(provider: ProviderRuntime, at: Date, usage?: Usage): void {
    const day = at.toISOString().slice(0, 10);
    if (provider.usageDay !== day) {
      provider.usageDay = day;
      provider.usedRequests = 0;
      provider.usedTokens = 0;
      provider.recentRequests = [];
    }
    if (usage === undefined) {
      provider.usedRequests += 1;
      provider.recentRequests.push(at.getTime());
      const cutoff = at.getTime() - 60_000;
      while (provider.recentRequests.length > 0 && (provider.recentRequests[0] ?? 0) < cutoff) {
        provider.recentRequests.shift();
      }
      return;
    }
    provider.usedTokens += Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
  }

  let models = new Map<string, ModelRuntime>();
  let refreshing: Promise<RefreshReport> | null = null;
  let timer: NodeJS.Timeout | null = null;

  function providerAvailable(provider: ProviderRuntime, at: Date): boolean {
    if (provider.lastDiscoveryAt === null || !provider.discoveryOk) return false;
    if (provider.quotaUntil !== null && provider.quotaUntil.getTime() > at.getTime()) return false;
    return provider.circuit.state(at) !== 'open';
  }

  function modelAvailability(runtime: ModelRuntime, at: Date): ModelState['availability'] {
    const provider = providers.get(runtime.state.ref.providerId);
    if (!provider) {
      return {
        available: false,
        reason: 'not_configured',
        detail: 'The provider is no longer configured.',
      };
    }
    if (!runtime.state.supported) return runtime.state.availability;
    if (
      runtime.state.costExpiresAt !== null &&
      Date.parse(runtime.state.costExpiresAt) <= at.getTime()
    ) {
      return {
        available: false,
        reason: 'not_ready',
        detail: 'The free-tier attestation expired; the model must be re-verified.',
      };
    }
    if (!providerAvailable(provider, at)) {
      const quota = provider.quotaUntil;
      return {
        available: false,
        reason: 'not_ready',
        detail:
          quota !== null && quota.getTime() > at.getTime()
            ? `The provider's free allowance is cooling down until ${quota.toISOString()}.`
            : 'The provider is unhealthy or its discovery failed.',
      };
    }
    if (runtime.circuit.state(at) === 'open') {
      return {
        available: false,
        reason: 'server_unavailable',
        detail: "This model's circuit is open after repeated failures.",
      };
    }
    return { available: true, reason: 'ready', detail: 'Verified zero-cost endpoint is ready.' };
  }

  function descriptorFor(runtime: ModelRuntime, at: Date): ModelDescriptor {
    const state = runtime.state;
    return {
      ref: state.ref,
      label: state.label,
      costClass: state.costClass,
      ...(state.contextTokens === null ? {} : { contextTokens: state.contextTokens }),
      toolCalling: state.capabilities.toolCalling,
      streaming: state.capabilities.streaming,
      availability: modelAvailability(runtime, at),
    };
  }

  function preferredIndexFor(ref: ModelRef): number | null {
    const index = preferred.findIndex((entry) => modelKey(entry) === modelKey(ref));
    return index < 0 ? null : index;
  }

  function contextFits(input: {
    state: ModelState;
    estimatedInputTokens?: number;
    maxOutputTokens?: number;
  }): boolean {
    if (input.state.contextTokens === null) return false;
    const estimated = input.estimatedInputTokens ?? 0;
    const output = Math.min(
      input.maxOutputTokens ?? defaultMaxOutput,
      input.state.maxOutputTokens ?? defaultMaxOutput,
    );
    return estimated + output + contextMargin <= input.state.contextTokens;
  }

  function eligible(input: PlanningInput, at: Date): RankedCandidate[] {
    const estimated = input.estimatedInputTokens;
    const candidates: RankedCandidate[] = [];
    for (const runtime of models.values()) {
      const state = runtime.state;
      if (!state.supported || state.costClass !== 'free') continue;
      // Cost, capability and policy are independent dimensions. A provider that
      // is free and capable is still excluded unless this exact operation is
      // approved for this data mode and the provider's evidence permits it.
      const permission = policy.evaluate({
        providerId: state.ref.providerId,
        operation: input.operation,
        mode: input.mode,
        at,
      });
      if (!permission.allowed) continue;
      const availability = modelAvailability(runtime, at);
      if (!availability.available) continue;
      if (runtime.circuit.state(at) === 'open') continue;
      if (input.requireVision && !state.capabilities.vision) continue;
      if (input.requireTools && !state.capabilities.toolCalling) continue;
      if (!contextFits({ state, ...(estimated === undefined ? {} : { estimatedInputTokens: estimated }), ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) })) {
        continue;
      }
      const quality = qualityScore(state, at);
      const reliability = reliabilityScore(runtime);
      const speed = speedScore(runtime.latencyMs);
      const mode = input.routing ?? 'auto';
      const weights =
        mode === 'fast'
          ? { quality: 0.05, reliability: 0.15, speed: 0.8 }
          : mode === 'complex'
            ? { quality: 0.65, reliability: 0.25, speed: 0.1 }
            : { quality: 0.45, reliability: 0.35, speed: 0.2 };
      const preference = state.preferredIndex === null ? 0 : 0.03;
      const score =
        weights.quality * quality +
        weights.reliability * reliability +
        weights.speed * speed +
        preference;
      const reasons: string[] = [];
      if (state.quality) reasons.push(`benchmark:${state.quality.suite}`);
      if (state.capabilities.reasoning === 'declared') reasons.push('reasoning:declared');
      if (runtime.attempts > 0) reasons.push(`reliability:${runtime.successes}/${runtime.attempts}`);
      if (runtime.latencyMs > 0) reasons.push(`latency:${Math.round(runtime.latencyMs)}ms`);
      candidates.push({ model: state, score, reasons });
    }
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = a.model.preferredIndex ?? Number.MAX_SAFE_INTEGER;
      const pb = b.model.preferredIndex ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return modelKey(a.model.ref) < modelKey(b.model.ref) ? -1 : 1;
    });
    return candidates;
  }

  function qualityScore(state: ModelState, at: Date): number {
    const current =
      state.quality !== null &&
      state.qualityValidUntil !== null &&
      Date.parse(state.qualityValidUntil) > at.getTime();
    if (current && state.quality) {
      return clamp(0.65 * state.quality.coding + 0.35 * state.quality.reasoning, 0, 1);
    }
    return state.capabilities.reasoning === 'declared' ? 0.5 : 0.35;
  }

  function reliabilityScore(runtime: ModelRuntime): number {
    return (runtime.successes + 1) / (runtime.attempts + 2);
  }

  function speedScore(latencyMs: number): number {
    if (latencyMs <= 0) return 0.5;
    // Fast routing compares sub-second differences, so latency contributes over
    // a 200 ms scale rather than a full second.
    return clamp(1 / (1 + latencyMs / 200), 0, 1);
  }

  function failureDetail(mode: RoutingMode): string {
    return `No verified zero-cost model is available for ${mode} routing.`;
  }

  function policyRefusal(
    mode: DataMode,
    operation: ProcessingOperation,
    decision: Extract<PolicyDecision, { allowed: false }>,
  ): string {
    const detail = `External ${operation} processing was refused in ${mode} mode: ${decision.detail}`;
    return mode === 'private'
      ? `${detail} The engine fails closed; it does not substitute local inference.`
      : detail;
  }

  /**
   * A refusal detail that names the blocking policy dimension, without leaking a
   * provider endpoint or payload. It only inspects a model that is already free,
   * available and supported, so cost and health failures keep their own message.
   */
  function refusalDetail(
    routing: RoutingMode,
    input: { mode: DataMode; operation: ProcessingOperation },
    at: Date,
  ): string {
    const probe = [...models.values()].find(
      (runtime) =>
        runtime.state.supported &&
        runtime.state.costClass === 'free' &&
        modelAvailability(runtime, at).available,
    );
    if (!probe) return failureDetail(routing);
    const decision = policy.evaluate({
      providerId: probe.state.ref.providerId,
      operation: input.operation,
      mode: input.mode,
      at,
    });
    return decision.allowed ? failureDetail(routing) : policyRefusal(input.mode, input.operation, decision);
  }

  function plan(input: PlanningInput): { ok: true; value: RoutePlan } | {
    ok: false;
    code: ProblemCode;
    detail: string;
    retryable: boolean;
  } {
    const at = now();
    const mode = input.routing ?? 'auto';
    if (input.requested) {
      const runtime = models.get(modelKey(input.requested));
      if (!runtime) {
        if (input.allowFallback !== true) {
          return {
            ok: false,
            code: 'engine_not_configured',
            detail: 'That model is not in the verified catalogue.',
            retryable: false,
          };
        }
      } else if (runtime.state.costClass !== 'free') {
        // A paid request is never replaced by a free one, even with fallback on.
        return {
          ok: false,
          code: 'paid_model_refused',
          detail: 'Coderax does not route to paid models; choose a verified zero-cost model.',
          retryable: false,
        };
      } else {
        const availability = modelAvailability(runtime, at);
        const permission = policy.evaluate({
          providerId: runtime.state.ref.providerId,
          operation: input.operation,
          mode: input.mode,
          at,
        });
        const rejection = !availability.available
          ? availability.detail
          : !permission.allowed
            ? policyRefusal(input.mode, input.operation, permission)
            : input.requireVision && !runtime.state.capabilities.vision
            ? 'That model does not declare image input support.'
            : input.requireTools && !runtime.state.capabilities.toolCalling
              ? 'That model does not declare tool-calling support.'
              : !contextFits({
                    state: runtime.state,
                    ...(input.estimatedInputTokens === undefined
                      ? {}
                      : { estimatedInputTokens: input.estimatedInputTokens }),
                    ...(input.maxOutputTokens === undefined
                      ? {}
                      : { maxOutputTokens: input.maxOutputTokens }),
                  })
                ? "The request does not fit that model's verified context window."
                : null;
        if (rejection === null) {
          const candidate: RankedCandidate = {
            model: runtime.state,
            score: qualityScore(runtime.state, at),
            reasons: ['explicitly requested'],
          };
          if (input.allowFallback !== true) {
            return {
              ok: true,
              value: { mode, candidates: [candidate], fallbackAllowed: false },
            };
          }
          const others = eligible(input, at).filter(
            (entry) => modelKey(entry.model.ref) !== modelKey(runtime.state.ref),
          );
          return {
            ok: true,
            value: {
              mode,
              candidates: [candidate, ...others].slice(0, maxCandidates),
              fallbackAllowed: true,
            },
          };
        }
        if (input.allowFallback !== true) {
          return {
            ok: false,
            code: 'model_missing',
            detail: rejection,
            retryable: false,
          };
        }
      }
    }

    const candidates = eligible(input, at).slice(0, maxCandidates);
    if (candidates.length === 0) {
      return {
        ok: false,
        code: 'model_missing',
        detail: refusalDetail(mode, input, at),
        retryable: false,
      };
    }
    return {
      ok: true,
      value: { mode, candidates, fallbackAllowed: input.allowFallback !== false },
    };
  }

  function resolve(
    requested: ModelRef | null | undefined,
    mode: DataMode,
    resolveOptions: ResolveOptions,
  ): { ok: true; value: ModelDescriptor } | {
    ok: false;
    code: ProblemCode;
    detail: string;
    retryable: boolean;
  } {
    const at = now();
    const dataMode = mode;
    if (requested) {
      const runtime = models.get(modelKey(requested));
      if (!runtime) {
        return {
          ok: false,
          code: 'engine_not_configured',
          detail: 'That model is not in the verified catalogue.',
          retryable: false,
        };
      }
      if (runtime.state.costClass !== 'free') {
        return {
          ok: false,
          code: 'paid_model_refused',
          detail: 'Coderax does not route to paid models; choose a verified zero-cost model.',
          retryable: false,
        };
      }
      const permission = policy.evaluate({
        providerId: runtime.state.ref.providerId,
        operation: resolveOptions.operation,
        mode,
        at,
      });
      if (!permission.allowed) {
        return {
          ok: false,
          code: 'model_missing',
          detail: policyRefusal(mode, resolveOptions.operation, permission),
          retryable: false,
        };
      }
      const availability = modelAvailability(runtime, at);
      if (!availability.available) {
        return {
          ok: false,
          code: 'model_missing',
          detail: availability.detail,
          retryable: false,
        };
      }
      if (resolveOptions.requireVision && !runtime.state.capabilities.vision) {
        return {
          ok: false,
          code: 'model_missing',
          detail: 'That model does not declare image input support.',
          retryable: false,
        };
      }
      if (resolveOptions.requireTools && !runtime.state.capabilities.toolCalling) {
        return {
          ok: false,
          code: 'model_missing',
          detail: 'That model does not declare tool-calling support.',
          retryable: false,
        };
      }
      if (
        !contextFits({
          state: runtime.state,
          ...(resolveOptions.estimatedInputTokens === undefined
            ? {}
            : { estimatedInputTokens: resolveOptions.estimatedInputTokens }),
          ...(resolveOptions.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: resolveOptions.maxOutputTokens }),
        })
      ) {
        return {
          ok: false,
          code: 'model_missing',
          detail: "The request does not fit that model's verified context window.",
          retryable: false,
        };
      }
      return { ok: true, value: descriptorFor(runtime, at) };
    }

    const planned = plan({
      mode: dataMode,
      operation: resolveOptions.operation,
      routing: resolveOptions.routing ?? 'auto',
      ...(resolveOptions.estimatedInputTokens === undefined
        ? {}
        : { estimatedInputTokens: resolveOptions.estimatedInputTokens }),
      ...(resolveOptions.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: resolveOptions.maxOutputTokens }),
      ...(resolveOptions.requireVision ? { requireVision: true } : {}),
      ...(resolveOptions.requireTools ? { requireTools: true } : {}),
    });
    if (!planned.ok) return planned;
    const chosen = planned.value.candidates[0];
    if (!chosen) {
      return {
        ok: false,
        code: 'model_missing',
        detail: failureDetail(planned.value.mode),
        retryable: false,
      };
    }
    const runtime = models.get(modelKey(chosen.model.ref));
    if (!runtime) {
      return {
        ok: false,
        code: 'model_missing',
        detail: failureDetail(planned.value.mode),
        retryable: false,
      };
    }
    return { ok: true, value: descriptorFor(runtime, at) };
  }

  function list(): ModelList {
    const at = now();
    const descriptors = [...models.values()]
      .map((runtime) => descriptorFor(runtime, at))
      .sort((a, b) => (modelKey(a.ref) < modelKey(b.ref) ? -1 : 1));
    return {
      models: descriptors,
      route: route('auto'),
      allowPaid: false,
    };
  }

  function route(mode: RoutingMode = 'auto'): ModelRef[] {
    const at = now();
    // A discovery view, not an authorization. Execution always names its own
    // data mode and operation; this cloud/chat list is what the API publishes as
    // the default zero-cost route.
    return eligible({ mode: 'cloud', operation: 'chat', routing: mode }, at).map(
      (entry) => entry.model.ref,
    );
  }

  function recordSuccess(
    runtime: ModelRuntime,
    provider: ProviderRuntime,
    latencyMs: number,
    runtimeAdmission?: CircuitAdmission,
    providerAdmission?: CircuitAdmission,
  ): void {
    runtime.attempts += 1;
    runtime.successes += 1;
    runtime.consecutiveFailures = 0;
    runtime.latencyMs = ewma(runtime.latencyMs, latencyMs);
    runtime.circuit.success(runtimeAdmission);
    provider.latencyMs = ewma(provider.latencyMs, latencyMs);
    provider.circuit.success(providerAdmission);
    provider.lastError = null;
  }

  function recordFailure(
    failure: AttemptFailure,
    at: Date,
    runtimeAdmission?: CircuitAdmission,
    providerAdmission?: CircuitAdmission,
  ): void {
    const { runtime, provider, error } = failure;
    runtime.attempts += 1;
    runtime.failures += 1;
    runtime.consecutiveFailures += 1;
    runtime.lastFailureAt = at;
    runtime.circuit.failure(at, runtimeAdmission);
    provider.circuit.failure(at, providerAdmission);
    provider.lastError = sanitizeDetail(error.message);
    const boundedDelay = (delay: number): number =>
      Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(1_000, delay));
    if (error.kind === 'quota') {
      // Daily free allowances reset at UTC midnight; a header reset is more precise
      // when the provider publishes one.
      const delay = error.retryAfterMs ?? msUntilUtcMidnight(at);
      provider.quotaUntil = new Date(at.getTime() + boundedDelay(delay));
      provider.lastError = 'The provider reports its free allowance is exhausted.';
    } else if (error.kind === 'rate_limit' && error.retryAfterMs !== undefined) {
      // A provider that publishes a retry window should not be called again
      // immediately just because the local token bucket has capacity.
      provider.quotaUntil = new Date(at.getTime() + boundedDelay(error.retryAfterMs));
    }
    if (error.kind === 'auth') {
      provider.lastError = 'The provider rejected the configured credential.';
      provider.discoveryOk = false;
    }
  }

  function outputBudget(request: GatewayRequest, state: ModelState): number {
    const requested = request.maxOutputTokens ?? defaultMaxOutput;
    return Math.max(1, Math.min(requested, state.maxOutputTokens ?? defaultMaxOutput));
  }

  function estimateRequest(request: GatewayRequest): number {
    const messages =
      request.messages && request.messages.length > 0
        ? estimateMessageTokens(request.messages) + estimateTokens([request.system])
        : estimateTokens([request.system, request.prompt]);
    // Tool declarations are part of the prompt the provider receives. Omitting
    // them would under-reserve both context and daily token budget.
    const tools = request.tools?.length
      ? estimateTokens(request.tools.map((tool) => JSON.stringify(tool)))
      : 0;
    return messages + tools;
  }

  async function executeComplete(
    request: GatewayRequest,
    planned: RoutePlan,
  ): Promise<GatewayCompletion> {
    const attempts: ModelRef[] = [];
    let lastFailure: ProviderError | null = null;
    let budgetRefusal: string | null = null;
    let lastDispatchFailure: ProviderError | null = null;
    const executed = planned.fallbackAllowed
      ? planned.candidates.slice(0, 1 + maxFallbacks)
      : planned.candidates.slice(0, 1);

    for (const candidate of executed) {
      if (request.signal.aborted) {
        throw new ModelRoutingError('cancelled', 'The run was cancelled.', false);
      }
      const runtime = models.get(modelKey(candidate.model.ref));
      if (!runtime) continue;
      const provider = providers.get(runtime.state.ref.providerId);
      if (!provider) continue;
      const at = now();
      if (!modelAvailability(runtime, at).available) continue;
      // Revalidate policy at dispatch, not only at planning: a grant can expire
      // or be withdrawn between the two, and fallback must never widen it.
      const permission = policy.evaluate({
        providerId: runtime.state.ref.providerId,
        operation: request.operation,
        mode: request.mode,
        at,
      });
      if (!permission.allowed) continue;

      const estimated = estimateRequest(request);
      const output = outputBudget(request, runtime.state);
      if (!contextFits({ state: runtime.state, estimatedInputTokens: estimated, maxOutputTokens: output })) {
        lastFailure = new ProviderError('context', 'The request does not fit the verified context window.', {
          retryable: true,
        });
        continue;
      }
      // Reserve the daily budget before consuming provider rate-limit capacity.
      // A request the owner cannot afford must not make the provider unusable.
      const reserved = await budget.reserve({
        ownerId: request.ownerId,
        at,
        inputTokens: estimated,
        outputTokens: output,
      });
      if (!reserved.allowed) {
        if (reserved.reason === 'tokens' && planned.fallbackAllowed) {
          // Another free candidate may have a smaller output cap and fit the
          // remaining daily allowance. Try it before declaring exhaustion.
          budgetRefusal = reserved.detail;
          continue;
        }
        throw new ModelRoutingError('budget_exhausted', reserved.detail, false);
      }
      const runtimeAdmission = runtime.circuit.allow(at);
      if (!runtimeAdmission) {
        await budget.release(reserved.reservation.id);
        continue;
      }
      const providerAdmission = provider.circuit.allow(at);
      if (!providerAdmission) {
        await budget.release(reserved.reservation.id);
        runtime.circuit.abandon(runtimeAdmission);
        continue;
      }
      const acquired = provider.limiter.acquire({
        tokens: estimated + output,
        now: at,
      });
      if (acquired.allowed) noteUsage(provider, at);
      if (!acquired.allowed) {
        await budget.release(reserved.reservation.id);
        runtime.circuit.abandon(runtimeAdmission);
        provider.circuit.abandon(providerAdmission);
        lastFailure = new ProviderError(
          'rate_limit',
          `The local provider ${acquired.reason} ceiling is already in use.`,
          { retryAfterMs: acquired.retryAfterMs, retryable: true },
        );
        continue;
      }

      attempts.push(runtime.state.ref);
      const started = performance.now();
      let dispatched = false;
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(provider.settings.requestTimeoutMs),
      ]);
      try {
        dispatched = true;
        const completion = await provider.adapter.complete({
          model: runtime.state.ref,
          system: request.system,
          prompt: request.prompt,
          ...(request.messages === undefined ? {} : { messages: request.messages }),
          ...(request.tools === undefined ? {} : { tools: request.tools }),
          signal,
          maxOutputTokens: output,
          temperature: 0,
        });
        const latencyMs = Math.max(0, performance.now() - started);
        acquired.release();
        await budget.settle(reserved.reservation.id, completion.usage ?? {
          inputTokens: estimated,
          outputTokens: output,
        });
        noteUsage(
          provider,
          at,
          completion.usage ?? { inputTokens: estimated, outputTokens: output },
        );
        recordSuccess(runtime, provider, latencyMs, runtimeAdmission, providerAdmission);
        return {
          text: completion.text,
          ...(completion.usage === undefined ? {} : { usage: completion.usage }),
          toolCalls: completion.toolCalls,
          model: runtime.state.ref,
          attempts,
          latencyMs,
        };
      } catch (error) {
        acquired.release();
        // The provider may already have received this request. Charge the
        // request slot, but return the token allowance that was not reported.
        await budget.release(reserved.reservation.id, { dispatched });
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError('network', 'The inference provider could not be reached.', {
                retryable: true,
              });
        if (providerError.kind === 'cancelled' || request.signal.aborted) {
          runtime.circuit.abandon(runtimeAdmission);
          provider.circuit.abandon(providerAdmission);
          throw new ModelRoutingError('cancelled', 'The run was cancelled.', false);
        }
        recordFailure(
          { error: providerError, provider, runtime },
          now(),
          runtimeAdmission,
          providerAdmission,
        );
        lastDispatchFailure = providerError;
      }
    }

    if (budgetRefusal !== null && lastDispatchFailure === null) {
      throw new ModelRoutingError('budget_exhausted', budgetRefusal, false);
    }
    lastFailure = lastDispatchFailure ?? lastFailure;
    throw new ModelRoutingError(
      'engine_unavailable',
      lastFailure === null
        ? 'Every verified zero-cost candidate was unavailable.'
        : `No verified zero-cost candidate completed the request: ${sanitizeDetail(lastFailure.message)}`,
      lastFailure?.retryable ?? false,
    );
  }

  async function* executeStream(
    request: GatewayRequest,
    planned: RoutePlan,
  ): AsyncGenerator<GatewayStreamEvent> {
    const executed = planned.fallbackAllowed
      ? planned.candidates.slice(0, 1 + maxFallbacks)
      : planned.candidates.slice(0, 1);
    const attempts: ModelRef[] = [];
    let lastFailure: ProviderError | null = null;
    let budgetRefusal: string | null = null;
    let lastDispatchFailure: ProviderError | null = null;

    for (const candidate of executed) {
      if (request.signal.aborted) {
        throw new ModelRoutingError('cancelled', 'The run was cancelled.', false);
      }
      let runtime = models.get(modelKey(candidate.model.ref));
      if (!runtime) continue;
      const provider = providers.get(runtime.state.ref.providerId);
      if (!provider) continue;
      const at = now();
      if (!modelAvailability(runtime, at).available) continue;
      const permission = policy.evaluate({
        providerId: runtime.state.ref.providerId,
        operation: request.operation,
        mode: request.mode,
        at,
      });
      if (!permission.allowed) continue;

      const estimated = estimateRequest(request);
      const output = outputBudget(request, runtime.state);
      if (!contextFits({ state: runtime.state, estimatedInputTokens: estimated, maxOutputTokens: output })) {
        lastFailure = new ProviderError('context', 'The request does not fit the verified context window.', {
          retryable: true,
        });
        continue;
      }
      // Daily budget admission comes first so a denied request cannot consume a
      // provider request token or claim a half-open probe.
      const reserved = await budget.reserve({
        ownerId: request.ownerId,
        at,
        inputTokens: estimated,
        outputTokens: output,
      });
      if (!reserved.allowed) {
        if (reserved.reason === 'tokens' && planned.fallbackAllowed) {
          budgetRefusal = reserved.detail;
          continue;
        }
        throw new ModelRoutingError('budget_exhausted', reserved.detail, false);
      }
      const runtimeAdmission = runtime.circuit.allow(at);
      if (!runtimeAdmission) {
        await budget.release(reserved.reservation.id);
        continue;
      }
      const providerAdmission = provider.circuit.allow(at);
      if (!providerAdmission) {
        await budget.release(reserved.reservation.id);
        runtime.circuit.abandon(runtimeAdmission);
        continue;
      }
      const acquired = provider.limiter.acquire({ tokens: estimated + output, now: at });
      if (acquired.allowed) noteUsage(provider, at);
      if (!acquired.allowed) {
        await budget.release(reserved.reservation.id);
        runtime.circuit.abandon(runtimeAdmission);
        provider.circuit.abandon(providerAdmission);
        lastFailure = new ProviderError('rate_limit', 'The local provider ceiling is already in use.', {
          retryAfterMs: acquired.retryAfterMs,
          retryable: true,
        });
        continue;
      }

      let settled = false;
      let providerStarted = false;
      attempts.push(runtime.state.ref);
      let emitted = false;
      let usage: Usage | undefined;
      const started = performance.now();
      const providerAbort = new AbortController();
      const signal = AbortSignal.any([
        request.signal,
        providerAbort.signal,
        AbortSignal.timeout(provider.settings.requestTimeoutMs),
      ]);
      const providerRequest = {
        model: runtime.state.ref,
        system: request.system,
        prompt: request.prompt,
        ...(request.messages === undefined ? {} : { messages: request.messages }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        signal,
        maxOutputTokens: output,
        temperature: 0,
      };

      try {
        yield { type: 'model', model: runtime.state.ref, attempts: [...attempts], latencyMs: 0 };
        // The metadata yield suspends the generator; a discovery refresh can run
        // before the provider call. Revalidate eligibility at the last moment.
        const revalidated = models.get(modelKey(runtime.state.ref));
        const revalidatedAt = now();
        const revalidatedPolicy =
          revalidated === undefined
            ? null
            : policy.evaluate({
                providerId: revalidated.state.ref.providerId,
                operation: request.operation,
                mode: request.mode,
                at: revalidatedAt,
              });
        if (
          !revalidated ||
          !modelAvailability(revalidated, revalidatedAt).available ||
          revalidatedPolicy === null ||
          !revalidatedPolicy.allowed ||
          output > outputBudget(request, revalidated.state) ||
          !contextFits({ state: revalidated.state, estimatedInputTokens: estimated, maxOutputTokens: output }) ||
          ((request.tools?.length ?? 0) > 0 && !revalidated.state.capabilities.toolCalling) ||
          (request.messages?.some((message) => (message.images?.length ?? 0) > 0) &&
            !revalidated.state.capabilities.vision)
        ) {
          acquired.release({ dispatched: false });
          await budget.release(reserved.reservation.id);
          runtime.circuit.abandon(runtimeAdmission);
          provider.circuit.abandon(providerAdmission);
          settled = true;
          lastFailure = new ProviderError(
            'invalid',
            'The verified-free route changed before the stream was dispatched.',
            { retryable: false },
          );
          continue;
        }
        if (signal.aborted) {
          throw new ProviderError('cancelled', 'The inference stream was cancelled before dispatch.', { retryable: false });
        }
        providerStarted = true;
        runtime = revalidated;
        const events = provider.adapter.stream
          ? provider.adapter.stream(providerRequest)
          : synthesize(provider.adapter.complete(providerRequest));
        for await (const event of events) {
          if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool') {
            emitted = true;
          }
          if (event.type === 'usage') usage = event.usage;
          yield event;
        }
        const latencyMs = Math.max(0, performance.now() - started);
        settled = true;
        acquired.release();
        await budget.settle(
          reserved.reservation.id,
          usage ?? { inputTokens: estimated, outputTokens: emitted ? output : 0 },
        );
        noteUsage(provider, at, usage ?? { inputTokens: estimated, outputTokens: emitted ? output : 0 });
        recordSuccess(runtime, provider, latencyMs, runtimeAdmission, providerAdmission);
        return;
      } catch (error) {
        acquired.release({ dispatched: providerStarted });
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError('network', 'The inference provider stream failed.', {
                retryable: true,
              });
        if (providerError.kind === 'cancelled' || request.signal.aborted) {
          if (emitted) {
            await budget.settle(
              reserved.reservation.id,
              usage ?? { inputTokens: estimated, outputTokens: output },
            );
          } else {
            // The attempt may have reached the provider, so retain the request
            // charge while returning the unused token allowance.
            await budget.release(reserved.reservation.id, { dispatched: providerStarted });
          }
          settled = true;
          runtime.circuit.abandon(runtimeAdmission);
          provider.circuit.abandon(providerAdmission);
          throw new ModelRoutingError('cancelled', 'The run was cancelled.', false);
        }
        recordFailure(
          { error: providerError, provider, runtime },
          now(),
          runtimeAdmission,
          providerAdmission,
        );
        if (emitted) {
          // Output already reached the caller; switching models would duplicate it.
          await budget.settle(
            reserved.reservation.id,
            usage ?? { inputTokens: estimated, outputTokens: output },
          );
          settled = true;
          throw new ModelRoutingError(
            'engine_unavailable',
            'The provider stream failed after output started; it cannot be safely replaced.',
            false,
          );
        }
        await budget.release(reserved.reservation.id, { dispatched: providerStarted });
        settled = true;
        lastDispatchFailure = providerError;
      } finally {
        // A consumer can stop iterating before the provider finishes. Release the
        // provider slot and account for the work already started; otherwise the
        // concurrency ceiling and the reservation would leak for the rest of the day.
        if (!settled) {
          // Stop the upstream body before making the local slot available again;
          // releasing the reader lock alone does not close the connection.
          providerAbort.abort();
          runtime.circuit.abandon(runtimeAdmission);
          provider.circuit.abandon(providerAdmission);
          acquired.release({ dispatched: providerStarted });
          if (providerStarted) {
            await budget.settle(
              reserved.reservation.id,
              usage ?? { inputTokens: estimated, outputTokens: emitted ? output : 0 },
            );
          } else {
            await budget.release(reserved.reservation.id);
          }
        }
      }
    }

    if (budgetRefusal !== null && lastDispatchFailure === null) {
      throw new ModelRoutingError('budget_exhausted', budgetRefusal, false);
    }
    lastFailure = lastDispatchFailure ?? lastFailure;
    throw new ModelRoutingError(
      'engine_unavailable',
      lastFailure === null
        ? 'Every verified zero-cost candidate was unavailable.'
        : `No verified zero-cost candidate completed the request: ${sanitizeDetail(lastFailure.message)}`,
      lastFailure?.retryable ?? false,
    );
  }

  async function refresh(): Promise<RefreshReport> {
    if (refreshing) return refreshing;
    refreshing = runRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function runRefresh(): Promise<RefreshReport> {
    const at = now();
    const report: RefreshReport = { at: at.toISOString(), providers: [], verifiedFree: 0 };
    const next = new Map<string, ModelRuntime>();
    const discoveredByProvider = new Map<string, DiscoveredModel[]>();
    const failedProviders = new Set<string>();

    await Promise.all(
      [...providers.entries()].map(async ([providerId, provider]) => {
        try {
          const discovered = await provider.adapter.discover(
            AbortSignal.timeout(Math.min(provider.settings.requestTimeoutMs, 30_000)),
          );
          provider.lastDiscoveryAt = at;
          provider.discoveryOk = true;
          provider.lastError = null;
          // Discovery proves the model list is readable, not that inference has
          // recovered. Only a successful inference probe closes that circuit.
          discoveredByProvider.set(providerId, discovered);
          report.providers.push({
            providerId,
            ok: true,
            models: discovered.length,
            verifiedFree: 0,
          });
        } catch (error) {
          failedProviders.add(providerId);
          provider.discoveryOk = false;
          provider.verifiedFree = 0;
          provider.lastError = sanitizeDetail(
            error instanceof Error ? error.message : 'Provider discovery failed.',
          );
          // Discovery health is separate from inference health; discoveryOk
          // already excludes the provider, and an inference probe recovers it.
          report.providers.push({
            providerId,
            ok: false,
            models: 0,
            verifiedFree: 0,
            detail: provider.lastError,
          });
        }
      }),
    );

    let verifiedFree = 0;
    for (const [providerId, discovered] of discoveredByProvider) {
      const provider = providers.get(providerId);
      if (!provider) continue;
      let providerFree = 0;
      for (const model of discovered) {
        const verdict = verifyFreeTier({ model, attestations, now: at });
        const score = scoreFor(benchmarks, model, at, benchmarkMaxAgeMs);
        const capabilities = classifyCapabilities({ discovered: model, score });
        const contextTokens =
          typeof model.contextTokens === 'number' && model.contextTokens > 0
            ? model.contextTokens
            : null;
        const previous = models.get(modelKey(model.ref));
        const supported =
          verdict.costClass === 'free' &&
          contextTokens !== null &&
          model.deprecated !== true &&
          provider.discoveryOk;
        const availability: ModelState['availability'] = supported
          ? { available: true, reason: 'ready', detail: 'Verified zero-cost endpoint is ready.' }
          : {
              available: false,
              reason: 'model_missing',
              detail:
                verdict.costClass !== 'free'
                  ? verdict.detail
                  : contextTokens === null
                    ? 'The provider did not publish a usable context window.'
                    : model.deprecated === true
                      ? 'The provider marks this model as deprecated.'
                      : 'The provider is not currently healthy.',
            };
        const state: ModelState = {
          ref: model.ref,
          label: model.label,
          costClass: verdict.costClass,
          costBasis: verdict.basis,
          costDetail: verdict.detail,
          costExpiresAt: verdict.expiresAt ?? null,
          contextTokens,
          maxOutputTokens:
            typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
              ? model.maxOutputTokens
              : null,
          capabilities,
          quality: score,
          qualityValidUntil:
            score === null
              ? null
              : new Date(Date.parse(score.measuredAt) + benchmarkMaxAgeMs).toISOString(),
          supported,
          availability,
          discoveredAt: at.toISOString(),
          preferredIndex: preferredIndexFor(model.ref),
        };
        if (verdict.costClass === 'free' && supported) {
          providerFree += 1;
          verifiedFree += 1;
        }
        next.set(modelKey(model.ref), {
          state,
          circuit: previous?.circuit ?? createCircuit({ failureThreshold, cooldownMs }),
          attempts: previous?.attempts ?? 0,
          successes: previous?.successes ?? 0,
          failures: previous?.failures ?? 0,
          consecutiveFailures: previous?.consecutiveFailures ?? 0,
          latencyMs: previous?.latencyMs ?? 0,
          lastFailureAt: previous?.lastFailureAt ?? null,
        });
      }
      provider.verifiedFree = providerFree;
      const entry = report.providers.find((item) => item.providerId === providerId);
      if (entry) entry.verifiedFree = providerFree;
    }

    // A failed discovery does not leave stale models routable: keep them visible
    // as unavailable so the owner can see what dropped out, but exclude them.
    for (const [key, previous] of models) {
      if (next.has(key)) continue;
      const providerId = previous.state.ref.providerId;
      if (!failedProviders.has(providerId)) continue;
      next.set(key, {
        ...previous,
        state: {
          ...previous.state,
          supported: false,
          availability: {
            available: false,
            reason: 'server_unavailable',
            detail: 'Provider discovery failed; this endpoint is excluded until it recovers.',
          },
        },
      });
    }

    models = next;
    report.verifiedFree = verifiedFree;
    return report;
  }

  function report(mode: RoutingMode): RoutingReport {
    const at = now();
    const statuses: ProviderStatus[] = [];
    for (const [providerId, provider] of providers) {
      const quota = {
        requestsPerMinute: provider.settings.requestsPerMinute,
        requestsPerDay: provider.settings.requestsPerDay ?? 500,
        tokensPerDay: provider.settings.tokensPerDay ?? 500_000,
      };
      const entries = [...models.values()].filter(
        (runtime) => runtime.state.ref.providerId === providerId,
      );
      const modelsOf: RouterModel[] = entries.map((runtime) => ({
        ref: runtime.state.ref,
        label: runtime.state.label,
        providerId,
        costClass: runtime.state.costClass,
        capabilities: {
          // A benchmark measures coding and reasoning; a missing score is neutral
          // evidence, not a claim that the model is good at either.
          coding: runtime.state.quality?.coding ?? 0.5,
          reasoning: runtime.state.quality?.reasoning ?? 0.5,
          speed: 0.5,
          toolCalling: runtime.state.capabilities.toolCalling,
          multimodal: runtime.state.capabilities.vision,
          contextTokens: runtime.state.contextTokens ?? 8_192,
        },
        availability: modelAvailability(runtime, at),
        requestsRemaining: Math.max(0, quota.requestsPerDay - provider.usedRequests),
        tokensRemaining: Math.max(0, quota.tokensPerDay - provider.usedTokens),
      }));
      statuses.push({
        id: providerId,
        costEvidence: provider.verifiedFree > 0 ? 'verified-free' : 'unverified',
        quota,
        used: {
          requestsThisMinute: provider.recentRequests.filter(
            (instant) => instant >= at.getTime() - 60_000,
          ).length,
          requestsToday: provider.usedRequests,
          tokensToday: provider.usedTokens,
        },
        models: modelsOf,
      });
    }
    return {
      mode,
      providers: statuses,
      route: route(mode),
      allowPaid: false,
    };
  }

  function health(): RouterHealth {
    const at = now();
    return {
      verifiedFree: [...models.values()].filter(
        (runtime) => runtime.state.supported && modelAvailability(runtime, at).available,
      ).length,
      route: route('auto'),
      providers: [...providers.entries()].map(([providerId, provider]) => ({
        providerId,
        available: providerAvailable(provider, at),
        lastDiscoveryAt: provider.lastDiscoveryAt?.toISOString() ?? null,
        lastError: provider.lastError,
        latencyMs: Math.round(provider.latencyMs),
        verifiedFreeModels: provider.verifiedFree,
        quotaUntil:
          provider.quotaUntil !== null && provider.quotaUntil.getTime() > at.getTime()
            ? provider.quotaUntil.toISOString()
            : null,
        circuit: provider.circuit.state(at),
        usedRequests: provider.usedRequests,
        usedTokens: provider.usedTokens,
        requestsThisMinute: provider.recentRequests.filter(
          (instant) => instant >= at.getTime() - 60_000,
        ).length,
      })),
      models: [...models.values()].map((runtime): ModelHealth => ({
        ref: runtime.state.ref,
        available: modelAvailability(runtime, at).available,
        attempts: runtime.attempts,
        successes: runtime.successes,
        failures: runtime.failures,
        consecutiveFailures: runtime.consecutiveFailures,
        latencyMs: Math.round(runtime.latencyMs),
        circuit: runtime.circuit.state(at),
        lastFailureAt: runtime.lastFailureAt?.toISOString() ?? null,
      })),
    };
  }

  function hasVerifiedFreeRoute(): boolean {
    // Readiness must use the same default context/output admission as route(),
    // and it must not require cloud authorization: a deployment approved only for
    // private processing is usable, while one with no authorized mode is not.
    const at = now();
    const readiness = { operation: 'chat' as const, routing: 'auto' as const };
    return (
      eligible({ mode: 'cloud', ...readiness }, at).length > 0 ||
      eligible({ mode: 'private', ...readiness }, at).length > 0
    );
  }

  return {
    id: 'coderax-model-router',
    list,
    route,
    report,
    resolve,
    plan,
    refresh,
    health,
    hasVerifiedFreeRoute,
    start: () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void refresh().catch(() => undefined);
      }, discoveryIntervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    complete: async (request) => {
      const estimated = estimateRequest(request);
      const planned = plan({
        requested: request.model,
        mode: request.mode,
        operation: request.operation,
        routing: request.routing ?? 'auto',
        estimatedInputTokens: estimated,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        allowFallback: request.allowFallback === true,
        ...(request.tools && request.tools.length > 0 ? { requireTools: true } : {}),
        ...(request.messages?.some((message) => (message.images?.length ?? 0) > 0)
          ? { requireVision: true }
          : {}),
      });
      if (!planned.ok) {
        throw new ModelRoutingError(planned.code, planned.detail, planned.retryable);
      }
      return executeComplete(request, planned.value);
    },
    stream: async function* (request): AsyncGenerator<GatewayStreamEvent> {
      const estimated = estimateRequest(request);
      const planned = plan({
        requested: request.model,
        mode: request.mode,
        operation: request.operation,
        routing: request.routing ?? 'auto',
        estimatedInputTokens: estimated,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        allowFallback: request.allowFallback === true,
        ...(request.tools && request.tools.length > 0 ? { requireTools: true } : {}),
        ...(request.messages?.some((message) => (message.images?.length ?? 0) > 0)
          ? { requireVision: true }
          : {}),
      });
      if (!planned.ok) {
        throw new ModelRoutingError(planned.code, planned.detail, planned.retryable);
      }
      yield* executeStream(request, planned.value);
    },
  };
}

async function* synthesize(
  completion: Promise<ProviderCompletion>,
): AsyncGenerator<ProviderStreamEvent> {
  const result = await completion;
  if (result.text.length > 0) yield { type: 'text', text: result.text };
  for (const call of result.toolCalls) yield { type: 'tool', call };
  if (result.usage) yield { type: 'usage', usage: result.usage };
  yield {
    type: 'done',
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
  };
}

export type ModelCatalog = Pick<ModelRouter, 'list' | 'route' | 'resolve'>;

export type ModelProviderRegistration = RegisteredProvider;

export type { ProviderAdapter, ProviderSettings, ToolSpec };
