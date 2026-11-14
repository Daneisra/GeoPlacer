/**
 * color-by-color and outline-first strategies.
 *
 * color-by-color — color rank:
 *   1. the colors of `colorOrder`, in that order (colors absent from the
 *      image are ignored);
 *   2. then the other colors, least frequent first (ADR 0002), ties by
 *      increasing 0xRRGGBB value.
 * Frequencies are counted over the WHOLE image, never over the eligible
 * region, so that moving the template does not change the color order.
 * Within a color: top to bottom, left to right. Counting sort: one counting
 * pass, one placing pass into a single Uint32Array; no per-pixel object and
 * no comparison sort of pixels (only the few distinct colors are sorted).
 *
 * outline-first — a paintable pixel is an outline pixel when at least one of
 * its 4 orthogonal neighbours is outside the image, transparent or of a
 * different color. First pass: outline pixels; second pass: the other
 * (interior) pixels; each pass top to bottom, left to right. The image edge
 * counts as outside, the edge of the eligible region does not. Lazy: the
 * first batch costs only the pixels it reads.
 */

import type { DrawingOrderCursor, ImageRect, StrategyConfig, TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { arrayCursor, defineStrategy, StrategyError } from './common.js';

// ───────────────────────── color-by-color ─────────────────────────

function explicitOrder(config: StrategyConfig): readonly number[] {
  const order = config.colorOrder ?? [];
  const seen = new Set<number>();
  for (const color of order) {
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
      throw new StrategyError('INVALID_CONFIG', `colorOrder entries must be 24-bit RGB integers, got ${String(color)}`);
    }
    if (seen.has(color)) throw new StrategyError('INVALID_CONFIG', `colorOrder lists 0x${color.toString(16)} twice`);
    seen.add(color);
  }
  return order;
}

/** Colors in drawing order, with their pixel count over the whole image (runs of equal pixels are counted at once). */
export function colorRanking(image: TemplateImage, config: StrategyConfig): { readonly colors: readonly number[]; readonly counts: readonly number[] } {
  const explicit = explicitOrder(config);
  const counts = new Map<number, number>();
  const { pixels } = image;
  let last = TRANSPARENT_U32;
  let run = 0;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    if (p === last) {
      run++;
      continue;
    }
    if (last !== TRANSPARENT_U32) counts.set(last, (counts.get(last) ?? 0) + run);
    last = p;
    run = 1;
  }
  if (last !== TRANSPARENT_U32) counts.set(last, (counts.get(last) ?? 0) + run);
  const listed = explicit.filter((c) => counts.has(c));
  const listedSet = new Set(listed);
  const rest = [...counts.keys()].filter((c) => !listedSet.has(c)).sort((a, b) => counts.get(a)! - counts.get(b)! || a - b);
  const colors = [...listed, ...rest];
  return { colors, counts: colors.map((c) => counts.get(c)!) };
}

function colorCursor(image: TemplateImage, config: StrategyConfig, r: ImageRect): DrawingOrderCursor {
  const { colors } = colorRanking(image, config);
  const { width, pixels } = image;
  const rank = new Map<number, number>(colors.map((c, k) => [c, k]));
  // Counts inside the region, then the start offset of each color.
  const start = new Float64Array(colors.length + 1);
  const x1 = r.ix + r.width;
  const y1 = r.iy + r.height;
  let last = TRANSPARENT_U32;
  let lastRank = -1;
  for (let iy = r.iy; iy < y1; iy++) {
    for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
      const p = pixels[i]!;
      if (p === TRANSPARENT_U32) continue;
      if (p !== last) {
        last = p;
        lastRank = rank.get(p)!;
      }
      start[lastRank + 1]! += 1;
    }
  }
  for (let k = 1; k <= colors.length; k++) start[k]! += start[k - 1]!;
  const order = new Uint32Array(start[colors.length]!);
  last = TRANSPARENT_U32;
  for (let iy = r.iy; iy < y1; iy++) {
    for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
      const p = pixels[i]!;
      if (p === TRANSPARENT_U32) continue;
      if (p !== last) {
        last = p;
        lastRank = rank.get(p)!;
      }
      order[start[lastRank]!++] = i;
    }
  }
  return arrayCursor(order);
}

export const colorByColor = defineStrategy('color-by-color', 1, colorCursor);

// ───────────────────────── outline-first ─────────────────────────

/** True when the paintable pixel at (ix, iy) touches the image edge, a transparent pixel or another color. */
export function isOutlinePixel(image: TemplateImage, ix: number, iy: number): boolean {
  const { width, height, pixels } = image;
  if (ix === 0 || iy === 0 || ix === width - 1 || iy === height - 1) return true;
  const i = iy * width + ix;
  const p = pixels[i];
  return pixels[i - 1] !== p || pixels[i + 1] !== p || pixels[i - width] !== p || pixels[i + width] !== p;
}

function outlineCursor(image: TemplateImage, r: ImageRect): DrawingOrderCursor {
  const { width, height, pixels } = image;
  const x1 = r.ix + r.width;
  let pass = 0; // 0: outline pixels, 1: interior pixels
  let iy = r.iy;
  let ix = r.ix;
  return {
    next(out) {
      let n = 0;
      while (n < out.length && pass < 2) {
        if (iy >= r.iy + r.height || r.width === 0) {
          pass++;
          iy = r.iy;
          ix = r.ix;
          continue;
        }
        const base = iy * width;
        const edgeRow = iy === 0 || iy === height - 1;
        while (ix < x1 && n < out.length) {
          const i = base + ix;
          const p = pixels[i];
          if (p !== TRANSPARENT_U32) {
            const outline =
              edgeRow || ix === 0 || ix === width - 1 || pixels[i - 1] !== p || pixels[i + 1] !== p || pixels[i - width] !== p || pixels[i + width] !== p;
            if (outline === (pass === 0)) out[n++] = i;
          }
          ix++;
        }
        if (ix >= x1) {
          ix = r.ix;
          iy++;
        }
      }
      return n;
    },
  };
}

export const outlineFirst = defineStrategy('outline-first', 1, (image, _config, r) => outlineCursor(image, r));
