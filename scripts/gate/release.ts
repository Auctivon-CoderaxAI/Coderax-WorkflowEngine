import { CONTRACT_VERSION } from '@coderax/contracts';
import { readRepoText, report, type Finding, type Report } from './files.js';

/**
 * Release-manifest compatibility gate.
 *
 * This is deliberately narrower than the release-certification lane: it proves
 * the packages in this repository agree with the published contract version and
 * would contain only build output. Cross-repository compatibility evidence and
 * the release train remain the certification owner's job.
 */

export type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  files?: unknown;
  dependencies?: Record<string, string>;
};

const VERSION = /^(?:workspace:)?([\^~])?(\d+)\.(\d+)\.(\d+)$/;

export function acceptsContractRange(range: string, version: string): boolean {
  if (range === '*' || range === 'workspace:*' || range === 'latest') return true;
  const wanted = VERSION.exec(range);
  const actual = VERSION.exec(version);
  if (!wanted || !actual) return false;
  const operator = wanted[1];
  const major = Number(wanted[2]);
  const minor = Number(wanted[3]);
  const patch = Number(wanted[4]);
  const actualMajor = Number(actual[2]);
  const actualMinor = Number(actual[3]);
  const actualPatch = Number(actual[4]);
  if (!operator) {
    return actualMajor === major && actualMinor === minor && actualPatch === patch;
  }
  if (actualMajor !== major) return false;
  if (operator === '~') {
    return actualMinor === minor && actualPatch >= patch;
  }
  if (major > 0) {
    return actualMinor > minor || (actualMinor === minor && actualPatch >= patch);
  }
  return actualMinor === minor && actualPatch >= patch;
}

function releaseFindings(
  label: string,
  manifest: PackageManifest,
  expectedName: string,
): Finding[] {
  const findings: Finding[] = [];
  if (manifest.name !== expectedName) {
    findings.push({
      rule: 'release-name',
      detail: `${label} must be named ${expectedName}, found ${manifest.name ?? 'nothing'}`,
    });
  }
  if (manifest.version !== CONTRACT_VERSION) {
    findings.push({
      rule: 'release-version',
      detail: `${label} version ${manifest.version ?? 'missing'} must equal CONTRACT_VERSION ${CONTRACT_VERSION}`,
    });
  }
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.every((entry): entry is string => typeof entry === 'string') ||
    !manifest.files.includes('dist')
  ) {
    findings.push({
      rule: 'release-files',
      detail: `${label} must publish only dist (set "files": ["dist"])`,
    });
  }
  return findings;
}

export function compareReleaseManifests(
  contracts: PackageManifest,
  sdk: PackageManifest,
): Finding[] {
  const findings = [
    ...releaseFindings('contracts', contracts, '@coderax/contracts'),
    ...releaseFindings('sdk', sdk, '@coderax/sdk'),
  ];
  const range = sdk.dependencies?.['@coderax/contracts'];
  if (!range) {
    findings.push({
      rule: 'release-contracts-range',
      detail: 'the SDK must declare its @coderax/contracts dependency',
    });
  } else if (!acceptsContractRange(range, CONTRACT_VERSION)) {
    findings.push({
      rule: 'release-contracts-range',
      detail: `the SDK range ${range} does not accept contracts ${CONTRACT_VERSION}`,
    });
  }
  return findings;
}

export function checkRelease(): Report {
  const contracts = JSON.parse(
    readRepoText('packages/contracts/package.json'),
  ) as PackageManifest;
  const sdk = JSON.parse(readRepoText('packages/sdk/package.json')) as PackageManifest;
  return report(compareReleaseManifests(contracts, sdk));
}
