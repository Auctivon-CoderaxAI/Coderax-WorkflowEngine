import type { EngineHandshake } from '@coderax/contracts';
import {
  CHAT_STREAM_SCHEMA_VERSION,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  SDK_VERSION,
  isCompatibleContract,
} from '@coderax/contracts';
import { CoderaxCompatibilityError } from './errors.js';

export { SDK_VERSION };

/** The contract line this SDK is built for. */
export const SDK_CONTRACT_VERSION = CONTRACT_VERSION;
export const SDK_EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;
export const SDK_ENGINE_CONTRACT = CONTRACT_VERSION;

export type CompatibilityReport = {
  compatible: boolean;
  problems: string[];
};

/**
 * Compatibility is checked against the handshake, never guessed from a package
 * version. A major contract change, an event schema the SDK does not parse, or an
 * engine older than this SDK is incompatible; a newer engine on the same major is
 * fine because additions are optional fields.
 */
export function checkCompatibility(
  handshake: Pick<EngineHandshake, 'contractVersion' | 'eventSchemaVersion'> &
    Partial<Pick<EngineHandshake, 'minSdkVersion' | 'chatStreamSchemaVersion'>>,
): CompatibilityReport {
  const problems: string[] = [];
  const major = Number(handshake.contractVersion.split('.')[0]);
  if (major !== CONTRACT_MAJOR) {
    problems.push(
      `engine contract ${handshake.contractVersion} is not on major ${CONTRACT_MAJOR}`,
    );
  } else if (!isCompatibleContract(handshake.contractVersion, SDK_CONTRACT_VERSION)) {
    problems.push(
      `engine contract ${handshake.contractVersion} is older than SDK ${SDK_VERSION} requires (${SDK_CONTRACT_VERSION})`,
    );
  }
  if (handshake.eventSchemaVersion !== SDK_EVENT_SCHEMA_VERSION) {
    problems.push(
      `engine event schema ${handshake.eventSchemaVersion} is not ${SDK_EVENT_SCHEMA_VERSION}`,
    );
  }
  if (
    handshake.chatStreamSchemaVersion !== undefined &&
    handshake.chatStreamSchemaVersion !== CHAT_STREAM_SCHEMA_VERSION
  ) {
    problems.push(
      `engine chat stream schema ${handshake.chatStreamSchemaVersion} is not ${CHAT_STREAM_SCHEMA_VERSION}`,
    );
  }
  if (
    handshake.minSdkVersion !== undefined &&
    !isCompatibleContract(SDK_VERSION, handshake.minSdkVersion)
  ) {
    problems.push(
      `engine requires SDK ${handshake.minSdkVersion} or newer, but this is ${SDK_VERSION}`,
    );
  }
  return { compatible: problems.length === 0, problems };
}

export function assertCompatible(
  handshake: Pick<EngineHandshake, 'contractVersion' | 'eventSchemaVersion'> &
    Partial<Pick<EngineHandshake, 'minSdkVersion' | 'chatStreamSchemaVersion'>>,
): EngineHandshake {
  const report = checkCompatibility(handshake);
  if (!report.compatible) {
    throw new CoderaxCompatibilityError(report.problems);
  }
  return handshake as EngineHandshake;
}

/** Distribution metadata a validator can print or compare. */
export const SDK_VERSION_METADATA = Object.freeze({
  sdkVersion: SDK_VERSION,
  contractVersion: CONTRACT_VERSION,
  eventSchemaVersion: EVENT_SCHEMA_VERSION,
  engineVersion: ENGINE_VERSION,
  engineContractMinimum: SDK_CONTRACT_VERSION,
});
