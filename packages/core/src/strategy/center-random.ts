/**
 * center-out and random strategies.
 *
 * center-out — centre of the image: ((width - 1) / 2, (height - 1) / 2) in
 * pixel coordinates, i.e. the middle pixel of an odd side and the point
 * between the two middle pixels of an even side (exact, in doubled integer
 * coordinates). Pixels by increasing squared Euclidean distance
 *   d2 = (2 ix - (width - 1))^2 + (2 iy - (height - 1))^2,
 * ties broken by increasing index (iy * width + ix), as in ADR 0002.
 * Lazy k-way merge instead of a global sort: in each row, the distance
 * grows strictly away from the centre column, so every row gives two
 * sorted streams (going left, going right); a binary heap of at most
 * 2 x height streams yields the global order. Memory O(height).
 *
 * random — uniform permutation by Fisher-Yates with PCG32 (pcg32.ts),
 * initstate = seed (unsigned 32-bit, default 0), initseq = RANDOM_STREAM.
 * Step i swaps entry i with entry i + bounded(n - i) of the row-major list
 * of the n paintable pixels of the WHOLE image, then emits entry i. Lazy:
 * the first batch costs one scan of the image. Never Math.random or time.
 */

import type { DrawingOrderCursor, ImageRect, StrategyConfig, TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { defineStrategy, isWholeImage, StrategyError } from './common.js';
import { createPcg32 } from './pcg32.js';

// ───────────────────────── center-out ─────────────────────────

function centerOutCursor(image: TemplateImage, r: ImageRect): DrawingOrderCursor {
  const { width, height, pixels } = image;
  const x0 = r.ix;
  const x1 = r.ix + r.width;
  const middle = Math.floor((width - 1) / 2); // last column of the left half
  // Stream s: row r.iy + (s >> 1), going left (even s) or right (odd s).
  const streams = 2 * r.height;
  const column = new Int32Array(streams);
  const keyD2 = new Float64Array(streams);
  const keyIndex = new Float64Array(streams);
  const heap = new Int32Array(streams);
  let size = 0;
  if (r.width === 0) return { next: () => 0 };

  const setKey = (s: number): void => {
    const iy = r.iy + (s >> 1);
    const dx = 2 * column[s]! - (width - 1);
    const dy = 2 * iy - (height - 1);
    keyD2[s] = dx * dx + dy * dy;
    keyIndex[s] = iy * width + column[s]!;
  };
  const less = (a: number, b: number): boolean => keyD2[a]! < keyD2[b]! || (keyD2[a] === keyD2[b] && keyIndex[a]! < keyIndex[b]!);
  const siftDown = (start: number): void => {
    let i = start;
    const s = heap[i]!;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && less(heap[child + 1]!, heap[child]!)) child++;
      if (!less(heap[child]!, s)) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = s;
  };

  for (let row = 0; row < r.height; row++) {
    const left = Math.min(middle, x1 - 1); // nearest column to the centre on the left half, inside the region
    const right = Math.max(middle + 1, x0);
    if (left >= x0) {
      column[2 * row] = left;
      setKey(2 * row);
      heap[size++] = 2 * row;
    }
    if (right < x1) {
      column[2 * row + 1] = right;
      setKey(2 * row + 1);
      heap[size++] = 2 * row + 1;
    }
  }
  for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(i);

  return {
    next(out) {
      let n = 0;
      while (n < out.length && size > 0) {
        const s = heap[0]!;
        const index = keyIndex[s]!;
        if (pixels[index] !== TRANSPARENT_U32) out[n++] = index;
        const c = column[s]! + ((s & 1) === 0 ? -1 : 1);
        if (c >= x0 && c < x1) {
          column[s] = c;
          setKey(s);
        } else {
          heap[0] = heap[--size]!;
        }
        if (size > 0) siftDown(0);
      }
      return n;
    },
  };
}

export const centerOut = defineStrategy('center-out', 1, (image, _config, r) => centerOutCursor(image, r));

// ───────────────────────── random ─────────────────────────

/** PCG32 stream (initseq) of the random strategy: "GeoP". Part of the order's identity. */
export const RANDOM_STREAM = 0x47656f50;
/** Seed used when the configuration has none: fixed, never time-based. */
export const DEFAULT_RANDOM_SEED = 0;

export function randomSeedOf(config: StrategyConfig): number {
  const seed = config.seed ?? DEFAULT_RANDOM_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new StrategyError('INVALID_CONFIG', `random seed must be an unsigned 32-bit integer, got ${String(config.seed)}`);
  }
  return seed;
}

function randomCursor(image: TemplateImage, config: StrategyConfig, r: ImageRect): DrawingOrderCursor {
  const rng = createPcg32(randomSeedOf(config), RANDOM_STREAM);
  const { width, pixels } = image;
  // Paintable pixels of the whole image (never only the region: the order
  // must not depend on the placement).
  let count = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== TRANSPARENT_U32) count++;
  const list = new Uint32Array(count);
  for (let i = 0, k = 0; i < pixels.length; i++) if (pixels[i] !== TRANSPARENT_U32) list[k++] = i;
  const whole = isWholeImage(image, r);
  const x1 = r.ix + r.width;
  const y1 = r.iy + r.height;
  let step = 0;
  return {
    next(out) {
      let n = 0;
      while (n < out.length && step < count) {
        const j = step + rng.bounded(count - step);
        const value = list[j]!;
        list[j] = list[step]!;
        list[step] = value;
        step++;
        if (whole) {
          out[n++] = value;
        } else {
          const iy = Math.floor(value / width);
          const ix = value - iy * width;
          if (ix >= r.ix && ix < x1 && iy >= r.iy && iy < y1) out[n++] = value;
        }
      }
      return n;
    },
  };
}

export const random = defineStrategy('random', 1, randomCursor);
