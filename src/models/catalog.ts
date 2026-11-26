/**
 * Compatibility surface for the rest of the engine.
 *
 * The catalogue is no longer a separate selector: it is the routing port of the
 * single router in `router.ts`. Nothing here chooses a model, so there is no
 * second implementation that can drift from the zero-cost gate.
 */
export type { ModelCatalog } from './router.js';
