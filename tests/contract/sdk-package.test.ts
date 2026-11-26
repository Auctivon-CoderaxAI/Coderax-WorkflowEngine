import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { CONTRACT_VERSION, SDK_VERSION } from '@coderax/contracts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACTS = path.join(ROOT, 'dist-artifacts');
const CONTRACTS_TAR = path.join(ARTIFACTS, `coderax-contracts-${CONTRACT_VERSION}.tgz`);
const SDK_TAR = path.join(ARTIFACTS, `coderax-sdk-${SDK_VERSION}.tgz`);

type Manifest = {
  contractVersion: string;
  eventSchemaVersion: number;
  sdkVersion: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function tarEntries(file: string): string[] {
  const tar = gunzipSync(readFileSync(file));
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = block.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const size = Number.parseInt(sizeText, 8);
    names.push(name);
    offset += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return names;
}

test('the committed distribution artifacts match their checksums', () => {
  assert.ok(existsSync(CONTRACTS_TAR), `missing ${CONTRACTS_TAR}; run npm run sdk:pack`);
  assert.ok(existsSync(SDK_TAR), `missing ${SDK_TAR}; run npm run sdk:pack`);
  const manifest = JSON.parse(
    readFileSync(path.join(ARTIFACTS, 'manifest.json'), 'utf8'),
  ) as Manifest;
  assert.equal(manifest.sdkVersion, SDK_VERSION);
  assert.equal(manifest.contractVersion, CONTRACT_VERSION);
  const sums = readFileSync(path.join(ARTIFACTS, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const file of manifest.files) {
    const actual = sha256(path.join(ARTIFACTS, file.name));
    assert.equal(actual, file.sha256, `${file.name} checksum drifted`);
    assert.ok(sums.includes(`${actual}  ${file.name}`), `${file.name} is absent from SHA256SUMS`);
  }
});

test('the tarballs contain runtime entrypoints and type declarations', () => {
  const sdkEntries = tarEntries(SDK_TAR);
  for (const entry of [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/client.js',
    'package/dist/client.d.ts',
    'package/dist/version.js',
    'package/dist/version.d.ts',
    'package/dist/stream.js',
    'package/dist/stream.d.ts',
    'package/dist/manifest.js',
    'package/dist/manifest.d.ts',
  ]) {
    assert.ok(sdkEntries.includes(entry), `SDK tarball is missing ${entry}`);
  }
  const contractsEntries = tarEntries(CONTRACTS_TAR);
  assert.ok(contractsEntries.includes('package/dist/index.js'));
  assert.ok(contractsEntries.includes('package/dist/index.d.ts'));
});

test('packing the same source twice reproduces the same bytes', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'coderax-pack-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'dist/scripts/pack-sdk.js'), '--out', temporary], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    for (const artifact of [CONTRACTS_TAR, SDK_TAR]) {
      const name = path.basename(artifact);
      const reproduced = path.join(temporary, name);
      assert.ok(existsSync(reproduced), `repack did not produce ${name}`);
      assert.equal(sha256(reproduced), sha256(artifact), `${name} is not reproducible`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test(
  'a clean consumer can install the tarballs and use the runtime and declarations',
  { timeout: 180_000 },
  () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'coderax-install-'));
    try {
      const zodSource = path.join(ROOT, 'node_modules', 'zod');
      assert.ok(existsSync(zodSource), 'zod must be installed before the installation test');
      writeFileSync(
        path.join(sandbox, 'package.json'),
        `${JSON.stringify(
          {
            name: 'coderax-consumer-check',
            private: true,
            type: 'module',
            dependencies: {
              '@coderax/contracts': `file:${CONTRACTS_TAR}`,
              '@coderax/sdk': `file:${SDK_TAR}`,
              zod: `file:${zodSource}`,
            },
          },
          null,
          2,
        )}\n`,
      );
      execFileSync(
        'npm',
        ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'],
        { cwd: sandbox, stdio: 'pipe', timeout: 120_000 },
      );

      writeFileSync(
        path.join(sandbox, 'runtime.mjs'),
        [
          "import { CoderaxClient, SDK_VERSION, SDK_MANIFEST, checkCompatibility } from '@coderax/sdk';",
          "import { CoderaxClient as ClientOnly } from '@coderax/sdk/client';",
          "import { SDK_VERSION as VersionOnly } from '@coderax/sdk/version';",
          "import { parseSseFrames } from '@coderax/sdk/stream';",
          "import { SDK_COVERAGE } from '@coderax/sdk/manifest';",
          "if (SDK_VERSION !== '1.1.0' || VersionOnly !== SDK_VERSION) throw new Error('version entrypoint');",
          "if (typeof CoderaxClient !== 'function' || ClientOnly !== CoderaxClient) throw new Error('client entrypoint');",
          "if (typeof parseSseFrames !== 'function') throw new Error('stream entrypoint');",
          "if (!SDK_COVERAGE.getHandshake || !SDK_MANIFEST.operations.includes('getHandshake')) throw new Error('manifest');",
          "if (checkCompatibility({ contractVersion: '1.0.0', eventSchemaVersion: 1 }).compatible) throw new Error('compat');",
          "process.stdout.write('runtime-ok\\n');",
        ].join('\n'),
      );
      const runtime = execFileSync(process.execPath, [path.join(sandbox, 'runtime.mjs')], {
        cwd: sandbox,
        encoding: 'utf8',
      });
      assert.match(runtime, /runtime-ok/);

      writeFileSync(
        path.join(sandbox, 'consumer.ts'),
        [
          "import { CoderaxClient } from '@coderax/sdk';",
          "import type { EngineHandshake, ChatRequest } from '@coderax/contracts';",
          'export async function boot(client: CoderaxClient, request: ChatRequest): Promise<EngineHandshake> {',
          '  await client.chat(request);',
          '  return client.negotiate();',
          '}',
        ].join('\n'),
      );
      const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
      execFileSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2023',
          '--lib',
          'es2023,dom',
          path.join(sandbox, 'consumer.ts'),
        ],
        { cwd: sandbox, stdio: 'pipe', timeout: 120_000 },
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);
