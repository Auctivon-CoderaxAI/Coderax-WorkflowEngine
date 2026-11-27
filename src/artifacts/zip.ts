import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader/writer.
 *
 * OOXML artifacts are ZIP containers. The engine verifies a DOCX/XLSX/PPTX by
 * opening it and inspecting its parts rather than trusting the writer that
 * produced it, and it adds worksheet charts to an ExcelJS workbook by writing
 * the missing DrawingML parts. Both operations need exactly this much ZIP.
 * Entries are deflated or stored; no ZIP64, encryption or multi-disk support is
 * needed for an artifact this engine produced.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Buffer };

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Reads only the central-directory names. Media validation uses this so it can
 * recognise a real OOXML container without inflating attacker-controlled
 * entries; a zip bomb stays inert.
 */
export function zipEntryNames(archive: Buffer): Set<string> {
  const names = new Set<string>();
  let eocd = -1;
  const lowest = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('The archive has no central directory.');

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL) {
      throw new ZipError('The archive central directory is malformed.');
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength > archive.length) {
      throw new ZipError('The archive entry name is truncated.');
    }
    names.add(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Reads one small entry with a decompressed-output cap, or returns null. */
export function zipEntryText(
  archive: Buffer,
  wanted: string,
  maxOutputLength = 256,
): string | null {
  let eocd = -1;
  const lowest = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL) return null;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > archive.length) return null;
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL) return null;
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > archive.length) return null;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    try {
      const data =
        method === 0
          ? Buffer.from(raw)
          : method === 8
            ? inflateRawSync(raw, { maxOutputLength })
            : null;
      if (!data || data.length > maxOutputLength) return null;
      return data.toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads every entry into memory. Artifacts here are at most a few megabytes. */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  const lowest = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('The archive has no central directory.');

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL) {
      throw new ZipError('The archive central directory is malformed.');
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > archive.length) {
      throw new ZipError('The archive entry name is truncated.');
    }
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL) {
      throw new ZipError('The archive entry header is malformed.');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > archive.length) {
      throw new ZipError('The archive entry is truncated.');
    }
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, Buffer.from(raw));
    } else if (method === 8) {
      entries.set(name, inflateRawSync(raw));
    } else {
      throw new ZipError(`Unsupported compression method ${method}.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function dosDateTime(): { time: number; date: number } {
  // 2026-01-01 00:00:00, a fixed valid DOS timestamp so output is deterministic.
  return { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += 30 + name.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

export function partText(entries: Map<string, Buffer>, name: string): string {
  const part = entries.get(name);
  if (!part) throw new ZipError(`The archive is missing ${name}.`);
  return part.toString('utf8');
}
