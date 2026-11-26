import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * Builds the distributed SDK artifact.
 *
 * The tarball is byte-reproducible: entries are sorted, every tar header uses a
 * zero mtime, uid, gid and empty owner names, the mode is fixed, and the gzip
 * header's timestamp is zeroed. Two builds of the same source therefore produce
 * the same digest, which is what makes a committed tarball verifiable rather
 * than merely attached.
 *
 * The caller must have built from clean. `tsc -b` reusing an incremental
 * `.tsbuildinfo` prints inferred union members in a different order, which
 * changes the emitted `.d.ts` bytes without changing the types. The npm scripts
 * run `tsc -b --clean` first; building incrementally here produces an artifact
 * that no clean checkout can reproduce.
 *
 * `--check` is the drift gate: it rebuilds in memory and fails when the committed
 * artifact or its manifest no longer match the source, the same way
 * `openapi:check` guards the HTTP document.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SDK_ROOT = path.join(REPO_ROOT, 'packages', 'sdk');
const CONTRACTS_ROOT = path.join(REPO_ROOT, 'packages', 'contracts');
const MANIFEST_PATH = path.join(SDK_ROOT, 'sdk-artifact.json');

export type ArtifactFile = { path: string; sha256: string; bytes: number };

export type SdkArtifactManifest = {
  schema: 1;
  name: string;
  version: string;
  contractVersion: string;
  eventSchemaVersion: number;
  chatStreamVersion: number;
  /** Package-relative path of the tarball. */
  path: string;
  sha256: string;
  bytes: number;
  reproducible: true;
  files: ArtifactFile[];
  install: string;
};

export type BuiltArtifact = {
  /** Repository-relative path. */
  artifactPath: string;
  tarball: Buffer;
  manifest: SdkArtifactManifest;
  manifestText: string;
};

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/** Only runtime JavaScript and declarations ship: no maps, no build caches. */
function distributable(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.d.ts');
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, 'ascii');
  buffer[offset + length - 1] = 0;
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`tar entry name exceeds 100 bytes: ${name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.content.length));
    chunks.push(entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/**
 * Node's gzip writer is deterministic except for the header's mtime field and
 * the OS byte, so both are pinned rather than trusted to the platform.
 */
function deterministicGzip(tar: Buffer): Buffer {
  const compressed = gzipSync(tar, { level: 9 });
  compressed[4] = 0;
  compressed[5] = 0;
  compressed[6] = 0;
  compressed[7] = 0;
  compressed[9] = 255;
  return compressed;
}

function sdkPackageJson(): Buffer {
  const manifest = readJson(path.join(SDK_ROOT, 'package.json'));
  const published = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: manifest.type,
    main: manifest.main,
    types: manifest.types,
    exports: manifest.exports,
    dependencies: {
      '@coderax/contracts': readJson(path.join(CONTRACTS_ROOT, 'package.json')).version,
      zod: (manifest.dependencies as Record<string, string>).zod,
    },
    bundleDependencies: ['@coderax/contracts'],
    coderaxSdk: {
      contractVersion: (readJson(path.join(CONTRACTS_ROOT, 'package.json')) as { version?: string }).version,
    },
  };
  return Buffer.from(`${JSON.stringify(published, null, 2)}\n`, 'utf8');
}

function contractsPackageJson(): Buffer {
  const manifest = readJson(path.join(CONTRACTS_ROOT, 'package.json'));
  const published = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: manifest.type,
    main: manifest.main,
    types: manifest.types,
    exports: manifest.exports,
    dependencies: manifest.dependencies,
  };
  return Buffer.from(`${JSON.stringify(published, null, 2)}\n`, 'utf8');
}

export function buildArtifact(): BuiltArtifact {
  const sdkManifest = readJson(path.join(SDK_ROOT, 'package.json'));
  const contractsManifest = readJson(path.join(CONTRACTS_ROOT, 'package.json'));
  const version = String(sdkManifest.version);
  const contractVersion = String(contractsManifest.version);

  const entries: Array<{ name: string; content: Buffer }> = [
    { name: 'package/package.json', content: sdkPackageJson() },
    {
      name: 'package/node_modules/@coderax/contracts/package.json',
      content: contractsPackageJson(),
    },
  ];

  for (const file of walk(path.join(SDK_ROOT, 'dist'))) {
    if (!distributable(file)) continue;
    const relative = path.relative(path.join(SDK_ROOT, 'dist'), file).split(path.sep).join('/');
    entries.push({
      name: `package/dist/${relative}`,
      content: readFileSync(file),
    });
  }

  for (const file of walk(path.join(CONTRACTS_ROOT, 'dist'))) {
    if (!distributable(file)) continue;
    const relative = path
      .relative(path.join(CONTRACTS_ROOT, 'dist'), file)
      .split(path.sep)
      .join('/');
    entries.push({
      name: `package/node_modules/@coderax/contracts/dist/${relative}`,
      content: readFileSync(file),
    });
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  const duplicated = entries.find(
    (entry, index) => index > 0 && entries[index - 1]?.name === entry.name,
  );
  if (duplicated) throw new Error(`duplicate tar entry: ${duplicated.name}`);

  const tar = buildTar(entries);
  const tarball = deterministicGzip(tar);
  const fileName = `coderax-sdk-${version}.tgz`;

  const manifest: SdkArtifactManifest = {
    schema: 1,
    name: String(sdkManifest.name),
    version,
    contractVersion,
    eventSchemaVersion: 1,
    chatStreamVersion: 1,
    path: `artifacts/${fileName}`,
    sha256: sha256(tarball),
    bytes: tarball.length,
    reproducible: true,
    files: entries.map((entry) => ({
      path: entry.name,
      sha256: sha256(entry.content),
      bytes: entry.content.length,
    })),
    install: `npm install packages/sdk/artifacts/${fileName}`,
  };

  return {
    artifactPath: `packages/sdk/artifacts/${fileName}`,
    tarball,
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const built = buildArtifact();
  const artifactFile = path.join(REPO_ROOT, built.artifactPath);

  if (mode === 'write') {
    mkdirSync(path.dirname(artifactFile), { recursive: true });
    writeFileSync(artifactFile, built.tarball);
    writeFileSync(MANIFEST_PATH, built.manifestText, 'utf8');
    process.stdout.write(
      `wrote ${built.artifactPath} (${built.manifest.bytes} bytes, sha256 ${built.manifest.sha256})\n`,
    );
    return;
  }

  if (!existsSync(artifactFile)) {
    process.stderr.write(`${built.artifactPath} is missing; run "npm run sdk:bundle"\n`);
    process.exit(1);
  }
  const committed = readFileSync(artifactFile);
  if (sha256(committed) !== built.manifest.sha256) {
    process.stderr.write(
      `the committed SDK artifact does not match the source; run "npm run sdk:bundle"\n  committed sha256 ${sha256(committed)}\n  rebuilt   sha256 ${built.manifest.sha256}\n`,
    );
    process.exit(1);
  }
  if (!existsSync(MANIFEST_PATH)) {
    process.stderr.write('packages/sdk/sdk-artifact.json is missing; run "npm run sdk:bundle"\n');
    process.exit(1);
  }
  if (readFileSync(MANIFEST_PATH, 'utf8') !== built.manifestText) {
    process.stderr.write(
      'packages/sdk/sdk-artifact.json does not match the rebuilt artifact; run "npm run sdk:bundle"\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `the SDK artifact matches the source (sha256 ${built.manifest.sha256})\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
