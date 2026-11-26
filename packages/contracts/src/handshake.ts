import { z } from 'zod';
import {
  CONTRACT_VERSION,
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  MIN_SDK_VERSION,
} from './primitives.js';
import { API_PREFIX } from './primitives.js';

/**
 * Version and capability negotiation.
 *
 * A client sends nothing: it fetches the handshake and compares the contract and
 * event versions it was built against with the ones the engine serves. The
 * operation list is generated from the same route catalogue the router registers,
 * so a client can assert it is talking to a deployment that implements every
 * operation it needs before issuing a request.
 *
 * Capabilities that exist but are not implemented are reported as `unsupported`
 * rather than omitted. A missing key and a `false` value are not the same claim.
 */

export const CapabilityState = z.enum(['available', 'unsupported', 'unconfigured']);
export type CapabilityState = z.infer<typeof CapabilityState>;

export const CapabilityStatus = z
  .object({
    state: CapabilityState,
    detail: z.string().max(500),
  })
  .strict();
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const HandshakeCapabilities = z
  .object({
    chat: CapabilityStatus,
    chatStreaming: CapabilityStatus,
    work: CapabilityStatus,
    durableEvents: CapabilityStatus,
    eventReplay: CapabilityStatus,
    scheduling: CapabilityStatus,
    artifacts: CapabilityStatus,
    permissions: CapabilityStatus,
    memory: CapabilityStatus,
    rag: CapabilityStatus,
    multimodal: CapabilityStatus,
    multiAgent: CapabilityStatus,
    idempotency: CapabilityStatus,
    reasoningPlanner: CapabilityStatus,
    modelRouter: CapabilityStatus,
  })
  .strict();
export type HandshakeCapabilities = z.infer<typeof HandshakeCapabilities>;

export const OperationDescriptor = z
  .object({
    operationId: z.string().min(1).max(80),
    method: z.enum(['GET', 'POST']),
    path: z.string().min(1).max(300),
    tags: z.array(z.string().min(1).max(40)),
    auth: z.enum(['owner', 'public']),
    stream: z.boolean(),
  })
  .strict();
export type OperationDescriptor = z.infer<typeof OperationDescriptor>;

export const EngineHandshake = z
  .object({
    engineName: z.literal('coderax-workflow-engine'),
    engineVersion: z.string().min(1).max(40),
    contractVersion: z.string().min(1).max(40),
    eventSchemaVersion: z.number().int().positive(),
    chatStreamSchemaVersion: z.number().int().positive(),
    minSdkVersion: z.string().min(1).max(40),
    sdkVersion: z.string().min(1).max(40),
    apiPrefix: z.literal(API_PREFIX),
    capabilities: HandshakeCapabilities,
    operations: z.array(OperationDescriptor),
  })
  .strict();
export type EngineHandshake = z.infer<typeof EngineHandshake>;

export const HANDSHAKE_VERSIONS = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  eventSchemaVersion: EVENT_SCHEMA_VERSION,
  engineVersion: ENGINE_VERSION,
  minSdkVersion: MIN_SDK_VERSION,
});
