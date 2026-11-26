import type { ModelGateway, ModelCompletionRequest } from '../agents/native/types.js';
import type { BudgetLedger } from './budget.js';
import type { ProviderModel, Router } from './router.js';
import { accountUsage, estimateRequestTokens } from './tokens.js';

/**
 * A gateway that speaks to the router instead of one endpoint.
 *
 * The requested model is honoured when it is eligible. Otherwise the router's
 * ranked free route decides. A retryable provider failure (rate limit, timeout,
 * 5xx) falls back to the next verified-free model, bounded by `maxFallbacks`; an
 * authentication, validation or abort failure never falls back, because retrying
 * it elsewhere would hide the real problem. When no candidate remains the call
 * fails closed with a stable message the agent maps to `model_missing`.
 *
 * Every attempt reserves its estimated input tokens (system, prompt and tool
 * schema) before dispatch and is settled with the provider's reported usage
 * afterwards, so a budget cannot be overrun by a request that is already in
 * flight. A failed attempt releases its reservation instead of charging it.
 */

export const NO_ELIGIBLE_MODEL =
  'No verified zero-cost model is available for this request; the engine fails closed.';
export const ALL_MODELS_FAILED =
  'Every eligible zero-cost model failed; the engine fails closed.';
export const BUDGET_EXHAUSTED =
  'The daily zero-cost token budget cannot cover this request; the engine fails closed.';

export function isRouterExhausted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === NO_ELIGIBLE_MODEL || error.message === ALL_MODELS_FAILED)
  );
}

export function isBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && error.message === BUDGET_EXHAUSTED;
}

/** Provider errors that are safe to try elsewhere; everything else is not. */
export function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/abort/i.test(message)) return false;
  if (/HTTP (?:401|402|403|404|422)\b/.test(message)) return false;
  if (/HTTP (?:408|425|429|5\d\d)\b/.test(message)) return true;
  return /timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i.test(
    message,
  );
}

/** A provider's own retry window, when the failure carried one. */
export function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createRoutedGateway(input: {
  router: Router;
  /** One gateway per provider id; a provider without one is simply not a candidate. */
  gateways: ReadonlyMap<string, ModelGateway>;
  maxFallbacks: number;
  budget?: BudgetLedger;
  now?: () => Date;
}): ModelGateway {
  const at = input.now ?? (() => new Date());

  return {
    id: 'coderax-router',
    complete: async (request: ModelCompletionRequest) => {
      const estimate = estimateRequestTokens({
        system: request.system,
        prompt: request.prompt,
        ...(request.toolSchemaText ? { toolSchemaText: request.toolSchemaText } : {}),
      });
      // An image is not free to the provider's token counter either. Reserve a
      // conservative flat amount per image so a visual turn cannot appear cheaper
      // than a text-only one in the local quota.
      const imageTokens = (request.images?.length ?? 0) * 1024;
      const estimatedInput = estimate.total + imageTokens;
      const needsVision = request.requiresVision === true || imageTokens > 0;
      const requested = input.router.select({
        mode: request.routingMode ?? 'auto',
        ...(request.model ? { requested: request.model } : {}),
        ...(request.requiresTools ? { requireTools: true } : {}),
        ...(needsVision ? { requireVision: true } : {}),
        estimatedInputTokens: estimatedInput,
      });
      if (!requested.ok) throw new Error(NO_ELIGIBLE_MODEL);

      const candidates: ProviderModel[] = [
        requested.value,
        ...input.router.fallbacks(
          requested.value,
          {
            mode: request.routingMode ?? 'auto',
            requireTools: request.requiresTools ?? false,
            requireVision: needsVision,
            estimatedInputTokens: estimatedInput,
          },
          input.maxFallbacks,
        ),
      ];

      for (const candidate of candidates) {
        if (request.signal.aborted) throw new Error('The request was aborted.');
        const gateway = input.gateways.get(candidate.ref.providerId);
        if (!gateway) continue;

        const nowAt = at();
        // One reservation covers the prompt and the largest output this call may
        // produce, so a provider's daily free-quota check cannot be passed twice.
        const reservedTokens = estimatedInput + (request.maxOutputTokens ?? 0);
        let budgetReservation = 0;
        if (input.budget && request.ownerId) {
          const budget = await input.budget.reserveTokens({
            ownerId: request.ownerId,
            tokens: reservedTokens,
            at: nowAt,
          });
          if (!budget.allowed) throw new Error(BUDGET_EXHAUSTED);
          budgetReservation = budget.reservedTokens;
        }

        const reserved = input.router.reserve(candidate, nowAt, reservedTokens);
        if (!reserved.ok) {
          if (budgetReservation > 0 && input.budget && request.ownerId) {
            await input.budget.settle({
              ownerId: request.ownerId,
              at: nowAt,
              reservedTokens: budgetReservation,
              usage: {},
            });
          }
          continue;
        }

        try {
          const completion = await gateway.complete({ ...request, model: candidate.ref });
          const usage = accountUsage({
            reported: completion.usage,
            estimatedInputTokens: estimatedInput,
            outputText: completion.text,
          });
          const settledAt = at();
          input.router.settle(candidate, usage, settledAt, reserved.value.reservedTokens);
          input.router.recordSuccess(candidate);
          if (input.budget && request.ownerId && budgetReservation > 0) {
            await input.budget.settle({
              ownerId: request.ownerId,
              at: settledAt,
              reservedTokens: budgetReservation,
              usage,
            });
          }
          return { ...completion, usage };
        } catch (error) {
          const failedAt = at();
          input.router.settle(candidate, {}, failedAt, reserved.value.reservedTokens);
          if (input.budget && request.ownerId && budgetReservation > 0) {
            await input.budget.settle({
              ownerId: request.ownerId,
              at: failedAt,
              reservedTokens: budgetReservation,
              usage: {},
            });
          }
          if (request.signal.aborted) throw error;
          // Only a verified-free model is ever tried, so retrying here can never
          // reach a paid provider; the bound is the number of approved models.
          if (!isRetryableProviderError(error)) {
            input.router.recordFailure(candidate, failedAt, retryAfterOf(error));
            throw error;
          }
          input.router.recordFailure(candidate, failedAt, retryAfterOf(error));
        }
      }

      throw new Error(ALL_MODELS_FAILED);
    },
  };
}
