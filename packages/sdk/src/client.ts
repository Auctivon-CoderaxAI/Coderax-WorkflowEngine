/**
 * The client-only entrypoint. `@coderax/sdk` additionally re-exports version,
 * stream and manifest helpers; an application that only needs the transport can
 * import this subpath and keep its bundle smaller.
 */
export {
  CoderaxApiError,
  CoderaxClient,
  CoderaxCompatibilityError,
  CoderaxContractError,
} from './index.js';
export type { CoderaxClientOptions } from './index.js';
