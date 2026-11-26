import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readRepoText, repoRoot, report, type Finding, type Report } from './files.js';

/**
 * Dependency and lockfile gate.
 *
 * Zero-cost is a charter rule, so a new dependency is a reviewed decision, not an
 * incidental import. The lockfile must carry an https resolution and an integrity
 * hash for every installed package, must not rely on an install script, and must
 * agree with the manifest. Vulnerability scanning itself runs as a separate
 * hosted job (`npm audit`); this gate is deterministic and offline.
 */

type Manifest = {
  name?: string;
  private?: boolean;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type LockPackage = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Lockfile = {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
};

/** A direct dependency must be justified here before it can be installed. */
const ALLOWED_DIRECT: ReadonlyMap<string, string> = new Map([
  ['@coderax/contracts', 'workspace contract package'],
  ['@coderax/sdk', 'workspace client package'],
  ['zod', 'runtime schema validation, shared with the contracts'],
  ['typescript', 'compiler for the project-reference build'],
  ['@types/node', 'Node type definitions for the compiler'],
  ['mongodb', 'dev-only driver for the real MongoDB integration gate'],
]);

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function parseJson<T>(rel: string): T {
  return JSON.parse(readRepoText(rel)) as T;
}

function workspaceDirectories(): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot(), 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    directories.push(`packages/${entry.name}`);
  }
  return directories.sort();
}

function directDependencyFindings(
  manifests: ReadonlyArray<{ rel: string; manifest: Manifest }>,
): Finding[] {
  const findings: Finding[] = [];
  for (const { rel, manifest } of manifests) {
    for (const field of MANIFEST_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (ALLOWED_DIRECT.has(name)) continue;
        findings.push({
          rule: 'unreviewed-dependency',
          detail: `${rel} declares ${name}; add it to scripts/gate/dependencies.ts with a reason`,
        });
      }
    }
  }
  return findings;
}

function lockfileFindings(lock: Lockfile): Finding[] {
  const findings: Finding[] = [];
  if (lock.lockfileVersion !== 3) {
    findings.push({
      rule: 'lockfile-version',
      detail: `lockfileVersion ${lock.lockfileVersion ?? 'missing'} is not the reviewed v3 format`,
    });
  }
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.link) continue;
    if (entry.hasInstallScript) {
      findings.push({
        rule: 'install-script',
        detail: `${key} requires an install script; the gate installs with --ignore-scripts`,
      });
    }
    if (!entry.integrity || !/^sha(?:1|256|512)-/.test(entry.integrity)) {
      findings.push({ rule: 'lockfile-integrity', detail: `${key} has no verifiable integrity hash` });
    }
    if (!entry.resolved) {
      findings.push({ rule: 'lockfile-resolution', detail: `${key} has no resolved source` });
    } else if (!entry.resolved.startsWith('https://')) {
      findings.push({
        rule: 'lockfile-protocol',
        detail: `${key} resolves over a non-https protocol: ${entry.resolved}`,
      });
    }
  }
  return findings;
}

function importerFindings(
  lock: Lockfile,
  manifests: ReadonlyArray<{ rel: string; manifest: Manifest }>,
): Finding[] {
  const findings: Finding[] = [];
  const packages = lock.packages ?? {};
  for (const { rel, manifest } of manifests) {
    const importerKey = rel === 'package.json' ? '' : path.posix.dirname(rel);
    const importer = packages[importerKey];
    if (!importer) {
      findings.push({
        rule: 'lockfile-importer',
        detail: `no lockfile importer for ${importerKey || '.'}`,
      });
      continue;
    }
    const locked = new Set([
      ...Object.keys(importer.dependencies ?? {}),
      ...Object.keys(importer.devDependencies ?? {}),
    ]);
    for (const field of MANIFEST_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (locked.has(name)) continue;
        findings.push({
          rule: 'lockfile-missing-dependency',
          detail: `${importerKey || '.'} declares ${name}@${range} but the lockfile does not record it`,
        });
      }
    }
  }
  return findings;
}

export function checkDependencies(): Report {
  const root = parseJson<Manifest>('package.json');
  const manifests = [
    { rel: 'package.json', manifest: root },
    ...workspaceDirectories().map((dir) => ({
      rel: `${dir}/package.json`,
      manifest: parseJson<Manifest>(`${dir}/package.json`),
    })),
  ];

  let lock: Lockfile;
  try {
    lock = parseJson<Lockfile>('package-lock.json');
  } catch {
    return report([{ rule: 'lockfile-missing', detail: 'package-lock.json is missing or invalid' }]);
  }

  const findings = [
    ...directDependencyFindings(manifests),
    ...lockfileFindings(lock),
    ...importerFindings(lock, manifests),
  ];

  const required = /^>=(\d+)/.exec(root.engines?.node ?? '');
  if (!required || Number(required[1]) < 24) {
    findings.push({
      rule: 'node-engine',
      detail: `engines.node must require 24 or later, found ${root.engines?.node ?? 'missing'}`,
    });
  }
  for (const { rel, manifest } of manifests.slice(1)) {
    if (manifest.private !== true) {
      findings.push({ rule: 'package-private', detail: `${rel} must stay private` });
    }
  }
  return report(findings);
}
