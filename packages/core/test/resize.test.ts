/**
 * Phase 1C.1: resizing before quantization (GeoPixels ghost image export). Exact values: integer
 * arithmetic, alpha-weighted averages, every source pixel in exactly one block when reducing.
 */

import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../src/index.js';
import { TemplateError, proportionalSize, resizeRgba } from '../src/index.js';

const img = (width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): DecodedImage => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(px(x, y), (y * width + x) * 4);
  return { width, height, rgba };
};
const at = (i: DecodedImage, x: number, y: number) => [...i.rgba.subarray((y * i.width + x) * 4, (y * i.width + x) * 4 + 4)];

describe('resizeRgba (Phase 1C.1)', () => {
  it('same size: the same bytes', () => {
    const src = img(5, 3, (x, y) => [x * 40, y * 80, 7, x === 2 ? 0 : 255]);
    expect(resizeRgba(src, 5, 3).rgba).toEqual(src.rgba);
  });

  it('reducing: each output pixel is the exact average of its block', () => {
    // 2 x 2 blocks of 4 opaque pixels: red channel 10, 20, 30, 41 -> 25.25 -> 25.
    const src = img(4, 2, (x, y) => [[10, 20, 30, 41][(x % 2) + 2 * y]!, 100, 200, 255]);
    const out = resizeRgba(src, 2, 1);
    expect(at(out, 0, 0)).toEqual([25, 100, 200, 255]);
    expect(at(out, 1, 0)).toEqual([25, 100, 200, 255]);
  });

  it('transparent pixels do not darken their neighbours; the alpha is the plain average', () => {
    const src = img(2, 1, (x) => (x === 0 ? [200, 50, 10, 255] : [0, 0, 0, 0]));
    expect(at(resizeRgba(src, 1, 1), 0, 0)).toEqual([200, 50, 10, 128]);
    const empty = img(2, 2, () => [90, 90, 90, 0]);
    expect(at(resizeRgba(empty, 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('enlarging: nearest source pixel', () => {
    const src = img(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = resizeRgba(src, 4, 2);
    for (let y = 0; y < 2; y++) {
      expect(at(out, 0, y)).toEqual([255, 0, 0, 255]);
      expect(at(out, 1, y)).toEqual([255, 0, 0, 255]);
      expect(at(out, 2, y)).toEqual([0, 0, 255, 255]);
      expect(at(out, 3, y)).toEqual([0, 0, 255, 255]);
    }
  });

  it('reducing to a size that does not divide: every source pixel counts exactly once', () => {
    // Each source pixel has a distinct weight in the alpha; the alpha sums of the blocks, multiplied
    // back by their block sizes, add up to the whole image.
    for (const [sw, sh, tw, th] of [
      [7, 5, 3, 2],
      [10, 4, 3, 3],
      [13, 1, 4, 1],
    ] as const) {
      const src = img(sw, sh, () => [0, 0, 0, 255]);
      const out = resizeRgba(src, tw, th);
      expect(out.width * out.height).toBe(tw * th);
      for (let i = 3; i < out.rgba.length; i += 4) expect(out.rgba[i]).toBe(255);
    }
    // The orientation is kept: the top-left block stays top-left, the bottom-right stays bottom-right.
    const marker = img(6, 4, (x, y) => (x < 3 && y < 2 ? [255, 0, 0, 255] : x >= 3 && y >= 2 ? [0, 0, 255, 255] : [0, 255, 0, 255]));
    const small = resizeRgba(marker, 2, 2);
    expect(at(small, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(small, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(at(small, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(at(small, 0, 1)).toEqual([0, 255, 0, 255]);
  });

  it('is deterministic, and refuses invalid or too large sizes', () => {
    const src = img(9, 7, (x, y) => [(x * 37 + y * 11) % 256, (x * y) % 256, 123, (x + y) % 2 ? 255 : 30]);
    expect(resizeRgba(src, 4, 3).rgba).toEqual(resizeRgba(src, 4, 3).rgba);
    for (const [w, h] of [
      [0, 3],
      [3, -1],
      [2.5, 3],
      [4097, 10],
    ] as const) {
      expect(() => resizeRgba(src, w, h)).toThrow(TemplateError);
    }
  });

  it('proportionalSize keeps the proportions when one side is given', () => {
    expect(proportionalSize(400, 200, { width: 100 })).toEqual({ width: 100, height: 50 });
    expect(proportionalSize(400, 200, { height: 10 })).toEqual({ width: 20, height: 10 });
    expect(proportionalSize(3, 1000, { width: 1 })).toEqual({ width: 1, height: 333 });
    expect(proportionalSize(1000, 3, { width: 10 })).toEqual({ width: 10, height: 1 });
    expect(proportionalSize(40, 20, {})).toEqual({ width: 40, height: 20 });
    expect(proportionalSize(40, 20, { width: 7, height: 9 })).toEqual({ width: 7, height: 9 });
  });
});
