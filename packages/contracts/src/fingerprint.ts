import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CONTRACT_VERSION } from './primitives.js';
import { ROUTES } from './routes.js';

/**
 * A contract fingerprint pins the wire identity of a version: every operation id
 * together with the method and path it is reachable at, in catalogue order.
 *
 * A version string alone cannot express this. Two catalogues can both say
 * `1.1.0` while resolving the same operation id to different URLs, and a client
 * that trusts the string discovers the difference one 404 at a time. The
 * fingerprint makes that collision observable during the handshake instead.
 *
 * It covers identity, not payload shape: a schema change without a route change
 * is caught by the OpenAPI drift gate, not here.
 *
 * The hash is computed with a portable implementation rather than `node:crypto`
 * because the SDK runs in browsers as well as in Node.
 */
export function contractFingerprint(routes: readonly {
  operationId: string;
  method: string;
  path: string;
}[] = ROUTES): string {
  const manifest = [
    `contract ${CONTRACT_VERSION}`,
    ...routes.map((route) => `${route.operationId} ${route.method} ${route.path}`),
  ].join('\n');
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(manifest)))}`;
}

/** The fingerprint of the catalogue this build ships. */
export const CONTRACT_FINGERPRINT = contractFingerprint();
