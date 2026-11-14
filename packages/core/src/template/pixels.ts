/**
 * Canonical forms of a quantized image.
 *
 * - serializeQuantized: the bytes hashed into `quantizedImageHash`
 *   "GPQ1" | width u32 LE | height u32 LE | pixels u32 LE (row-major).
 *   Explicit little-endian through DataView: independent of the platform.
 * - quantizedToRgba / rgbaToQuantized: the RGBA form stored as a PNG blob.
 *   A transparent pixel is (0, 0, 0, 0); a color is (r, g, b, 255). Any other
 *   value read back is a corruption, never silently accepted.
 */

import type { TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { TemplateError } from './errors.js';

export const QUANTIZED_MAGIC = 'GPQ1';

export function serializeQuantized(image: TemplateImage): Uint8Array {
  const bytes = new Uint8Array(12 + image.pixels.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = QUANTIZED_MAGIC.charCodeAt(i);
  view.setUint32(4, image.width, true);
  view.setUint32(8, image.height, true);
  for (let i = 0, offset = 12; i < image.pixels.length; i++, offset += 4) view.setUint32(offset, image.pixels[i] ?? 0, true);
  return bytes;
}

export function quantizedToRgba(image: TemplateImage): Uint8Array {
  const rgba = new Uint8Array(image.pixels.length * 4);
  for (let i = 0, p = 0; i < image.pixels.length; i++, p += 4) {
    const value = image.pixels[i] ?? TRANSPARENT_U32;
    if (value === TRANSPARENT_U32) continue; // stays (0, 0, 0, 0)
    rgba[p] = (value >>> 16) & 0xff;
    rgba[p + 1] = (value >>> 8) & 0xff;
    rgba[p + 2] = value & 0xff;
    rgba[p + 3] = 255;
  }
  return rgba;
}

export function rgbaToQuantized(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): TemplateImage {
  if (rgba.length !== width * height * 4) {
    throw new TemplateError('CORRUPT_IMAGE', `expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  }
  const pixels = new Uint32Array(width * height);
  for (let i = 0, p = 0; i < pixels.length; i++, p += 4) {
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const a = rgba[p + 3] ?? 0;
    if (a === 255) {
      pixels[i] = (r << 16) | (g << 8) | b;
    } else if (a === 0 && r === 0 && g === 0 && b === 0) {
      pixels[i] = TRANSPARENT_U32;
    } else {
      throw new TemplateError('CORRUPT_IMAGE', `pixel ${i} is not canonical (${r}, ${g}, ${b}, ${a})`);
    }
  }
  return { width, height, pixels };
}

/** Non-transparent pixels. */
export function countPaintable(image: TemplateImage): number {
  let count = 0;
  for (const value of image.pixels) if (value !== TRANSPARENT_U32) count++;
  return count;
}
