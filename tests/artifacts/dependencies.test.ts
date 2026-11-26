import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Lockfile = { lockfileVersion?: number; packages?: Record<string, LockEntry> };
type Manifest = {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const ALLOWED_DIRECT = new Set([
  '@coderax/contracts',
  '@coderax/sdk',
  'zod',
  'typescript',
  '@types/node',
  'mongodb',
]);

function manifest(relative: string): Manifest {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Manifest;
}

test('the lockfile records only verified, script-free https resolutions', () => {
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  ) as Lockfile;
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!name.startsWith('node_modules/') || entry.link) continue;
    assert.ok(entry.integrity, `${name} has no integrity hash`);
    assert.match(entry.integrity, /^sha(?:1|256|512)-/);
    assert.ok(entry.resolved, `${name} has no resolved source`);
    assert.match(entry.resolved as string, /^https:\/\//, `${name} uses a non-https source`);
    assert.equal(entry.hasInstallScript, undefined, `${name} requires an install script`);
  }
});

test('the SDK release range accepts the canonical contract version', () => {
  const contracts = manifest('packages/contracts/package.json') as Manifest & { version?: string };
  const sdk = manifest('packages/sdk/package.json') as Manifest & { version?: string };
  const range = sdk.dependencies?.['@coderax/contracts'];
  assert.ok(range, 'the SDK must declare @coderax/contracts');
  assert.equal(sdk.version, contracts.version, 'SDK and contract versions must be identical');
  assert.ok(range === '*' || range === 'workspace:*', `unexpected contract range ${range}`);
});

test('every manifest dependency is reviewed, private and present in the lockfile', () => {
  const workspaces = readdirSync(path.join(root, 'packages')).sort();
  const manifests = [
    { rel: 'package.json', value: manifest('package.json') },
    ...workspaces.map((workspace) => ({
      rel: `packages/${workspace}/package.json`,
      value: manifest(`packages/${workspace}/package.json`),
    })),
  ];
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  ) as Lockfile;
  const packages = lock.packages ?? {};
  for (const { rel, value } of manifests) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ] as const) {
      for (const name of Object.keys(value[field] ?? {})) {
        assert.ok(ALLOWED_DIRECT.has(name), `${rel} declares unreviewed dependency ${name}`);
      }
    }
    if (rel !== 'package.json') {
      assert.equal(value.private, true, `${rel} must stay private`);
    }
    const importerKey = rel === 'package.json' ? '' : path.posix.dirname(rel);
    const importer = packages[importerKey];
    assert.ok(importer, `no lockfile importer for ${importerKey || '.'}`);
    const locked = new Set([
      ...Object.keys(importer.dependencies ?? {}),
      ...Object.keys(importer.devDependencies ?? {}),
    ]);
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ] as const) {
      for (const name of Object.keys(value[field] ?? {})) {
        assert.ok(locked.has(name), `${importerKey || '.'} does not lock ${name}`);
      }
    }
  }
});
