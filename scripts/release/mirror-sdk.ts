import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Mirrors the canonical SDK tarball into the release train's artifact directory.
 *
 * There is one packer (`scripts/pack-sdk.ts`) and one set of bytes. The release
 * manifest requires its artifact under `release/artifacts/`, so the pack command
 * copies the exact canonical file and verifies the digest before doing so; it
 * never packs a second, smaller SDK from a partial file list.
 */

type Manifest = {
  files: { name: string; sha256: string }[];
};

function main(): void {
  const root = path.resolve(process.cwd());
  const canonical = path.join(root, 'dist-artifacts');
  const manifest = JSON.parse(
    readFileSync(path.join(canonical, 'manifest.json'), 'utf8'),
  ) as Manifest;
  const sdk = manifest.files.find((file) => file.name.startsWith('coderax-sdk-'));
  if (!sdk) throw new Error('dist-artifacts/manifest.json lists no SDK tarball');

  const source = path.join(canonical, sdk.name);
  const bytes = readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sdk.sha256) {
    throw new Error(`${sdk.name} does not match the digest in manifest.json`);
  }

  const destination = path.join(root, 'release', 'artifacts');
  mkdirSync(destination, { recursive: true });
  const target = path.join(destination, sdk.name);
  copyFileSync(source, target);
  process.stdout.write(`mirrored ${path.relative(root, target)} (${digest})\n`);
}

main();
