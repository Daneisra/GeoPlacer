import { describe, expect, it } from 'vitest';
import type { Palette, Rgb } from '../src/index.js';
import {
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_QUANTIZATION,
  DEFAULT_TEMPLATE_LIMITS,
  TRANSPARENT_U32,
  TemplateError,
  asProjectId,
  asTemplateId,
  assertValidLimits,
  assertWithinLimits,
  countPaintable,
  normalizeName,
  quantizeDecoded,
  quantizedToRgba,
  readPngHeader,
  rgb,
  rgbaToQuantized,
  serializeQuantized,
} from '../src/index.js';
import { rgbaPng, writePng } from './helpers/png.js';

function expectTemplateError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe(code);
    return;
  }
  throw new Error(`expected TemplateError ${code}`);
}

describe('PNG header (read before any decoding)', () => {
  it('reads a valid RGBA header', () => {
    const png = rgbaPng(3, 2, () => [0, 0, 0, 255]);
    expect(readPngHeader(png)).toEqual({ width: 3, height: 2, bitDepth: 8, colorType: 6, interlace: 0 });
  });

  it('reads palette, grey 16-bit and interlaced headers', () => {
    const palette = writePng({ width: 4, height: 1, colorType: 3, bitDepth: 2, palette: [[0, 0, 0], [255, 0, 0]], row: () => new Uint8Array(1) });
    expect(readPngHeader(palette)).toMatchObject({ colorType: 3, bitDepth: 2 });
    const grey16 = writePng({ width: 1, height: 1, colorType: 0, bitDepth: 16, row: () => new Uint8Array(2) });
    expect(readPngHeader(grey16)).toMatchObject({ colorType: 0, bitDepth: 16 });
    const interlaced = writePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, interlace: 1, row: () => new Uint8Array(4) });
    expect(readPngHeader(interlaced).interlace).toBe(1);
  });

  it('rejects non-PNG, truncated and corrupt files', () => {
    const png = rgbaPng(2, 2, () => [1, 2, 3, 255]);
    expectTemplateError(() => readPngHeader(new TextEncoder().encode('GIF89a not a png at all, definitely')), 'INVALID_PNG');
    expectTemplateError(() => readPngHeader(png.slice(0, 20)), 'INVALID_PNG');
    const corrupt = png.slice();
    corrupt[17] = (corrupt[17] ?? 0) ^ 0xff; // width byte changed, CRC no longer matches
    expectTemplateError(() => readPngHeader(corrupt), 'INVALID_PNG');
  });

  it('rejects invalid colour type / bit depth combinations and zero sizes', () => {
    expectTemplateError(() => readPngHeader(writePng({ width: 1, height: 1, colorType: 2, bitDepth: 4, row: () => new Uint8Array(2) })), 'INVALID_PNG');
    expectTemplateError(() => readPngHeader(writePng({ width: 0, height: 1, colorType: 6, bitDepth: 8, row: () => new Uint8Array(0) })), 'INVALID_PNG');
  });
});

describe('template size limits', () => {
  it('uses the V1 defaults', () => {
    expect(DEFAULT_TEMPLATE_LIMITS).toEqual({ maxWidth: 4096, maxHeight: 4096, maxPixels: 16_777_216 });
    expect(() => assertWithinLimits(4096, 4096)).not.toThrow();
    expect(() => assertWithinLimits(1, 1)).not.toThrow();
  });

  it('rejects excessive images explicitly', () => {
    expectTemplateError(() => assertWithinLimits(4097, 1), 'IMAGE_TOO_LARGE');
    expectTemplateError(() => assertWithinLimits(1, 4097), 'IMAGE_TOO_LARGE');
    expectTemplateError(() => assertWithinLimits(100, 100, { maxWidth: 1000, maxHeight: 1000, maxPixels: 9999 }), 'IMAGE_TOO_LARGE');
  });

  it('detects an oversized PNG from its header alone (no decoding, no allocation)', () => {
    // Header claims 100000x100000; the data is a single tiny row.
    const bomb = writePng({ width: 100_000, height: 100_000, colorType: 6, bitDepth: 8, row: () => new Uint8Array(4) });
    const header = readPngHeader(bomb.slice(0, 33));
    expectTemplateError(() => assertWithinLimits(header.width, header.height), 'IMAGE_TOO_LARGE');
  });

  it('validates configurable limits (pixel indexes must fit a Uint32)', () => {
    expect(() => assertValidLimits({ maxWidth: 65_536, maxHeight: 65_536, maxPixels: 2 ** 32 })).not.toThrow();
    expectTemplateError(() => assertValidLimits({ maxWidth: 1, maxHeight: 1, maxPixels: 2 ** 32 + 1 }), 'INVALID_INPUT');
    expectTemplateError(() => assertValidLimits({ maxWidth: 0, maxHeight: 1, maxPixels: 1 }), 'INVALID_INPUT');
  });
});

describe('identifiers and names', () => {
  it('accepts lower-case bounded ids only (safe as directory names, no case collisions)', () => {
    expect(asProjectId('projet-1')).toBe('projet-1');
    expect(asTemplateId('3f2a9c1e-0b7d-4e2a-9f00-1234567890ab')).toBe('3f2a9c1e-0b7d-4e2a-9f00-1234567890ab');
    for (const bad of ['Projet', '', '-start', 'a/b', '..', 'a.b', 'a'.repeat(65), 'é', 'con ', 42]) {
      expectTemplateError(() => asProjectId(bad), 'INVALID_ID');
    }
  });

  it('normalizes names and rejects empty or control-character names', () => {
    expect(normalizeName('  Mon modèle  ')).toBe('Mon modèle');
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(201), 3]) expectTemplateError(() => normalizeName(bad), 'INVALID_NAME');
  });
});

describe('canonical quantized pixels', () => {
  const image = { width: 2, height: 1, pixels: new Uint32Array([0x123456, TRANSPARENT_U32]) };

  it('serializes with an explicit little-endian layout', () => {
    expect([...serializeQuantized(image)]).toEqual([
      0x47, 0x50, 0x51, 0x31, // "GPQ1"
      2, 0, 0, 0, // width
      1, 0, 0, 0, // height
      0x56, 0x34, 0x12, 0x00, // 0x123456
      0xff, 0xff, 0xff, 0xff, // TRANSPARENT_U32
    ]);
  });

  it('round-trips through the stored RGBA form', () => {
    const rgba = quantizedToRgba(image);
    expect([...rgba]).toEqual([0x12, 0x34, 0x56, 255, 0, 0, 0, 0]);
    expect([...rgbaToQuantized(2, 1, rgba).pixels]).toEqual([...image.pixels]);
  });

  it('rejects any non-canonical stored pixel', () => {
    expectTemplateError(() => rgbaToQuantized(1, 1, new Uint8Array([1, 2, 3, 128])), 'CORRUPT_IMAGE');
    expectTemplateError(() => rgbaToQuantized(1, 1, new Uint8Array([1, 0, 0, 0])), 'CORRUPT_IMAGE');
    expectTemplateError(() => rgbaToQuantized(2, 1, new Uint8Array(4)), 'CORRUPT_IMAGE');
  });

  it('counts paintable pixels', () => {
    expect(countPaintable(image)).toBe(1);
  });
});

describe('quantization of decoded images', () => {
  const palette: Palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(255, 0, 0) }] };
  const decoded = { width: 3, height: 1, rgba: new Uint8Array([250, 5, 5, 255, 0, 0, 0, 0, 0, 0, 0, 255]) };

  it('uses OKLab nearest-color and alpha 128 by default', () => {
    expect(DEFAULT_QUANTIZATION).toEqual({ algorithm: 'nearest-color', distance: 'oklab', version: 1 });
    expect(DEFAULT_ALPHA_THRESHOLD).toBe(128);
    const { image, stats } = quantizeDecoded(decoded, palette, 128, DEFAULT_QUANTIZATION);
    expect([...image.pixels]).toEqual([rgb(255, 0, 0), TRANSPARENT_U32, rgb(0, 0, 0)]);
    expect(stats).toEqual({ pixels: 3, transparent: 1, exact: 1, approximated: 1 });
  });

  it('is deterministic', () => {
    const a = quantizeDecoded(decoded, palette, 128, DEFAULT_QUANTIZATION);
    const b = quantizeDecoded(decoded, palette, 128, DEFAULT_QUANTIZATION);
    expect([...a.image.pixels]).toEqual([...b.image.pixels]);
  });

  it('rejects unknown methods, bad thresholds and invalid palettes', () => {
    expectTemplateError(() => quantizeDecoded(decoded, palette, 128, { algorithm: 'nearest-color', distance: 'ciede2000', version: 1 }), 'UNSUPPORTED_QUANTIZATION');
    expectTemplateError(() => quantizeDecoded(decoded, palette, 300, DEFAULT_QUANTIZATION), 'INVALID_INPUT');
    expectTemplateError(() => quantizeDecoded(decoded, { id: 'empty', colors: [] }, 128, DEFAULT_QUANTIZATION), 'INVALID_INPUT');
    expectTemplateError(() => quantizeDecoded(decoded, { id: 'bad', colors: [{ rgb: -1 as Rgb }] }, 128, DEFAULT_QUANTIZATION), 'INVALID_INPUT');
  });
});
