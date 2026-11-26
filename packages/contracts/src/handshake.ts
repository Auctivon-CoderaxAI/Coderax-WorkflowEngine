import { z } from 'zod';
import {
  API_PREFIX,
  CHAT_STREAM_VERSION,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  IsoDateTime,
  parseSemanticVersion,
  SUPPORTED_CONTRACT_VERSIONS,
  type SemanticVersion,
} from './primitives.js';

/**
 * The handshake is how a client learns what this build actually serves.
 *
 * It is not a wish list. `operations` is built from the route registry at
 * request time, so an operation that has no handler cannot appear here, and the
 * capability flags are derived from those operations rather than declared
 * separately. A client that asks for a newer minor than this build serves is
 * told it is incompatible instead of discovering it one 404 at a time.
 */

export const RouteMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE']);
export type RouteMethodSchema = z.infer<typeof RouteMethodSchema>;

export const OperationDescriptor = z
  .object({
    operationId: z.string().min(1).max(120),
    method: RouteMethodSchema,
    path: z.string().min(1).max(300),
    tags: z.array(z.string().max(60)),
    auth: z.enum(['owner', 'public']),
    /** The success response is a server-sent event stream. */
    stream: z.boolean(),
  })
  .strict();
export type OperationDescriptor = z.infer<typeof OperationDescriptor>;

/**
 * Every flag is answered by the server's own route table. `false` here is a
 * statement that the operation is not published, never that it is "coming".
 */
export const CapabilityFlags = z
  .object({
    health: z.boolean(),
    discovery: z.boolean(),
    chat: z.boolean(),
    chatStreaming: z.boolean(),
    work: z.boolean(),
    workStreaming: z.boolean(),
    cursorReplay: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    retry: z.boolean(),
    permissions: z.boolean(),
    notifications: z.boolean(),
    notificationRead: z.boolean(),
    schedules: z.boolean(),
    artifacts: z.boolean(),
    memory: z.boolean(),
    memorySearch: z.boolean(),
    conversations: z.boolean(),
    taskList: z.boolean(),
    idempotentSubmission: z.boolean(),
    /** True only when an external agent is configured and currently available. */
    externalAgents: z.boolean(),
    /** A literal: there is no configuration that makes paid routing reachable. */
    paidModels: z.literal(false),
  })
  .strict();
export type CapabilityFlags = z.infer<typeof CapabilityFlags>;

export const CapabilityLimits = z
  .object({
    maxBodyBytes: z.number().int().positive(),
    eventBufferSize: z.number().int().positive(),
    maxConcurrentTasks: z.number().int().positive(),
    scheduleMinIntervalMs: z.number().int().positive(),
    artifactMaxBytes: z.number().int().positive(),
    memoryMaxValueLength: z.number().int().positive(),
  })
  .strict();
export type CapabilityLimits = z.infer<typeof CapabilityLimits>;

export const ServerIdentity = z
  .object({
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(40),
    startedAt: IsoDateTime,
  })
  .strict();
export type ServerIdentity = z.infer<typeof ServerIdentity>;

export const CapabilityHandshake = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    contractMajor: z.literal(CONTRACT_MAJOR),
    eventSchemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    chatStreamVersion: z.literal(CHAT_STREAM_VERSION),
    apiPrefix: z.literal(API_PREFIX),
    /** Identity of the served catalogue; see `contractFingerprint`. */
    contractFingerprint: z.string().min(1).max(120),
    supportedContractVersions: z.array(z.string().min(1).max(20)),
    /** Present only when the caller negotiated a version. */
    requestedContractVersion: z.string().min(1).max(20).optional(),
    compatible: z.boolean(),
    negotiatedContractVersion: z.string().min(1).max(20),
    negotiation: z.enum([
      'no_request',
      'exact',
      'client_supported',
      'client_ahead',
      'unsupported_major',
      'unparseable',
      // The version string matches but the catalogue does not: same number,
      // different wire. Refused rather than served.
      'fingerprint_mismatch',
    ]),
    server: ServerIdentity,
    operations: z.array(OperationDescriptor),
    capabilities: CapabilityFlags,
    limits: CapabilityLimits,
  })
  .strict();
export type CapabilityHandshake = z.infer<typeof CapabilityHandshake>;

export const HandshakeQuery = z
  .object({
    contract: z.string().trim().min(1).max(20).optional(),
    /** Optional; when sent with the current version it must match the served catalogue. */
    fingerprint: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type HandshakeQuery = z.infer<typeof HandshakeQuery>;

export type ContractNegotiation = {
  compatible: boolean;
  negotiatedContractVersion: string;
  negotiation: CapabilityHandshake['negotiation'];
};

export function supportedContractVersions(): string[] {
  return [...SUPPORTED_CONTRACT_VERSIONS];
}

/**
 * Negotiation is deliberately one-directional: the server may serve an older
 * minor than the client asked for only when the difference is additive, and it
 * never pretends to speak a version it does not implement.
 */
export function negotiateContract(
  requested: string | undefined,
  fingerprint?: { provided?: string; expected?: string },
): ContractNegotiation {
  if (requested === undefined) {
    return {
      compatible: true,
      negotiatedContractVersion: CONTRACT_VERSION,
      negotiation: 'no_request',
    };
  }
  const parsed = parseSemanticVersion(requested);
  if (!parsed) {
    return {
      compatible: false,
      negotiatedContractVersion: CONTRACT_VERSION,
      negotiation: 'unparseable',
    };
  }
  if (parsed.major !== CONTRACT_MAJOR) {
    return {
      compatible: false,
      negotiatedContractVersion: CONTRACT_VERSION,
      negotiation: 'unsupported_major',
    };
  }
  const current = parseSemanticVersion(CONTRACT_VERSION);
  if (current && parsed.minor > current.minor) {
    return {
      compatible: false,
      negotiatedContractVersion: CONTRACT_VERSION,
      negotiation: 'client_ahead',
    };
  }
  if (requested === CONTRACT_VERSION) {
    if (
      fingerprint?.provided !== undefined &&
      fingerprint.expected !== undefined &&
      fingerprint.provided !== fingerprint.expected
    ) {
      return {
        compatible: false,
        negotiatedContractVersion: CONTRACT_VERSION,
        negotiation: 'fingerprint_mismatch',
      };
    }
    return { compatible: true, negotiatedContractVersion: CONTRACT_VERSION, negotiation: 'exact' };
  }
  return {
    compatible: true,
    negotiatedContractVersion: highestAdvertisedAtOrBelow(parsed),
    negotiation: 'client_supported',
  };
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * The handshake may only name a version this build advertises. A client is free
 * to ask for `1.0.7`; the server serves `1.0.0` and says so, rather than echoing
 * a version it does not have.
 */
function highestAdvertisedAtOrBelow(requested: SemanticVersion): string {
  const advertised: Array<{ version: string; parsed: SemanticVersion | null }> =
    SUPPORTED_CONTRACT_VERSIONS.map((version) => ({
      version,
      parsed: parseSemanticVersion(version),
    }));
  const candidates = advertised
    .filter(
      (entry): entry is { version: string; parsed: SemanticVersion } => entry.parsed !== null,
    )
    .filter((entry) => compareVersions(entry.parsed, requested) <= 0)
    .sort((left, right) => compareVersions(right.parsed, left.parsed));
  return candidates[0]?.version ?? CONTRACT_VERSION;
}
