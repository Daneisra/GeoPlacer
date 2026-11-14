/**
 * PNG signature and IHDR parsing (pure, no decompression). Lets the
 * template manager reject invalid or oversized images before any decoder
 * allocates pixel buffers (decompression bombs included).
 */

import { TemplateError } from './errors.js';

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colorType: number;
  readonly interlace: 0 | 1;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const ALLOWED_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (PNG, zlib). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fail(message: string): never {
  throw new TemplateError('INVALID_PNG', message);
}

export function readPngHeader(bytes: Uint8Array): PngHeader {
  // signature (8) + IHDR length (4) + type (4) + data (13) + CRC (4)
  if (bytes.length < 33) fail(`too short to be a PNG (${bytes.length} bytes)`);
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) fail('missing PNG signature');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8);
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== 'IHDR' || length !== 13) fail('the first chunk must be a 13-byte IHDR');
  if (crc32(bytes, 12, 29) !== view.getUint32(29)) fail('IHDR CRC mismatch (corrupt file)');

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];

  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) fail(`invalid dimensions ${width}x${height}`);
  const depths = ALLOWED_DEPTHS[colorType];
  if (depths === undefined || !depths.includes(bitDepth)) fail(`invalid color type ${colorType} with bit depth ${bitDepth}`);
  if (compression !== 0 || filter !== 0) fail('unsupported compression or filter method');
  if (interlace !== 0 && interlace !== 1) fail(`invalid interlace method ${String(interlace)}`);

  return { width, height, bitDepth, colorType, interlace };
}
