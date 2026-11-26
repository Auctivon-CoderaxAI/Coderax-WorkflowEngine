export {
  createInMemoryQuarantineTable,
  createQuarantineStore,
  type QuarantineEntry,
  type QuarantineStore,
  type QuarantineTable,
} from '../persistence/quarantine.js';

import type { QuarantineStore } from '../persistence/quarantine.js';

/**
 * The registry the runtime uses is the durable store. The name is kept so the
 * existing supervision boundary has one type, not two competing quarantine
 * concepts.
 */
export type QuarantineRegistry = QuarantineStore;
