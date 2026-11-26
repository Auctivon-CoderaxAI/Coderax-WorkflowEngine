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
    requirements?: { requireVision?: boolean; requireTools?: boolean },
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
    route: (_mode: DataMode) => router.report('auto').route,
    resolve: (requested, _mode, requirements) => {
      const selected = router.select({
        mode: 'auto' as RoutingMode,
        ...(requested ? { requested } : {}),
        ...(requirements?.requireVision ? { requireVision: true } : {}),
        ...(requirements?.requireTools ? { requireTools: true } : {}),
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
        inputModalities: model.profile.multimodal ? ['text', 'image'] : ['text'],
        promptTraining: model.promptTraining ?? 'unknown',
      });
    },
  };
}
