/**
 * Minimal, structurally valid image headers.
 *
 * Intake validates format from the signature and dimensions from the header, so
 * a test proves detection without embedding binary fixtures in the repository.
 * The shared builders keep the unit and live suites on the same bytes.
 */

export function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

export function png(width = 2, height = 2, extra: Buffer[] = []): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function jpeg(width = 3, height = 2): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

export function webp(width = 4, height = 5, animated = false): Buffer {
  const chunkData = Buffer.alloc(10);
  chunkData[0] = animated ? 0x02 : 0x00;
  chunkData.writeUIntLE(width - 1, 4, 3);
  chunkData.writeUIntLE(height - 1, 7, 3);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(chunkData.length, 0);
  const body = Buffer.concat([Buffer.from('VP8X', 'ascii'), size, chunkData]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}
