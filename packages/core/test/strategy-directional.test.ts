import { describe, expect, it } from 'vitest';
import type { CoordinateSystem, DrawingStrategy, StrategyConfig, TemplateImage } from '../src/index.js';
import {
  StrategyError,
  TRANSPARENT_U32,
  bottomToTop,
  drawingStrategy,
  eligibleRegion,
  imageToCanvas,
  leftToRight,
  rightToLeft,
  templateOrderCursor,
  topToBottom,
} from '../src/index.js';
import { art, coords, drainWith, inRegion } from './helpers/strategy.js';

const cfg = (s: DrawingStrategy): StrategyConfig => ({ id: s.id });
const order = (s: DrawingStrategy, img: TemplateImage) => coords(img, s.order(img, cfg(s)));

// 3 x 2 with a hole at (1, 0):
//   a . b
//   c d e
const holed = art(['a.b', 'cde']);

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(StrategyError);
  expect((error as StrategyError).code).toBe(code);
}

describe('directional strategies: conventions', () => {
  it('orders rows or columns in image space, skipping transparent pixels', () => {
    expect(order(topToBottom, holed)).toEqual(['0,0', '2,0', '0,1', '1,1', '2,1']);
    expect(order(bottomToTop, holed)).toEqual(['0,1', '1,1', '2,1', '0,0', '2,0']);
    expect(order(leftToRight, holed)).toEqual(['0,0', '0,1', '1,1', '2,0', '2,1']);
    expect(order(rightToLeft, holed)).toEqual(['2,0', '2,1', '1,1', '0,0', '0,1']);
  });

  it('handles 1 x 1, single rows and columns, and fully transparent images', () => {
    for (const s of [topToBottom, bottomToTop, leftToRight, rightToLeft]) {
      expect(order(s, art(['x']))).toEqual(['0,0']);
      expect(order(s, art(['.']))).toEqual([]);
      expect(order(s, art(['...', '...']))).toEqual([]);
    }
    expect(order(rightToLeft, art(['abc']))).toEqual(['2,0', '1,0', '0,0']);
    expect(order(bottomToTop, art(['a', 'b', 'c']))).toEqual(['0,2', '0,1', '0,0']);
    expect(order(leftToRight, art(['abc']))).toEqual(['0,0', '1,0', '2,0']);
  });

  it('gives the same sequence whatever the batch size', () => {
    const img = art(['ab.c', '.dd.', 'eeee']);
    for (const s of [topToBottom, bottomToTop, leftToRight, rightToLeft]) {
      const full = [...s.order(img, cfg(s))];
      for (const sizes of [[1], [2], [3, 1], [7], [1000]]) expect(drainWith(s.cursor(img, cfg(s)), sizes)).toEqual(full);
    }
  });
});

describe('eligible region and placement', () => {
  const img = art(['abcd', 'efgh', 'ijkl']); // 4 x 3, fully opaque
  const bounded = (yAxis: 'down' | 'up'): CoordinateSystem => ({ yAxis, bounds: { minX: 0, minY: 0, width: 10, height: 10 } });

  it('computes the part of the image inside the canvas bounds', () => {
    expect(eligibleRegion(img, { topLeft: { x: -1000, y: 5 } }, { yAxis: 'down' })).toEqual({ ix: 0, iy: 0, width: 4, height: 3 });
    expect(eligibleRegion(img, { topLeft: { x: 2, y: 2 } }, bounded('down'))).toEqual({ ix: 0, iy: 0, width: 4, height: 3 });
    // Down: rows 9..11 -> only canvas row 9 (image row 0) is inside; columns 8..11 -> 8, 9.
    expect(eligibleRegion(img, { topLeft: { x: 8, y: 9 } }, bounded('down'))).toEqual({ ix: 0, iy: 0, width: 2, height: 1 });
    // Up: image row iy is canvas y = 1 - iy -> rows 1, 0 inside (iy 0, 1), -1 outside (iy 2).
    expect(eligibleRegion(img, { topLeft: { x: -1, y: 1 } }, bounded('up'))).toEqual({ ix: 1, iy: 0, width: 3, height: 2 });
    // Up, cut at the top: topLeft y = 11 -> image rows 0 (y 11) and 1 (y 10) outside, row 2 (y 9) inside.
    expect(eligibleRegion(img, { topLeft: { x: 0, y: 11 } }, bounded('up'))).toEqual({ ix: 0, iy: 2, width: 4, height: 1 });
    expect(eligibleRegion(img, { topLeft: { x: 50, y: 50 } }, bounded('down'))).toEqual({ ix: 0, iy: 0, width: 0, height: 0 });
  });

  it('restricts the order to the region, which is exactly the full order filtered', () => {
    const r = { ix: 1, iy: 1, width: 2, height: 2 };
    for (const s of [topToBottom, bottomToTop, leftToRight, rightToLeft]) {
      const full = [...s.order(img, cfg(s))];
      expect([...s.order(img, cfg(s), r)]).toEqual(full.filter((i) => inRegion(img, r, i)));
      expect([...s.order(img, cfg(s), { ix: 0, iy: 0, width: 0, height: 0 })]).toEqual([]);
    }
  });

  it('keeps the image-space order when the placement changes; clipping only removes pixels', () => {
    const template = (x: number, y: number, yAxis: 'down' | 'up') => ({
      image: img,
      strategy: { id: 'top-to-bottom' } as const,
      placement: { topLeft: { x, y } },
      coordinateSystem: bounded(yAxis),
    });
    const drain = (t: ReturnType<typeof template>) => drainWith(templateOrderCursor(t), [5]);
    const reference = drain(template(0, 0, 'down'));
    expect(drain(template(5, 6, 'down'))).toEqual(reference);
    expect(drain(template(3, 9, 'up'))).toEqual(reference); // inverted y: same image order
    const clipped = drain(template(8, 9, 'down'));
    expect(clipped).toEqual(reference.filter((i) => inRegion(img, { ix: 0, iy: 0, width: 2, height: 1 }, i)));
    expect(drain(template(50, 50, 'down'))).toEqual([]);
  });

  it('paints from the top of the image as displayed, also on a y-up canvas', () => {
    const t = { image: img, strategy: { id: 'top-to-bottom' } as const, placement: { topLeft: { x: 0, y: 5 } }, coordinateSystem: { yAxis: 'up' } as const };
    const ys = drainWith(templateOrderCursor(t), [100]).map((i) => imageToCanvas({ ix: i % 4, iy: Math.floor(i / 4) }, t.placement, t.coordinateSystem).y);
    expect(ys).toEqual([5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3]); // canvas y decreases: the top row first
  });
});

describe('strategy input validation', () => {
  it('rejects mismatched configurations, malformed images and regions outside the image', () => {
    const img = art(['ab']);
    expectCode(() => topToBottom.order(img, { id: 'random' }), 'INVALID_CONFIG');
    expectCode(() => topToBottom.order({ width: 2, height: 2, pixels: new Uint32Array(3) }, { id: 'top-to-bottom' }), 'INVALID_IMAGE');
    expectCode(() => topToBottom.order({ width: 0, height: 1, pixels: new Uint32Array(0) }, { id: 'top-to-bottom' }), 'INVALID_IMAGE');
    expectCode(() => topToBottom.order(img, { id: 'top-to-bottom' }, { ix: 1, iy: 0, width: 2, height: 1 }), 'INVALID_REGION');
    expectCode(() => topToBottom.order(img, { id: 'top-to-bottom' }, { ix: 0.5, iy: 0, width: 1, height: 1 }), 'INVALID_REGION');
    expectCode(() => topToBottom.order(img, { id: 'top-to-bottom' }, { ix: 0, iy: 0, width: -1, height: 1 }), 'INVALID_REGION');
    expectCode(() => drawingStrategy('spiral' as never), 'INVALID_CONFIG');
    expect(drawingStrategy('left-to-right')).toBe(leftToRight);
    expect(TRANSPARENT_U32).toBe(0xffffffff);
  });
});
