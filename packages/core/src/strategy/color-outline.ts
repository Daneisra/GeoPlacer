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
 * pass over the image (plus one over the region when it is not the whole
 * image), one placing pass into a single Uint32Array. Colors map to dense ids
 * through a typed-array hash table (color-table.ts), never a Map per pixel;
 * no per-pixel object and no comparison sort of pixels (only the few
 * distinct colors are sorted).
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
import { arrayCursor, defineStrategy, isWholeImage, StrategyError } from './common.js';
import { ColorIdTable } from './color-table.js';

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

interface ColorCensus {
  readonly table: ColorIdTable;
  /** Pixel count by color id, over the whole image. */
  readonly counts: Float64Array;
  /** Ids in drawing order. */
  readonly rankedIds: Int32Array;
}

/** One pass over the whole image: color ids, counts, then the color rank. */
function census(image: TemplateImage, config: StrategyConfig): ColorCensus {
  const explicit = explicitOrder(config);
  const table = new ColorIdTable();
  let counts = new Float64Array(64);
  const { pixels } = image;
  let last = TRANSPARENT_U32;
  let id = -1;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    if (p === TRANSPARENT_U32) continue;
    if (p !== last) {
      last = p;
      id = table.idOf(p);
      if (id >= counts.length) {
        const grown = new Float64Array(counts.length * 2);
        grown.set(counts);
        counts = grown;
      }
    }
    counts[id]! += 1;
  }
  // Rank: listed colors present in the image, then least frequent first, ties by RGB value.
  const listed: number[] = [];
  const isListed = new Uint8Array(table.size);
  for (const color of explicit) {
    const listedId = table.find(color);
    if (listedId >= 0) {
      listed.push(listedId);
      isListed[listedId] = 1;
    }
  }
  const rest: number[] = [];
  for (let k = 0; k < table.size; k++) if (isListed[k] === 0) rest.push(k);
  rest.sort((a, b) => counts[a]! - counts[b]! || table.colorOf(a) - table.colorOf(b));
  return { table, counts, rankedIds: Int32Array.from([...listed, ...rest]) };
}

/** Colors in drawing order, with their pixel count over the whole image. */
export function colorRanking(image: TemplateImage, config: StrategyConfig): { readonly colors: readonly number[]; readonly counts: readonly number[] } {
  const { table, counts, rankedIds } = census(image, config);
  return { colors: Array.from(rankedIds, (id) => table.colorOf(id)), counts: Array.from(rankedIds, (id) => counts[id]!) };
}

function colorCursor(image: TemplateImage, config: StrategyConfig, r: ImageRect): DrawingOrderCursor {
  const { table, counts, rankedIds } = census(image, config);
  const { width, pixels } = image;
  const colorCount = table.size;
  const x1 = r.ix + r.width;
  const y1 = r.iy + r.height;
  // Pixels per color inside the region: the whole-image counts when the region is the image.
  let inside = counts;
  if (!isWholeImage(image, r)) {
    inside = new Float64Array(colorCount);
    let last = TRANSPARENT_U32;
    let id = -1;
    for (let iy = r.iy; iy < y1; iy++) {
      for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
        const p = pixels[i]!;
        if (p === TRANSPARENT_U32) continue;
        if (p !== last) {
          last = p;
          id = table.find(p);
        }
        inside[id]! += 1;
      }
    }
  }
  // Start offset of each rank, indexed by color id.
  const start = new Float64Array(colorCount);
  let total = 0;
  for (let rank = 0; rank < colorCount; rank++) {
    const id = rankedIds[rank]!;
    start[id] = total;
    total += inside[id]!;
  }
  const order = new Uint32Array(total);
  let last = TRANSPARENT_U32;
  let id = -1;
  for (let iy = r.iy; iy < y1; iy++) {
    for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
      const p = pixels[i]!;
      if (p === TRANSPARENT_U32) continue;
      if (p !== last) {
        last = p;
        id = table.find(p);
      }
      order[start[id]!++] = i;
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
