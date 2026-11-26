import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRACT_VERSION, ROUTES } from '@coderax/contracts';
import { SDK_CONTRACT_VERSION, SDK_VERSION } from '@coderax/sdk';
import { buildArtifact } from '../../scripts/sdk-bundle.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

test('the SDK artifact is byte-reproducible and matches its committed checksums', () => {
  const first = buildArtifact();
  const second = buildArtifact();

  assert.equal(first.manifest.sha256, second.manifest.sha256, 'two builds differ');
  assert.ok(first.tarball.equals(second.tarball), 'two builds produced different bytes');
  assert.equal(first.manifestText, second.manifestText);
  assert.equal(first.manifest.reproducible, true);

  const sdkManifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages', 'sdk', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(SDK_VERSION, sdkManifest.version);
  assert.equal(SDK_CONTRACT_VERSION, CONTRACT_VERSION);
  assert.equal(first.manifest.version, SDK_VERSION);
  assert.equal(first.manifest.contractVersion, CONTRACT_VERSION);

  const committed = readFileSync(path.join(REPO_ROOT, first.artifactPath));
  assert.equal(sha256(committed), first.manifest.sha256, 'the committed tarball is stale');
  assert.equal(committed.length, first.manifest.bytes);
  assert.equal(
    readFileSync(path.join(REPO_ROOT, 'packages', 'sdk', 'sdk-artifact.json'), 'utf8'),
    first.manifestText,
    'the committed manifest is stale',
  );

  const listed = new Set(first.manifest.files.map((file) => file.path));
  for (const required of [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/version.js',
    'package/dist/version.d.ts',
    'package/dist/compat.d.ts',
    'package/node_modules/@coderax/contracts/package.json',
    'package/node_modules/@coderax/contracts/dist/index.js',
  ]) {
    assert.ok(listed.has(required), `the artifact omits ${required}`);
  }
});

test('the artifact installs into a clean layout and its runtime entrypoint loads', () => {
  const built = buildArtifact();
  const workdir = mkdtempSync(path.join(tmpdir(), 'coderax-sdk-install-'));
  try {
    const app = path.join(workdir, 'app');
    mkdirSync(app, { recursive: true });
    const tarball = path.join(workdir, 'coderax-sdk.tgz');
    writeFileSync(tarball, built.tarball);

    const extract = spawnSync('tar', ['-xzf', tarball, '-C', app], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);

    // Every declared digest must describe the bytes that were actually shipped.
    for (const file of built.manifest.files) {
      const onDisk = path.join(app, file.path);
      assert.ok(existsSync(onDisk), `the tarball is missing ${file.path}`);
      const content = readFileSync(onDisk);
      assert.equal(sha256(content), file.sha256, `digest mismatch for ${file.path}`);
      assert.equal(content.length, file.bytes);
    }

    // Recreate the registry dependencies without network access.
    for (const dep of ['zod', '@noble/hashes']) {
      cpSync(path.join(REPO_ROOT, 'node_modules', dep), path.join(app, 'node_modules', dep), {
        recursive: true,
      });
    }

    const probe = path.join(workdir, 'probe.mjs');
    writeFileSync(
      probe,
      [
        "import { pathToFileURL } from 'node:url';",
        'const sdk = await import(pathToFileURL(process.argv[2]).href);',
        "const client = new sdk.CoderaxClient({ baseUrl: 'http://127.0.0.1:1', token: 'x'.repeat(40) });",
        "for (const method of ['handshake', 'chat', 'chatStream', 'submitWork', 'tasks', 'artifacts', 'schedules', 'writeMemory', 'events']) {",
        "  if (typeof client[method] !== 'function') throw new Error('missing ' + method);",
        '}',
        'process.stdout.write(JSON.stringify({',
        '  version: sdk.SDK_VERSION,',
        '  operations: Object.keys(sdk.SDK_OPERATION_COVERAGE).length,',
        '  contractVersion: sdk.SDK_CONTRACT_VERSION,',
        '}));',
        '',
      ].join('\n'),
      'utf8',
    );

    const run = spawnSync(
      process.execPath,
      [probe, path.join(app, 'package', 'dist', 'index.js')],
      { cwd: workdir, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const loaded = JSON.parse(run.stdout) as {
      version: string;
      operations: number;
      contractVersion: string;
    };
    assert.equal(loaded.version, SDK_VERSION);
    assert.equal(loaded.contractVersion, CONTRACT_VERSION);
    assert.equal(loaded.operations, ROUTES.length);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
