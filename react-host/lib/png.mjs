// Tiny RGBA PNG encoder for generated icons and test fixtures.
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** pixel(x, y) -> [r, g, b, a] */
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded square with a contrasting inner shape: a simple recognizable app icon. */
export function appIcon(size, [r, g, b], glyph = 'notes') {
  const radius = size * 0.22;
  return encodePng(size, size, (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
    if (!inside) return [0, 0, 0, 0];
    const u = x / size;
    const v = y / size;
    let mark = false;
    if (glyph === 'notes') {
      // A sheet with three text lines.
      const sheet = u > 0.27 && u < 0.73 && v > 0.2 && v < 0.8;
      const line = [0.36, 0.5, 0.64].some((ly) => Math.abs(v - ly) < 0.025) && u > 0.34 && u < (v > 0.6 ? 0.56 : 0.66);
      if (sheet && !line) return [255, 255, 255, 255];
      mark = line;
    }
    return mark ? [r, g, b, 255] : [r, g, b, 255];
  });
}
