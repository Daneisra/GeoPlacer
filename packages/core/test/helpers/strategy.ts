/**
 * Test helpers for drawing strategies: images drawn as text, coordinates of
 * an order, batch-size independent draining, a seeded generator for
 * property tests (independent of the strategy's own PCG32).
 */

import type { DrawingOrderCursor, ImageRect, TemplateImage } from '../../src/index.js';
import { TRANSPARENT_U32 } from '../../src/index.js';

/**
 * Image from text rows: '.' is transparent, any other character is a color
 * (its char code), e.g. ['ab.', 'aab'].
 */
export function art(rows: readonly string[]): TemplateImage {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const pixels = new Uint32Array(width * height);
  rows.forEach((row, iy) => {
    if (row.length !== width) throw new Error('ragged art');
    for (let ix = 0; ix < width; ix++) pixels[iy * width + ix] = row[ix] === '.' ? TRANSPARENT_U32 : row.charCodeAt(ix);
  });
  return { width, height, pixels };
}

export function image(width: number, height: number, pixel: (ix: number, iy: number) => number | null): TemplateImage {
  const pixels = new Uint32Array(width * height);
  for (let iy = 0; iy < height; iy++) for (let ix = 0; ix < width; ix++) pixels[iy * width + ix] = pixel(ix, iy) ?? TRANSPARENT_U32;
  return { width, height, pixels };
}

/** "ix,iy" of each index, for readable assertions. */
export function coords(img: TemplateImage, order: ArrayLike<number>): string[] {
  return Array.from(order, (i) => `${i % img.width},${Math.floor(i / img.width)}`);
}

/** Drains a cursor with a cycle of batch sizes. */
export function drainWith(cursor: DrawingOrderCursor, sizes: readonly number[]): number[] {
  const all: number[] = [];
  for (let k = 0; ; k++) {
    const out = new Uint32Array(sizes[k % sizes.length] ?? 1);
    const n = cursor.next(out);
    if (n === 0) break;
    all.push(...out.subarray(0, n));
  }
  expect0(cursor);
  return all;
}

function expect0(cursor: DrawingOrderCursor): void {
  if (cursor.next(new Uint32Array(4)) !== 0) throw new Error('cursor produced data after finishing');
}

export function inRegion(img: TemplateImage, r: ImageRect, index: number): boolean {
  const ix = index % img.width;
  const iy = Math.floor(index / img.width);
  return ix >= r.ix && ix < r.ix + r.width && iy >= r.iy && iy < r.iy + r.height;
}

export function paintable(img: TemplateImage): number[] {
  const out: number[] = [];
  img.pixels.forEach((p, i) => {
    if (p !== TRANSPARENT_U32) out.push(i);
  });
  return out;
}

/** xorshift32: test-only generator for random images and regions. */
export function testRandom(seed: number): (max: number) => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return (max) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % max;
  };
}
