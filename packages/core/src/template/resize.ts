/**
 * Resizing of an RGBA image before its quantization (GeoPixels ghost image export, Phase 1C.1).
 *
 * The ONLY new image algorithm of the export: the colors are then reduced by the usual template
 * import (palette, alpha threshold, nearest color in OKLab), never by a second quantizer.
 *
 * Each output pixel covers a block of source pixels (integer bounds, every source pixel in exactly
 * one block per axis when reducing):
 * - reducing: the average of its block, weighted by alpha (a transparent pixel does not darken its
 *   neighbours), the alpha being the plain average;
 * - enlarging (a block thinner than one source pixel): the source pixel under it (nearest).
 * Integer arithmetic only, rounding half up: the same input always gives the same bytes.
 */

import type { DecodedImage } from '../contracts/index.js';
import { TemplateError } from './errors.js';
import { DEFAULT_TEMPLATE_LIMITS, assertWithinLimits, type TemplateLimits } from './limits.js';

/** Source rows (or columns) covered by output row (column) `o`: [from, to). */
function span(o: number, source: number, target: number): [number, number] {
  const from = Math.floor((o * source) / target);
  const to = Math.max(from + 1, Math.floor(((o + 1) * source) / target));
  return [from, Math.min(to, source)];
}

export function resizeRgba(image: DecodedImage, width: number, height: number, limits: TemplateLimits = DEFAULT_TEMPLATE_LIMITS): DecodedImage {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new TemplateError('INVALID_INPUT', `target size must be positive integers, got ${width} x ${height}`);
  }
  assertWithinLimits(width, height, limits);
  const { width: sw, height: sh, rgba } = image;
  if (rgba.length !== sw * sh * 4) throw new TemplateError('CORRUPT_IMAGE', `expected ${sw * sh * 4} RGBA bytes, got ${rgba.length}`);
  // Same size: the image itself, byte for byte (even the colors hidden under alpha 0).
  if (width === sw && height === sh) return { width, height, rgba: rgba.slice() };
  const out = new Uint8Array(width * height * 4);
  const cols: [number, number][] = [];
  for (let ox = 0; ox < width; ox++) cols.push(span(ox, sw, width));
  for (let oy = 0; oy < height; oy++) {
    const [y0, y1] = span(oy, sh, height);
    for (let ox = 0; ox < width; ox++) {
      const [x0, x1] = cols[ox]!;
      let n = 0;
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          const alpha = rgba[p + 3]!;
          n++;
          a += alpha;
          r += rgba[p]! * alpha;
          g += rgba[p + 1]! * alpha;
          b += rgba[p + 2]! * alpha;
        }
      }
      const q = (oy * width + ox) * 4;
      // Rounded half up with integers: floor((2v + d) / 2d).
      out[q + 3] = Math.floor((2 * a + n) / (2 * n));
      if (a > 0) {
        out[q] = Math.floor((2 * r + a) / (2 * a));
        out[q + 1] = Math.floor((2 * g + a) / (2 * a));
        out[q + 2] = Math.floor((2 * b + a) / (2 * a));
      }
    }
  }
  return { width, height, rgba: out };
}

/** Target size keeping the proportions when only one side is given (at least 1 pixel). */
export function proportionalSize(sourceWidth: number, sourceHeight: number, target: { readonly width?: number; readonly height?: number }): { width: number; height: number } {
  if (target.width !== undefined && target.height !== undefined) return { width: target.width, height: target.height };
  if (target.width !== undefined) return { width: target.width, height: Math.max(1, Math.round((sourceHeight * target.width) / sourceWidth)) };
  if (target.height !== undefined) return { width: Math.max(1, Math.round((sourceWidth * target.height) / sourceHeight)), height: target.height };
  return { width: sourceWidth, height: sourceHeight };
}
