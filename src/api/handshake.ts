import {
  API_PREFIX,
  CHAT_STREAM_VERSION,
  CONTRACT_FINGERPRINT,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  ROUTE_INDEX,
  negotiateContract,
  supportedContractVersions,
  type CapabilityFlags,
  type CapabilityHandshake,
  type CapabilityLimits,
  type OperationDescriptor,
} from '@coderax/contracts';

/**
 * The handshake is served from the same route table the router enforces. That is
 * the whole point: a documented operation that has no handler cannot appear in
 * `operations`, and a capability flag is a statement about that table rather
 * than a promise kept somewhere else.
 */
export type HandshakeContext = {
  server: CapabilityHandshake['server'];
  limits: CapabilityLimits;
  externalAgents: boolean;
};

const OPERATIONS: readonly OperationDescriptor[] = [...ROUTE_INDEX.values()].map((route) => ({
  operationId: route.operationId,
  method: route.method as OperationDescriptor['method'],
  path: route.path,
  tags: route.tags,
  auth: route.auth,
  stream: route.stream === true,
}));

const PUBLISHED = new Set(OPERATIONS.map((operation) => operation.operationId));

function has(operationId: string): boolean {
  return PUBLISHED.has(operationId);
}

/**
 * Flags describe what this build publishes. They are not a roadmap: `memorySearch`
 * is false because no search operation exists, and `idempotentSubmission` is
 * false because the submission body carries no idempotency key.
 */
function capabilityFlags(externalAgents: boolean): CapabilityFlags {
  return {
    health: has('getHealth'),
    discovery: has('getHandshake'),
    chat: has('submitChat'),
    chatStreaming: has('submitChat'),
    work: has('submitWork'),
    workStreaming: has('streamTaskEvents'),
    cursorReplay: has('streamTaskEvents'),
    cancellation: has('cancelTask'),
    resume: has('resumeTask'),
    retry: has('retryTask'),
    permissions: has('listPermissions'),
    notifications: has('listNotifications'),
    notificationRead: has('markNotificationsRead'),
    schedules: has('createSchedule'),
    artifacts: has('listArtifacts'),
    memory: has('listMemory'),
    memorySearch: false,
    conversations: has('listConversations'),
    taskList: false,
    idempotentSubmission: false,
    externalAgents,
    paidModels: false,
  };
}

export function buildHandshake(input: {
  context: HandshakeContext;
  requested?: string;
  fingerprint?: string;
}): CapabilityHandshake {
  const negotiation = negotiateContract(
    input.requested,
    input.fingerprint === undefined
      ? undefined
      : { provided: input.fingerprint, expected: CONTRACT_FINGERPRINT },
  );
  return {
    contractVersion: CONTRACT_VERSION,
    contractMajor: CONTRACT_MAJOR,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    chatStreamVersion: CHAT_STREAM_VERSION,
    apiPrefix: API_PREFIX,
    contractFingerprint: CONTRACT_FINGERPRINT,
    supportedContractVersions: supportedContractVersions(),
    ...(input.requested === undefined ? {} : { requestedContractVersion: input.requested }),
    compatible: negotiation.compatible,
    negotiatedContractVersion: negotiation.negotiatedContractVersion,
    negotiation: negotiation.negotiation,
    server: input.context.server,
    operations: [...OPERATIONS],
    capabilities: capabilityFlags(input.context.externalAgents),
    limits: input.context.limits,
  };
}
