import type {
  ModelDescriptor,
  ModelList,
  ModelRef,
  DataMode,
  RoutingMode,
} from '@coderax/contracts';
import type { Router } from './router.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

export type ModelSelectionFailure = 'paid_model_refused' | 'model_missing';

/**
 * Model routing is centralized here: one catalogue, one ordered zero-cost route,
 * one refusal path. A caller names a model or accepts the route; it cannot reach
 * a provider directly, and a paid model is refused rather than silently used.
 */
export type ModelCatalog = {
  list: () => ModelList;
  route: (mode: DataMode) => ModelRef[];
  resolve: (
    requested: ModelRef | null | undefined,
    mode: DataMode,
  ) => ServiceResult<ModelDescriptor>;
};

/**
 * The catalogue a caller resolves against, implemented on the single router so
 * model discovery and model selection cannot disagree.
 *
 * There is deliberately no second catalogue implementation: a descriptor built
 * from configuration could carry `costClass: 'free'` without evidence, which is
 * exactly the inference the zero-cost rule forbids.
 */
export function createRouterCatalog(router: Router): ModelCatalog {
  return {
    list: () => router.list(),
    /**
     * This branch has no provider policy registry, so it cannot prove that a
     * provider and an exact processing operation are approved for private
     * execution. Private mode therefore resolves to nothing rather than reaching
     * a hosted model. The authoritative router owns that decision; this
     * catalogue never guesses it, and it never substitutes local inference.
     */
    route: (mode: DataMode) => (mode === 'private' ? [] : router.report('auto').route),
    resolve: (requested, mode) => {
      if (mode === 'private') {
        return fail(
          'model_missing',
          'Private mode requires an approved data-processing policy. This branch has no provider policy registry, so the request fails closed and is not sent to a hosted model.',
        );
      }
      const selected = router.select({
        mode: 'auto' as RoutingMode,
        ...(requested ? { requested } : {}),
      });
      if (!selected.ok) {
        return fail(
          selected.code === 'paid_model_refused' ? 'paid_model_refused' : 'model_missing',
          selected.detail,
        );
      }
      const model = selected.value;
      return ok({
        ref: model.ref,
        label: model.label,
        costClass: model.costClass,
        contextTokens: model.profile.contextTokens,
        toolCalling: model.profile.toolCalling,
        streaming: true,
        availability: model.availability,
      });
    },
  };
}
