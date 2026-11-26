import {
  CHAT_STREAM_VERSION,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
} from '@coderax/contracts';

/**
 * Version metadata for the packaged SDK.
 *
 * `SDK_VERSION` is kept in step with `packages/sdk/package.json`; the contract
 * constants are re-exported so a consumer can log or assert exactly which wire
 * version it was built against without importing two packages.
 *
 * `tests/unit/sdk-artifact.test.ts` fails when this drifts from package.json, so
 * the tarball's filename, its manifest and its runtime metadata cannot disagree.
 */
export const SDK_NAME = '@coderax/sdk';
export const SDK_VERSION = '1.1.0';
export const SDK_CONTRACT_VERSION = CONTRACT_VERSION;
export const SDK_CONTRACT_MAJOR = CONTRACT_MAJOR;
export const SDK_EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;
export const SDK_CHAT_STREAM_VERSION = CHAT_STREAM_VERSION;
export const SDK_SUPPORTED_CONTRACT_VERSIONS: readonly string[] = [
  ...SUPPORTED_CONTRACT_VERSIONS,
];

export type SdkVersionMetadata = {
  name: string;
  version: string;
  contractVersion: string;
  contractMajor: number;
  eventSchemaVersion: number;
  chatStreamVersion: number;
  supportedContractVersions: readonly string[];
};

export function sdkMetadata(): SdkVersionMetadata {
  return {
    name: SDK_NAME,
    version: SDK_VERSION,
    contractVersion: SDK_CONTRACT_VERSION,
    contractMajor: SDK_CONTRACT_MAJOR,
    eventSchemaVersion: SDK_EVENT_SCHEMA_VERSION,
    chatStreamVersion: SDK_CHAT_STREAM_VERSION,
    supportedContractVersions: SDK_SUPPORTED_CONTRACT_VERSIONS,
  };
}
