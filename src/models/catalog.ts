import type {
  ModelDescriptor,
  ModelList,
  ModelRef,
  DataMode,
} from '@coderax/contracts';
import { modelKey } from '@coderax/contracts';
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

function usable(descriptor: ModelDescriptor, mode: DataMode): boolean {
  if (!descriptor.availability.available) return false;
  // Private mode is BYOK/local only; a hosted model is not a private resource.
  if (mode === 'private' && descriptor.costClass !== 'free') return false;
  return true;
}

export function createModelCatalog(input: {
  descriptors: ModelDescriptor[];
  route: ModelRef[];
  allowPaid: false;
}): ModelCatalog {
  const byKey = new Map(input.descriptors.map((descriptor) => [modelKey(descriptor.ref), descriptor]));
  const routeRefs = [...input.route];

  function resolve(
    requested: ModelRef | null | undefined,
    mode: DataMode,
  ): ServiceResult<ModelDescriptor> {
    if (requested) {
      const descriptor = byKey.get(modelKey(requested));
      if (!descriptor) {
        return fail('engine_not_configured', 'That model is not in the verified catalogue.');
      }
      if (descriptor.costClass === 'paid' || input.allowPaid !== false) {
        return fail(
          'paid_model_refused',
          'Coderax does not route to paid models; choose a verified zero-cost model.',
        );
      }
      if (!usable(descriptor, mode)) {
        return fail(
          'model_missing',
          `That model is not available for ${mode} execution: ${descriptor.availability.detail}`,
        );
      }
      return ok(descriptor);
    }

    for (const ref of routeRefs) {
      const descriptor = byKey.get(modelKey(ref));
      if (descriptor && descriptor.costClass === 'free' && usable(descriptor, mode)) {
        return ok(descriptor);
      }
    }
    return fail(
      'model_missing',
      'No verified zero-cost model is available for this data mode.',
    );
  }

  return {
    list: () => ({
      models: input.descriptors.map((descriptor) => ({ ...descriptor })),
      route: [...routeRefs],
      allowPaid: false,
    }),
    route: () => [...routeRefs],
    resolve,
  };
}
