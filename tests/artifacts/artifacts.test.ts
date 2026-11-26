import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

type PackResult = {
  name: string;
  version: string;
  shasum: string;
  files: Array<{ path: string }>;
};

function pack(workspace: string): PackResult {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(root, 'packages', workspace),
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  const parsed = JSON.parse(output) as PackResult[];
  const result = parsed[0];
  assert.ok(result, 'npm pack produced no artifact');
  return result;
}

function manifest(workspace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, 'packages', workspace, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

for (const workspace of ['contracts', 'sdk']) {
  test(`the ${workspace} package is private, versioned and ships only its built artifact`, () => {
    const pkg = manifest(workspace);
    assert.equal(pkg.private, true, 'a private repository must not publish an accidental package');
    assert.deepEqual(pkg.files, ['dist']);
    assert.equal(pkg.version, '1.0.0');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.equal((pkg.dependencies as Record<string, string>).zod?.startsWith('^4.6.'), true);
  });

  test(`the ${workspace} tarball contains the declared entrypoints and no source or secrets`, () => {
    const packed = pack(workspace);
    const files = packed.files.map((entry) => entry.path);
    assert.ok(files.includes('dist/index.js'), files.join(', '));
    assert.ok(files.includes('dist/index.d.ts'), files.join(', '));
    for (const file of files) {
      assert.match(file, /^(dist\/|package\.json$)/, `unexpected packaged file ${file}`);
      assert.doesNotMatch(file, /\.env|id_rsa|credential|secret/i);
    }
    assert.equal(files.some((file) => file.startsWith('src/')), false);
    assert.equal(files.some((file) => file.includes('node_modules/')), false);

    const serialized = JSON.stringify(packed);
    assert.doesNotMatch(serialized, /\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\/);
  });
}

test('the SDK depends only on the contracts package and zod', () => {
  const sdk = manifest('sdk');
  const dependencies = sdk.dependencies as Record<string, string>;
  assert.deepEqual(Object.keys(dependencies).sort(), ['@coderax/contracts', 'zod']);
  assert.equal(dependencies['@coderax/contracts'], '*');
});

test('packing the same source twice produces the same artifact digest', () => {
  for (const workspace of ['contracts', 'sdk']) {
    const first = pack(workspace);
    const second = pack(workspace);
    assert.equal(first.shasum, second.shasum, `${workspace} pack is not reproducible`);
    assert.equal(first.shasum.length, 40);
  }
});

test('the root lockfile records the audited dependency versions', () => {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; dev?: boolean }>;
  };
  const packages = lock.packages ?? {};
  const zod = Object.entries(packages).find(([name]) => name.endsWith('node_modules/zod'));
  assert.ok(zod, 'zod must be in the lockfile');
  assert.match(zod[1].version ?? '', /^4\.6\./);
  const mongo = Object.entries(packages).find(([name]) => name.endsWith('node_modules/mongodb'));
  assert.ok(mongo, 'the live integration suite needs the official driver as a dev dependency');
  assert.equal(mongo[1].dev, true, 'the MongoDB driver must not be a runtime dependency');
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(rootManifest.dependencies?.mongodb, undefined);
  assert.ok(rootManifest.devDependencies?.mongodb);
});
