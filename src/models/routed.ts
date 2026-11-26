import type { ModelGateway, ModelCompletionRequest } from '../agents/native/types.js';
import type { ProviderModel, Router } from './router.js';

/**
 * A gateway that speaks to the router instead of one endpoint.
 *
 * The requested model is honoured when it is eligible. Otherwise the router's
 * ranked free route decides. A retryable provider failure (rate limit, timeout,
 * 5xx) falls back to the next approved free model, bounded by `maxFallbacks`; an
 * authentication, validation or abort failure never falls back, because retrying
 * it elsewhere would hide the real problem. When no candidate remains the call
 * fails closed with a stable message the agent maps to `model_missing`.
 */

export const NO_ELIGIBLE_MODEL =
  'No verified zero-cost model is available for this request; the engine fails closed.';
export const ALL_MODELS_FAILED =
  'Every eligible zero-cost model failed; the engine fails closed.';

export function isRouterExhausted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === NO_ELIGIBLE_MODEL || error.message === ALL_MODELS_FAILED)
  );
}

/** Provider errors that are safe to try elsewhere; everything else is not. */
export function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/abort/i.test(message)) return false;
  if (/HTTP (?:401|403|404|422)\b/.test(message)) return false;
  if (/HTTP (?:408|425|429|5\d\d)\b/.test(message)) return true;
  return /timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i.test(
    message,
  );
}

export function createRoutedGateway(input: {
  router: Router;
  /** One gateway per provider id; a provider without one is simply not a candidate. */
  gateways: ReadonlyMap<string, ModelGateway>;
  maxFallbacks: number;
  now?: () => Date;
}): ModelGateway {
  const at = input.now ?? (() => new Date());

  return {
    id: 'coderax-router',
    complete: async (request: ModelCompletionRequest) => {
      const selected = input.router.select({
        mode: request.routingMode ?? 'auto',
        ...(request.model ? { requested: request.model } : {}),
        ...(request.requiresTools ? { requireTools: true } : {}),
        ...(request.requiresVision ? { requireVision: true } : {}),
      });
      if (!selected.ok) throw new Error(NO_ELIGIBLE_MODEL);

      const candidates: ProviderModel[] = [
        selected.value,
        ...input.router.fallbacks(
          selected.value,
          {
            mode: request.routingMode ?? 'auto',
            requireTools: request.requiresTools ?? false,
            requireVision: request.requiresVision ?? false,
          },
          input.maxFallbacks,
        ),
      ];

      for (const candidate of candidates) {
        if (request.signal.aborted) throw new Error('The request was aborted.');
        const gateway = input.gateways.get(candidate.ref.providerId);
        if (!gateway) continue;

        const reserved = input.router.reserve(candidate, at());
        if (!reserved.ok) continue;

        try {
          const completion = await gateway.complete({ ...request, model: candidate.ref });
          input.router.recordUsage(candidate, completion.usage ?? {}, at());
          return completion;
        } catch (error) {
          if (request.signal.aborted) throw error;
          // Only an approved free model is ever tried, so retrying here can never
          // reach a paid provider; the bound is the number of approved models.
          if (!isRetryableProviderError(error)) throw error;
        }
      }

      throw new Error(ALL_MODELS_FAILED);
    },
  };
}
