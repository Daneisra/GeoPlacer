/**
 * Test implementations of the core ports (Node test runtime only):
 * SHA-256 via node:crypto, a minimal PNG codec (decodes 8-bit RGBA,
 * non-interlaced, any filter; encodes 8-bit RGBA), sequential ids and a
 * manual clock. The production codec lives in @geoplacer/adapters-node.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { DecodedImage, Hasher, IdSource, PngCodec, TemplateId, TimeSource } from '../../src/index.js';
import { readPngHeader } from '../../src/index.js';
import { writePng } from './png.js';

export const testHasher: Hasher = {
  async sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  },
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodeRgba8(bytes: Uint8Array): DecodedImage {
  const header = readPngHeader(bytes);
  if (header.colorType !== 6 || header.bitDepth !== 8 || header.interlace !== 0) throw new Error('test codec: RGBA 8-bit only');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error('test codec: truncated image data');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (rgba[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 4 ? (rgba[(y - 1) * stride + i - 4] ?? 0) : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN;
      if (Number.isNaN(predictor)) throw new Error(`test codec: bad filter ${String(filter)}`);
      rgba[y * stride + i] = (x + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

export function encodeRgba8(image: DecodedImage): Uint8Array {
  return writePng({
    width: image.width,
    height: image.height,
    colorType: 6,
    bitDepth: 8,
    row: (y) => Uint8Array.from(image.rgba.subarray(y * image.width * 4, (y + 1) * image.width * 4)),
  });
}

export const testCodec: PngCodec = {
  id: 'test-rgba8',
  async decode(bytes) {
    return decodeRgba8(bytes);
  },
  async encode(image) {
    return encodeRgba8(image);
  },
};

export function sequentialIds(prefix = 'modele'): IdSource {
  let n = 0;
  return { newTemplateId: () => `${prefix}-${++n}` as TemplateId };
}

export function manualClock(start = 1_000): TimeSource & { tick(ms?: number): void } {
  let now = start;
  return {
    now: () => now,
    tick: (ms = 1) => {
      now += ms;
    },
  };
}
