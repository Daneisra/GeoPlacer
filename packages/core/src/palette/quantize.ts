/**
 * Deterministic quantization of decoded RGBA pixels to a list of colors.
 * Output is a compact Uint32Array (24-bit RGB or TRANSPARENT_U32): no object
 * per pixel.
 */

import type { ColorDistance, QuantizedImage, Rgb } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { ColorError } from '../color/errors.js';
import { assertAlphaThreshold } from '../color/rgb.js';
import { createPaletteMatcher, type PaletteMatcher } from './matcher.js';

export interface QuantizeStats {
  readonly pixels: number;
  /** Alpha below the threshold. */
  readonly transparent: number;
  /** Source color present in the palette. */
  readonly exact: number;
  /** Source color replaced by its nearest palette color. */
  readonly approximated: number;
}

export interface QuantizeResult {
  readonly image: QuantizedImage;
  readonly stats: QuantizeStats;
}

export interface QuantizeRgbaOptions {
  readonly alphaThreshold: number;
}

function assertImageBuffer(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ColorError('INVALID_IMAGE', `image size must be at least 1x1, got ${String(width)}x${String(height)}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new ColorError('INVALID_IMAGE', `expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
  }
}

/** Quantizes with a prepared matcher (reusable across images of the same agent). */
export function quantizeWithMatcher(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  matcher: PaletteMatcher,
  options: QuantizeRgbaOptions
): QuantizeResult {
  assertImageBuffer(rgba, width, height);
  assertAlphaThreshold(options.alphaThreshold);
  const threshold = options.alphaThreshold;

  const pixels = new Uint32Array(width * height);
  let transparent = 0;
  let exact = 0;
  let approximated = 0;

  for (let i = 0, p = 0; i < pixels.length; i++, p += 4) {
    if ((rgba[p + 3] ?? 0) < threshold) {
      pixels[i] = TRANSPARENT_U32;
      transparent++;
      continue;
    }
    const color = (((rgba[p] ?? 0) << 16) | ((rgba[p + 1] ?? 0) << 8) | (rgba[p + 2] ?? 0)) as Rgb;
    if (matcher.isExact(color)) {
      pixels[i] = color;
      exact++;
    } else {
      pixels[i] = matcher.nearest(color);
      approximated++;
    }
  }

  return { image: { width, height, pixels }, stats: { pixels: pixels.length, transparent, exact, approximated } };
}

export function quantizeRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  colors: readonly Rgb[],
  distance: ColorDistance,
  options: QuantizeRgbaOptions
): QuantizeResult {
  return quantizeWithMatcher(rgba, width, height, createPaletteMatcher(colors, distance), options);
}

/** Pixel count per color (transparent excluded), in first-appearance order. */
export function countColors(image: QuantizedImage): ReadonlyMap<Rgb, number> {
  const counts = new Map<Rgb, number>();
  for (const value of image.pixels) {
    if (value === TRANSPARENT_U32) continue;
    counts.set(value as Rgb, (counts.get(value as Rgb) ?? 0) + 1);
  }
  return counts;
}

/** Colors used by the image that `available` cannot paint (ascending order). */
export function missingColors(image: QuantizedImage, available: ReadonlySet<Rgb>): ReadonlySet<Rgb> {
  const missing = [...countColors(image).keys()].filter((c) => !available.has(c)).sort((a, b) => a - b);
  return new Set(missing);
}
