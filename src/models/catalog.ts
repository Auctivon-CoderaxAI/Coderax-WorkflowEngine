/**
 * Compatibility surface for the rest of the engine.
 *
 * The catalogue is no longer a separate selector: it is the routing port of the
 * single router in `router.ts`. Nothing here chooses a model, so there is no
 * second implementation that can drift from the zero-cost gate.
 */
export type ModelCatalog = {
  list: () => ModelList;
  route: (mode: DataMode) => ModelRef[];
  resolve: (
    requested: ModelRef | null | undefined,
    mode: DataMode,
  ) => ServiceResult<ModelDescriptor>;
  /**
   * Catalogue membership and cost only. Configuration validation must not
   * depend on another endpoint's current readiness; the run still resolves
   * through `resolve` before dispatch.
   */
  verify: (requested: ModelRef) => ServiceResult<ModelDescriptor>;
};

function usable(descriptor: ModelDescriptor, mode: DataMode): boolean {
  if (!descriptor.availability.available) return false;
  // Private mode is BYOK/local only; a hosted model is not a private resource.
  if (mode === 'private' && descriptor.costClass !== 'free') return false;
  return true;
}

/**
 * The catalogue a caller resolves against, implemented on the single router so
 * model discovery and model selection cannot disagree.
 */
export function createRouterCatalog(router: Router): ModelCatalog {
  return {
    list: () => router.list(),
    route: (_mode: DataMode) => router.report('auto').route,
    resolve: (requested, _mode) => {
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
    verify: (requested) => {
      const descriptor = router
        .list()
        .models.find((candidate) => modelKey(candidate.ref) === modelKey(requested));
      if (!descriptor) {
        return fail('engine_not_configured', 'That model is not in the verified catalogue.');
      }
      if (descriptor.costClass === 'paid') {
        return fail(
          'paid_model_refused',
          'Coderax does not route to paid models; choose a verified zero-cost model.',
        );
      }
      return ok({ ...descriptor });
    },
  };
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
    verify: (requested) => {
      const descriptor = byKey.get(modelKey(requested));
      if (!descriptor) {
        return fail('engine_not_configured', 'That model is not in the verified catalogue.');
      }
      if (descriptor.costClass === 'paid') {
        return fail(
          'paid_model_refused',
          'Coderax does not route to paid models; choose a verified zero-cost model.',
        );
      }
      return ok({ ...descriptor });
    },
  };
}
