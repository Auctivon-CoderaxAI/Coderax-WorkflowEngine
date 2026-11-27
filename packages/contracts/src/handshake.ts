import { z } from 'zod';
import { API_PREFIX, CONTRACT_VERSION, EVENT_SCHEMA_VERSION } from './primitives.js';
import type { RouteSpec } from './routes.js';

/**
 * Version and operation negotiation.
 *
 * A client sends nothing: it fetches the handshake and compares the contract and
 * event versions it was built against with the ones the engine serves. The
 * operation list is projected from the same catalogue the router registers, so a
 * client can assert that a deployment implements every operation it needs before
 * issuing a request.
 *
 * Only versions the contract actually defines are reported. Capabilities are not
 * restated either: the operation list is the single claim the engine makes about
 * what it can do, and a second, hand-maintained matrix could advertise a feature
 * that has no operation behind it.
 */

export const OperationDescriptor = z
  .object({
    operationId: z.string().min(1).max(80),
    method: z.enum(['GET', 'POST', 'PATCH']),
    path: z.string().min(1).max(300),
    tags: z.array(z.string().min(1).max(40)),
    auth: z.enum(['owner', 'public']),
    stream: z.boolean(),
    /** Present only for the operations allowed a raised transport ceiling. */
    maxBodyBytes: z.number().int().positive().max(67_108_864).optional(),
  })
  .strict();
export type OperationDescriptor = z.infer<typeof OperationDescriptor>;

export const EngineHandshake = z
  .object({
    engineName: z.literal('coderax-workflow-engine'),
    contractVersion: z.string().min(1).max(40),
    eventSchemaVersion: z.number().int().positive(),
    apiPrefix: z.literal(API_PREFIX),
    operations: z.array(OperationDescriptor),
  })
  .strict();
export type EngineHandshake = z.infer<typeof EngineHandshake>;

export const HANDSHAKE_VERSIONS = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  eventSchemaVersion: EVENT_SCHEMA_VERSION,
});

/**
 * Takes the catalogue as an argument rather than importing it: `routes.ts`
 * imports this module for the response schema, and a value import back would be a
 * cycle. The caller passes the same `ROUTES` the router registers.
 */
export function buildHandshake(routes: readonly RouteSpec[]): EngineHandshake {
  return {
    engineName: 'coderax-workflow-engine',
    contractVersion: CONTRACT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    apiPrefix: API_PREFIX,
    operations: routes.map((route) => ({
      operationId: route.operationId,
      method: route.method,
      path: route.path,
      tags: [...route.tags],
      auth: route.auth,
      stream: route.stream === true,
      ...(route.maxBodyBytes === undefined ? {} : { maxBodyBytes: route.maxBodyBytes }),
    })),
  };
}
