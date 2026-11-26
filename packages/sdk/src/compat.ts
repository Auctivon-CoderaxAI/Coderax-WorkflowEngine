import { CONTRACT_FINGERPRINT, type CapabilityHandshake } from '@coderax/contracts';
import {
  SDK_CHAT_STREAM_VERSION,
  SDK_CONTRACT_MAJOR,
  SDK_CONTRACT_VERSION,
  SDK_EVENT_SCHEMA_VERSION,
} from './version.js';

/**
 * Compatibility is decided from the server's handshake, not from a version
 * string a deployment printed in a release note.
 *
 * The report is deliberately a list of problems rather than a boolean: a client
 * that cannot run should be able to say which of the three versioned surfaces
 * (HTTP contract, execution events, chat frames) or which operation is the
 * blocker, and a human should be able to act on it.
 */
export type CompatibilityReport = {
  compatible: boolean;
  problems: string[];
  serverContractVersion: string;
  negotiatedContractVersion: string;
  eventSchemaVersion: number;
  chatStreamVersion: number;
  missingOperations: string[];
};

export function checkCompatibility(input: {
  handshake: CapabilityHandshake;
  /** Operations this client will call. Missing ones are reported, not assumed. */
  requiredOperations?: readonly string[];
}): CompatibilityReport {
  const { handshake } = input;
  const problems: string[] = [];

  if (!handshake.compatible) problems.push(`the server rejected negotiation: ${handshake.negotiation}`);
  if (handshake.contractVersion === SDK_CONTRACT_VERSION &&
      handshake.contractFingerprint !== CONTRACT_FINGERPRINT) {
    problems.push('the server catalogue fingerprint differs from this SDK');
  }

  if (handshake.contractMajor !== SDK_CONTRACT_MAJOR) {
    problems.push(
      `the server speaks contract major ${handshake.contractMajor}; this SDK speaks ${SDK_CONTRACT_MAJOR}`,
    );
  }
  if (!handshake.supportedContractVersions.includes(SDK_CONTRACT_VERSION)) {
    problems.push(
      `the server does not list ${SDK_CONTRACT_VERSION} among its supported contract versions`,
    );
  }
  if (handshake.eventSchemaVersion !== SDK_EVENT_SCHEMA_VERSION) {
    problems.push(
      `the server emits execution events v${handshake.eventSchemaVersion}; this SDK parses v${SDK_EVENT_SCHEMA_VERSION}`,
    );
  }
  if (handshake.chatStreamVersion !== SDK_CHAT_STREAM_VERSION) {
    problems.push(
      `the server emits chat frames v${handshake.chatStreamVersion}; this SDK parses v${SDK_CHAT_STREAM_VERSION}`,
    );
  }

  const published = new Set(handshake.operations.map((operation) => operation.operationId));
  const missingOperations = (input.requiredOperations ?? []).filter(
    (operationId) => !published.has(operationId),
  );
  if (missingOperations.length > 0) {
    problems.push(`the server does not implement: ${missingOperations.join(', ')}`);
  }

  return {
    compatible: problems.length === 0,
    problems,
    serverContractVersion: handshake.contractVersion,
    negotiatedContractVersion: handshake.negotiatedContractVersion,
    eventSchemaVersion: handshake.eventSchemaVersion,
    chatStreamVersion: handshake.chatStreamVersion,
    missingOperations,
  };
}
