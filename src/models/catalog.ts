import type {
  DataMode,
  ModelDescriptor,
  ModelList,
  ModelRef,
  ProblemCode,
  RoutingReport,
  RoutingMode,
} from '@coderax/contracts';
import type { ProcessingOperation } from './policy.js';
import type { ModelRouter } from './router.js';

/**
 * The catalogue is a projection of the single router, never a selector.
 *
 * It exists so the API, the service and the SDK read one consistent view — the
 * model list, a resolved descriptor and the routing report — without reaching
 * into routing internals. Nothing here chooses a model: `resolve` delegates to
 * the router's own verified-free plan, and every path therefore passes the same
 * cost, policy, capability and budget gates.
 */

export type ResolveResult =
  | { ok: true; value: ModelDescriptor }
  | { ok: false; code: ProblemCode; detail: string; retryable: boolean };

export type ProviderQuota = {
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
};

export type ModelCatalog = {
  list: () => ModelList;
  /**
   * The operation is part of the resolution because provider authorization is
   * granted per operation; a chat resolution must not inherit a work grant.
   */
  resolve: (
    requested: ModelRef | null | undefined,
    mode: DataMode,
    operation?: ProcessingOperation,
  ) => ResolveResult;
  report: (mode: RoutingMode) => Promise<RoutingReport>;
};

/**
 * A capability class is evidence strength, while the published report is a
 * normalized score. Nothing here upgrades a declaration into proof.
 */
function capabilityScore(value: 'verified' | 'declared' | 'unknown'): number {
  if (value === 'verified') return 1;
  if (value === 'declared') return 0.5;
  return 0;
}

export function createRouterCatalog(input: {
  router: ModelRouter;
  /** Configured provider ceilings, keyed by provider id. */
  quotas: ReadonlyMap<string, ProviderQuota>;
  /** The owner-day usage the durable ledger has recorded. */
  usage: () => Promise<{ requests: number; tokens: number }>;
}): ModelCatalog {
  return {
    list: () => input.router.list(),

    resolve: (requested, mode, operation = 'chat') =>
      input.router.resolve(requested, mode, { operation }),

    report: async (mode) => {
      const health = input.router.health();
      const used = await input.usage();
      return {
        mode,
        allowPaid: false,
        route: input.router.route(mode),
        providers: health.providers.map((provider) => {
          const quota = input.quotas.get(provider.providerId);
          const requestsPerDay = Math.max(1, quota?.requestsPerDay ?? 1);
          const tokensPerDay = Math.max(1, quota?.tokensPerDay ?? 1);
          return {
            id: provider.providerId,
            costEvidence: provider.verifiedFreeModels > 0 ? 'verified-free' : 'unverified',
            quota: {
              requestsPerMinute: Math.max(
                1,
                quota?.requestsPerMinute ?? provider.requestsPerMinute,
              ),
              requestsPerDay,
              tokensPerDay,
            },
            used: {
              requestsThisMinute: provider.requestsThisMinute,
              requestsToday: used.requests,
              tokensToday: used.tokens,
            },
            models: health.models
              .filter((model) => model.ref.providerId === provider.providerId)
              .map((model) => ({
                ref: model.ref,
                label: model.label,
                providerId: model.ref.providerId,
                costClass: model.costClass,
                capabilities: {
                  contextTokens: model.contextTokens ?? 0,
                  toolCalling: model.capabilities.toolCalling,
                  coding: capabilityScore(model.capabilities.coding),
                  reasoning: capabilityScore(model.capabilities.reasoning),
                  speed: 0.5,
                  multimodal: model.capabilities.vision,
                },
                availability: model.availability,
                // Remaining allowance is the account's shared daily quota minus
                // what this owner has already consumed, never a per-model guess.
                requestsRemaining: Math.max(0, requestsPerDay - used.requests),
                tokensRemaining: Math.max(0, tokensPerDay - used.tokens),
              })),
          };
        }),
      };
    },
  };
}
