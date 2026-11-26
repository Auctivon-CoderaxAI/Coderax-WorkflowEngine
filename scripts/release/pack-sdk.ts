import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Packs the built SDK as a consumer receives it and records the SHA-256,
 * SHA-512 and npm integrity of that exact tarball.
 *
 * `npm pack` on the workspace would follow the repository's ignore rules and
 * omit `dist`, producing an artifact whose `main` does not exist. The release
 * artifact is therefore staged from `packages/sdk/dist` plus the package
 * manifest, packed once, and checksummed. The verifier unpacks the tarball and
 * refuses one without `package/dist/index.js`.
 */

function main(): void {
  const root = path.resolve(process.cwd());
  const manifestPath = path.join(root, 'release', 'train.json');
  const destination = path.join(root, 'release', 'artifacts');
  mkdirSync(destination, { recursive: true });

  const packageDirectory = path.join(root, 'packages', 'sdk');
  const dist = path.join(packageDirectory, 'dist');
  if (!existsSync(path.join(dist, 'index.js')) || !existsSync(path.join(dist, 'index.d.ts'))) {
    throw new Error('packages/sdk/dist is not built; run npm run build first');
  }

  const staging = mkdtempSync(path.join(tmpdir(), 'coderax-sdk-pack-'));
  try {
    const stagedPackage = path.join(staging, 'package');
    mkdirSync(path.join(stagedPackage, 'dist'), { recursive: true });
    for (const file of ['index.js', 'index.d.ts']) {
      copyFileSync(path.join(dist, file), path.join(stagedPackage, 'dist', file));
    }
    copyFileSync(path.join(packageDirectory, 'package.json'), path.join(stagedPackage, 'package.json'));

    const output = execFileSync(
      'npm',
      ['pack', stagedPackage, '--pack-destination', destination, '--json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
    );
    const pack = JSON.parse(output) as { filename?: string; integrity?: string }[];
    const first = pack[0];
    if (!first || typeof first.filename !== 'string' || typeof first.integrity !== 'string') {
      throw new Error('npm pack did not return a filename and integrity');
    }

    const artifactPath = path.join(destination, first.filename);
    const bytes = readFileSync(artifactPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== first.integrity) {
      throw new Error('npm integrity does not match the packed bytes');
    }

    const files = execFileSync('tar', ['-tzf', artifactPath], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort();
    for (const required of ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts']) {
      if (!files.includes(required)) throw new Error(`packed SDK is missing ${required}`);
    }

    const relativePath = path.posix.join('release', 'artifacts', first.filename);
    const document = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const engine = document.engine as Record<string, unknown>;
    engine.sdkArtifact = { path: relativePath, sha256, sha512, integrity, files };
    writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`);

    process.stdout.write(
      [
        `packed ${relativePath}`,
        `  sha256 ${sha256}`,
        `  sha512 ${sha512}`,
        `  integrity ${integrity}`,
        `  files ${files.length}`,
        `updated ${path.relative(root, manifestPath)}`,
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`SDK packing failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
