import { deflateSync } from 'node:zlib';

/**
 * A minimal software canvas plus PNG encoder.
 *
 * Verification must prove the generated renderer draws something, not just that
 * its file parses. The studio therefore runs the same `src/render.js` the
 * browser runs, against this 2D context, and encodes the pixels as a PNG. No
 * paid browser or image library is involved.
 */

export type RasterContext = {
  fillStyle: string;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  clearRect: (x: number, y: number, width: number, height: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  closePath: () => void;
  fill: () => void;
};

type Point = { x: number; y: number };

function parseColor(value: string): [number, number, number, number] {
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
      255,
    ];
  }
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return [
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
      Number.parseInt(`${hex[3]}${hex[3]}`, 16),
      255,
    ];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex);
  if (rgba) {
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), 255];
  }
  return [0, 0, 0, 255];
}

export function createRaster(input: { width: number; height: number }): {
  context: RasterContext;
  pixels: Buffer;
  distinctColors: () => number;
} {
  const { width, height } = input;
  const pixels = Buffer.alloc(width * height * 4, 0);
  let color: [number, number, number, number] = [0, 0, 0, 255];
  let path: Point[] = [];

  function blend(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    const alpha = color[3] / 255;
    if (alpha >= 1) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
      return;
    }
    pixels[offset] = Math.round(color[0] * alpha + (pixels[offset] as number) * (1 - alpha));
    pixels[offset + 1] = Math.round(color[1] * alpha + (pixels[offset + 1] as number) * (1 - alpha));
    pixels[offset + 2] = Math.round(color[2] * alpha + (pixels[offset + 2] as number) * (1 - alpha));
    pixels[offset + 3] = 255;
  }

  const context: RasterContext = {
    fillStyle: '#000000',
    fillRect: (x, y, w, h) => {
      const left = Math.round(x);
      const top = Math.round(y);
      const right = Math.round(x + w);
      const bottom = Math.round(y + h);
      for (let row = top; row < bottom; row += 1) {
        for (let col = left; col < right; col += 1) blend(col, row);
      }
    },
    clearRect: (x, y, w, h) => {
      const left = Math.max(0, Math.round(x));
      const top = Math.max(0, Math.round(y));
      const right = Math.min(width, Math.round(x + w));
      const bottom = Math.min(height, Math.round(y + h));
      for (let row = top; row < bottom; row += 1) {
        pixels.fill(0, (row * width + left) * 4, (row * width + right) * 4);
      }
    },
    beginPath: () => {
      path = [];
    },
    moveTo: (x, y) => {
      path.push({ x, y });
    },
    lineTo: (x, y) => {
      path.push({ x, y });
    },
    closePath: () => undefined,
    fill: () => {
      if (path.length < 3) return;
      const ys = path.map((point) => point.y);
      const minY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
      for (let y = minY; y <= maxY; y += 1) {
        const crossings: number[] = [];
        for (let index = 0; index < path.length; index += 1) {
          const left = path[index] as Point;
          const right = path[(index + 1) % path.length] as Point;
          if ((left.y <= y && right.y > y) || (right.y <= y && left.y > y)) {
            crossings.push(left.x + ((y - left.y) / (right.y - left.y)) * (right.x - left.x));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let index = 0; index + 1 < crossings.length; index += 2) {
          const from = Math.max(0, Math.floor(crossings[index] as number));
          const to = Math.min(width - 1, Math.ceil(crossings[index + 1] as number));
          for (let x = from; x <= to; x += 1) blend(x, y);
        }
      }
      path = [];
    },
  };

  Object.defineProperty(context, 'fillStyle', {
    get: () => `rgb(${color[0]},${color[1]},${color[2]})`,
    set: (value: string) => {
      color = parseColor(value);
    },
  });

  return {
    context,
    pixels,
    distinctColors: () => {
      const seen = new Set<number>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        seen.add(
          ((pixels[offset] as number) << 16) |
            ((pixels[offset + 1] as number) << 8) |
            (pixels[offset + 2] as number),
        );
      }
      return seen.size;
    },
  };
}

const PNG_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (PNG_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(input: { width: number; height: number; pixels: Buffer }): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(input.width, 0);
  header.writeUInt32BE(input.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = input.width * 4;
  const raw = Buffer.alloc((stride + 1) * input.height);
  for (let row = 0; row < input.height; row += 1) {
    raw[row * (stride + 1)] = 0;
    input.pixels.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
