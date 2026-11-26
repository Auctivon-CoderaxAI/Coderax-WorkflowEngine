import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  SDK_VERSION,
} from '@coderax/contracts';

/**
 * Deterministic SDK distribution artifacts.
 *
 * The tarballs are the immutable artifact Coderax and CoderaxCLI install: they
 * are committed with a SHA-256 checksum, and re-packing the same source produces
 * the same bytes because entries are sorted and every timestamp, uid and gid is
 * fixed. That is what makes a checksum pinned in another repository meaningful.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXED_MTIME = 946684800; // 2000-01-01T00:00:00Z

export type Entry = { name: string; content: Buffer; mode: number };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number): Buffer {
  const buffer = Buffer.alloc(512, 0);
  let prefix = '';
  let short = name;
  if (Buffer.byteLength(short) > 100) {
    const split = name.lastIndexOf('/', 155);
    if (split <= 0) throw new Error(`archive path is too long: ${name}`);
    prefix = name.slice(0, split);
    short = name.slice(split + 1);
    if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`archive path is too long: ${name}`);
    }
  }
  buffer.write(short, 0, 100, 'utf8');
  buffer.write(octal(mode, 8), 100, 8, 'ascii');
  buffer.write(octal(0, 8), 108, 8, 'ascii');
  buffer.write(octal(0, 8), 116, 8, 'ascii');
  buffer.write(octal(size, 12), 124, 12, 'ascii');
  buffer.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  buffer.write('        ', 148, 8, 'ascii');
  buffer.write('0', 156, 1, 'ascii');
  buffer.write('ustar\0', 257, 6, 'ascii');
  buffer.write('00', 263, 2, 'ascii');
  buffer.write('root', 265, 32, 'ascii');
  buffer.write('root', 297, 32, 'ascii');
  buffer.write(octal(0, 8), 329, 8, 'ascii');
  buffer.write(octal(0, 8), 337, 8, 'ascii');
  buffer.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of buffer) checksum += byte;
  buffer.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buffer;
}

export function createTar(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    chunks.push(header(entry.name, entry.content.length, entry.mode));
    chunks.push(entry.content);
    const remainder = entry.content.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

async function collect(
  directory: string,
  prefix: string,
  filter: (relative: string) => boolean,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const absolute = path.join(directory, child.name);
    const relative = `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      entries.push(...(await collect(absolute, relative, filter)));
    } else if (child.isFile() && filter(relative)) {
      entries.push({ name: `package/${relative}`, content: await readFile(absolute), mode: 0o644 });
    }
  }
  return entries;
}

function distFilter(relative: string): boolean {
  if (relative.endsWith('.tsbuildinfo')) return false;
  return relative.endsWith('.js') || relative.endsWith('.d.ts');
}

async function packageEntries(input: {
  directory: string;
  manifest: Record<string, unknown>;
  readme: string;
}): Promise<Entry[]> {
  const entries = await collect(path.join(input.directory, 'dist'), 'dist', distFilter);
  entries.push({
    name: 'package/package.json',
    content: Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8'),
    mode: 0o644,
  });
  entries.push({
    name: 'package/README.md',
    content: Buffer.from(input.readme, 'utf8'),
    mode: 0o644,
  });
  return entries;
}

function checksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function rewriteManifest(
  source: Record<string, unknown>,
  input: { name: string; version: string; dependency?: string },
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: input.name,
    version: input.version,
    description: source.description,
    type: 'module',
    main: source.main,
    types: source.types,
    exports: source.exports,
    dependencies:
      input.dependency === undefined
        ? source.dependencies
        : { ...(source.dependencies as Record<string, string>), '@coderax/contracts': input.dependency },
    license: 'UNLICENSED',
    private: true,
  };
  return Object.fromEntries(
    Object.entries(manifest).filter(([, value]) => value !== undefined),
  );
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

export type PackResult = {
  output: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
};

export async function packSdk(output = path.join(ROOT, 'dist-artifacts')): Promise<PackResult> {
  const contractsDirectory = path.join(ROOT, 'packages', 'contracts');
  const sdkDirectory = path.join(ROOT, 'packages', 'sdk');
  for (const directory of [contractsDirectory, sdkDirectory]) {
    if (!existsSync(path.join(directory, 'dist', 'index.js'))) {
      throw new Error(`${directory} has not been built; run npm run build first`);
    }
  }

  const contractsSource = await readJson(path.join(contractsDirectory, 'package.json'));
  const contractsManifest = rewriteManifest(contractsSource, {
    name: '@coderax/contracts',
    version: CONTRACT_VERSION,
  });
  const contractsTar = createTar(
    await packageEntries({
      directory: contractsDirectory,
      manifest: contractsManifest,
      readme: [
        '# @coderax/contracts',
        '',
        `Version ${CONTRACT_VERSION}. Event schema ${EVENT_SCHEMA_VERSION}.`,
        'Generated from Coderax WorkflowEngine. Do not edit inside the tarball.',
        '',
      ].join('\n'),
    }),
  );

  const sdkSource = await readJson(path.join(sdkDirectory, 'package.json'));
  const sdkManifest = rewriteManifest(sdkSource, {
    name: '@coderax/sdk',
    version: SDK_VERSION,
    dependency: CONTRACT_VERSION,
  });
  const sdkTar = createTar(
    await packageEntries({
      directory: sdkDirectory,
      manifest: sdkManifest,
      readme: [
        '# @coderax/sdk',
        '',
        `Version ${SDK_VERSION}. Requires engine contract ${CONTRACT_VERSION} and event schema ${EVENT_SCHEMA_VERSION}.`,
        '',
        'Install both tarballs from the same release:',
        '',
        '```sh',
        'npm install ./coderax-contracts-1.1.0.tgz ./coderax-sdk-1.1.0.tgz',
        '```',
        '',
        'Then call `client.negotiate()` before issuing requests. It throws',
        '`CoderaxCompatibilityError` when the engine cannot satisfy this SDK.',
        '',
      ].join('\n'),
    }),
  );

  await mkdir(output, { recursive: true });
  const artifacts = [
    { name: `coderax-contracts-${CONTRACT_VERSION}.tgz`, content: gzipSync(contractsTar, { level: 9 }) },
    { name: `coderax-sdk-${SDK_VERSION}.tgz`, content: gzipSync(sdkTar, { level: 9 }) },
  ];
  const files: PackResult['files'] = [];
  for (const artifact of artifacts) {
    await writeFile(path.join(output, artifact.name), artifact.content);
    files.push({
      name: artifact.name,
      sha256: checksum(artifact.content),
      bytes: artifact.content.length,
    });
  }
  const manifest = {
    engineVersion: ENGINE_VERSION,
    contractVersion: CONTRACT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    sdkVersion: SDK_VERSION,
    files,
  };
  await writeFile(
    path.join(output, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(output, 'SHA256SUMS'),
    `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`,
    'utf8',
  );
  return { output, files };
}

async function check(): Promise<void> {
  const directory = path.join(ROOT, 'dist-artifacts');
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  const files = manifest.files as Array<{ name: string; sha256: string }>;
  const sums = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  for (const file of files) {
    const content = await readFile(path.join(directory, file.name));
    const actual = checksum(content);
    if (actual !== file.sha256 || !sums.includes(actual)) {
      throw new Error(`${file.name} does not match its recorded checksum`);
    }
  }
  process.stdout.write(`verified ${files.length} artifacts in ${directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    await check();
  } else {
    const outputIndex = args.indexOf('--out');
    const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
    if (outputIndex !== -1 && !output) throw new Error('--out requires a directory');
    if (output) await rm(output, { recursive: true, force: true });
    const result = await packSdk(output);
    for (const file of result.files) {
      process.stdout.write(`${file.sha256}  ${file.name}  ${file.bytes} bytes\n`);
    }
  }
}
