import { describe, expect, it } from 'vitest';
import type { CanvasPoint, CoordinateSystem, TemplatePlacement } from '../src/index.js';
import {
  GeometryError,
  applyCanvasTransform,
  assertPlacement,
  canvasSystemTransform,
  canvasToImage,
  canvasXOf,
  canvasYOf,
  checkPlacement,
  convertPlacement,
  imageToCanvas,
  imageXOf,
  imageYOf,
  locateInImage,
  placementTransform,
  projection,
  rectContains,
  rectIntersection,
  templateBounds,
} from '../src/index.js';

const DOWN: CoordinateSystem = { yAxis: 'down' };
const UP: CoordinateSystem = { yAxis: 'up' };
const at = (x: number, y: number): TemplatePlacement => ({ topLeft: { x, y } });

function expectGeometryError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GeometryError);
    expect((error as GeometryError).code).toBe(code);
    return;
  }
  throw new Error(`expected GeometryError ${code}`);
}

describe('projection: image -> canvas', () => {
  it('maps a 1x1 image onto its anchor, whatever the y direction', () => {
    for (const system of [DOWN, UP]) {
      expect(imageToCanvas({ ix: 0, iy: 0 }, at(7, -3), system)).toEqual({ x: 7, y: -3 });
      expect(templateBounds({ width: 1, height: 1 }, at(7, -3), system)).toEqual({ minX: 7, minY: -3, width: 1, height: 1 });
    }
  });

  it('maps a non-square image with y pointing down', () => {
    const p = at(10, 20);
    expect(imageToCanvas({ ix: 0, iy: 0 }, p, DOWN)).toEqual({ x: 10, y: 20 });
    expect(imageToCanvas({ ix: 2, iy: 0 }, p, DOWN)).toEqual({ x: 12, y: 20 });
    expect(imageToCanvas({ ix: 0, iy: 1 }, p, DOWN)).toEqual({ x: 10, y: 21 });
    expect(imageToCanvas({ ix: 2, iy: 1 }, p, DOWN)).toEqual({ x: 12, y: 21 });
    expect(templateBounds({ width: 3, height: 2 }, p, DOWN)).toEqual({ minX: 10, minY: 20, width: 3, height: 2 });
  });

  it('flips rows when y points up (the top row keeps the anchor)', () => {
    const p = at(10, 20);
    expect(imageToCanvas({ ix: 0, iy: 0 }, p, UP)).toEqual({ x: 10, y: 20 });
    expect(imageToCanvas({ ix: 2, iy: 1 }, p, UP)).toEqual({ x: 12, y: 19 });
    expect(templateBounds({ width: 3, height: 2 }, p, UP)).toEqual({ minX: 10, minY: 19, width: 3, height: 2 });
  });

  it('supports negative coordinates and a non-zero origin', () => {
    expect(imageToCanvas({ ix: 1, iy: 1 }, at(-5, -5), DOWN)).toEqual({ x: -4, y: -4 });
    expect(imageToCanvas({ ix: 1, iy: 1 }, at(-5, -5), UP)).toEqual({ x: -4, y: -6 });
    expect(templateBounds({ width: 4, height: 3 }, at(-2, 1), UP)).toEqual({ minX: -2, minY: -1, width: 4, height: 3 });
  });

  it('agrees with the bounds: every pixel lies inside, corners on the edges', () => {
    for (const system of [DOWN, UP]) {
      const size = { width: 5, height: 3 };
      const placement = at(100, -50);
      const rect = templateBounds(size, placement, system);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let iy = 0; iy < size.height; iy++) {
        for (let ix = 0; ix < size.width; ix++) {
          const p = imageToCanvas({ ix, iy }, placement, system);
          expect(rectContains(rect, p)).toBe(true);
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      expect({ minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 }).toEqual(rect);
    }
  });

  it('implements the Projection contract', () => {
    expect(projection.imageToCanvas({ ix: 1, iy: 2 }, at(0, 0), UP)).toEqual({ x: 1, y: -2 });
    expect(projection.canvasToImage({ x: 1, y: -2 }, at(0, 0), UP)).toEqual({ ix: 1, iy: 2 });
    expect(projection.bounds({ width: 2, height: 2 }, at(0, 0), DOWN)).toEqual({ minX: 0, minY: 0, width: 2, height: 2 });
  });
});

describe('projection: canvas -> image and round trips', () => {
  it('round-trips every pixel of a non-square image in both directions', () => {
    for (const system of [DOWN, UP]) {
      const placement = at(-3, 8);
      for (let iy = 0; iy < 4; iy++) {
        for (let ix = 0; ix < 7; ix++) {
          const canvas = imageToCanvas({ ix, iy }, placement, system);
          expect(canvasToImage(canvas, placement, system)).toEqual({ ix, iy });
          expect(imageToCanvas(canvasToImage(canvas, placement, system), placement, system)).toEqual(canvas);
        }
      }
    }
  });

  it('never produces negative zero', () => {
    const image = canvasToImage({ x: 0, y: 0 }, at(0, 0), UP);
    expect(Object.is(image.ix, 0)).toBe(true);
    expect(Object.is(image.iy, 0)).toBe(true);
    expect(Object.is(imageYOf(placementTransform(at(0, 0), UP), 0), 0)).toBe(true);
  });

  it('reports canvas points outside the template', () => {
    const size = { width: 3, height: 2 };
    expect(canvasToImage({ x: 9, y: 20 }, at(10, 20), DOWN)).toEqual({ ix: -1, iy: 0 });
    expect(locateInImage({ x: 9, y: 20 }, size, at(10, 20), DOWN)).toBeNull();
    expect(locateInImage({ x: 13, y: 20 }, size, at(10, 20), DOWN)).toBeNull();
    expect(locateInImage({ x: 12, y: 21 }, size, at(10, 20), DOWN)).toEqual({ ix: 2, iy: 1 });
    // With y up, the row below the anchor (y - 1) is image row 1.
    expect(locateInImage({ x: 12, y: 19 }, size, at(10, 20), UP)).toEqual({ ix: 2, iy: 1 });
    expect(locateInImage({ x: 12, y: 21 }, size, at(10, 20), UP)).toBeNull();
  });

  it('allocation-free helpers match the checked functions', () => {
    for (const system of [DOWN, UP]) {
      const placement = at(-7, 13);
      const t = placementTransform(placement, system);
      for (const [ix, iy] of [[0, 0], [4, 9], [123, 45]] as const) {
        const p = imageToCanvas({ ix, iy }, placement, system);
        expect([canvasXOf(t, ix), canvasYOf(t, iy)]).toEqual([p.x, p.y]);
        expect([imageXOf(t, p.x), imageYOf(t, p.y)]).toEqual([ix, iy]);
      }
    }
  });
});

describe('placement against canvas bounds', () => {
  const bounded = (yAxis: 'down' | 'up'): CoordinateSystem => ({ yAxis, bounds: { minX: 0, minY: 0, width: 10, height: 10 } });
  const size = { width: 4, height: 3 };

  it('accepts a template touching the bounds exactly (boundary pixels)', () => {
    expect(checkPlacement(size, at(0, 0), bounded('down')).status).toBe('inside');
    expect(checkPlacement(size, at(6, 7), bounded('down')).status).toBe('inside');
    expect(checkPlacement(size, at(6, 9), bounded('up')).status).toBe('inside');
    expect(checkPlacement(size, at(0, 2), bounded('up')).status).toBe('inside');
  });

  it('detects partial overflow and counts the outside pixels', () => {
    const check = checkPlacement(size, at(8, 8), bounded('down'));
    expect(check.status).toBe('partially-outside');
    expect(check.visible).toEqual({ minX: 8, minY: 8, width: 2, height: 2 });
    expect(check.pixelsOutside).toBe(12 - 4);
    // y up: anchor on the top row, the template extends below y = 0.
    const up = checkPlacement(size, at(0, 1), bounded('up'));
    expect(up.status).toBe('partially-outside');
    expect(up.visible).toEqual({ minX: 0, minY: 0, width: 4, height: 2 });
  });

  it('detects a template entirely outside, including on negative coordinates', () => {
    expect(checkPlacement(size, at(-10, -10), bounded('down')).status).toBe('outside');
    expect(checkPlacement(size, at(10, 0), bounded('down')).status).toBe('outside');
  });

  it('reports unbounded systems without guessing limits', () => {
    expect(checkPlacement(size, at(-1_000_000, 5), DOWN)).toMatchObject({ status: 'unbounded', pixelsOutside: 0 });
  });

  it('applies the placement policy', () => {
    expect(assertPlacement(size, at(8, 8), bounded('down'), { allowPartial: true }).status).toBe('partially-outside');
    expectGeometryError(() => assertPlacement(size, at(8, 8), bounded('down'), { allowPartial: false }), 'PLACEMENT_PARTIALLY_OUTSIDE');
    expectGeometryError(() => assertPlacement(size, at(50, 50), bounded('down'), { allowPartial: true }), 'PLACEMENT_OUTSIDE_BOUNDS');
  });

  it('intersects rectangles, including the empty case', () => {
    expect(rectIntersection({ minX: 0, minY: 0, width: 2, height: 2 }, { minX: 2, minY: 0, width: 2, height: 2 })).toBeNull();
    expect(rectIntersection({ minX: 0, minY: 0, width: 3, height: 3 }, { minX: 2, minY: 2, width: 5, height: 5 })).toEqual({
      minX: 2, minY: 2, width: 1, height: 1,
    });
  });
});

describe('invalid input is rejected, never corrected', () => {
  it('rejects non-integer coordinates and sizes', () => {
    for (const bad of [0.5, NaN, Infinity, -Infinity, 2 ** 53]) {
      expectGeometryError(() => imageToCanvas({ ix: bad, iy: 0 }, at(0, 0), DOWN), 'NOT_AN_INTEGER');
      expectGeometryError(() => imageToCanvas({ ix: 0, iy: 0 }, at(bad, 0), DOWN), 'NOT_AN_INTEGER');
      expectGeometryError(() => templateBounds({ width: bad, height: 1 }, at(0, 0), DOWN), 'NOT_AN_INTEGER');
    }
  });

  it('rejects empty sizes', () => {
    expectGeometryError(() => templateBounds({ width: 0, height: 1 }, at(0, 0), DOWN), 'INVALID_SIZE');
    expectGeometryError(() => templateBounds({ width: 3, height: -2 }, at(0, 0), DOWN), 'INVALID_SIZE');
  });

  it('rejects unknown coordinate systems (e.g. from an untrusted JSON file)', () => {
    const weird = JSON.parse('{"yAxis":"left"}') as CoordinateSystem;
    expectGeometryError(() => imageToCanvas({ ix: 0, iy: 0 }, at(0, 0), weird), 'UNKNOWN_COORDINATE_SYSTEM');
    expectGeometryError(() => checkPlacement({ width: 1, height: 1 }, at(0, 0), { yAxis: 'down', bounds: { minX: 0, minY: 0, width: 0, height: 5 } }), 'INVALID_SIZE');
  });

  it('rejects results beyond the safe-integer range', () => {
    const edge = Number.MAX_SAFE_INTEGER;
    expectGeometryError(() => imageToCanvas({ ix: 1, iy: 0 }, at(edge, 0), DOWN), 'OUT_OF_RANGE');
    expectGeometryError(() => templateBounds({ width: 2, height: 1 }, at(edge, 0), DOWN), 'OUT_OF_RANGE');
    expectGeometryError(() => templateBounds({ width: 1, height: 2 }, at(0, -edge), UP), 'OUT_OF_RANGE');
  });
});

describe('conversion between coordinate systems of the same canvas', () => {
  const bounds = { minX: 0, minY: 0, width: 10, height: 10 };
  const downB: CoordinateSystem = { yAxis: 'down', bounds };
  const upB: CoordinateSystem = { yAxis: 'up', bounds };

  it('is the identity for the same y direction', () => {
    expect(canvasSystemTransform(DOWN, downB)).toEqual({ kind: 'identity' });
    expect(applyCanvasTransform({ x: 3, y: 4 }, { kind: 'identity' })).toEqual({ x: 3, y: 4 });
  });

  it('reflects rows between y down and y up', () => {
    const t = canvasSystemTransform(downB, upB);
    expect(t).toEqual({ kind: 'flip-y', ySum: 9 });
    expect(applyCanvasTransform({ x: 3, y: 0 }, t)).toEqual({ x: 3, y: 9 });
    expect(applyCanvasTransform({ x: 3, y: 9 }, t)).toEqual({ x: 3, y: 0 });
    // The reverse transform undoes it.
    const back = canvasSystemTransform(upB, downB);
    const p: CanvasPoint = { x: 2, y: 6 };
    expect(applyCanvasTransform(applyCanvasTransform(p, t), back)).toEqual(p);
  });

  it('handles bounds with a non-zero origin', () => {
    const from: CoordinateSystem = { yAxis: 'down', bounds: { minX: -5, minY: 100, width: 20, height: 50 } };
    const to: CoordinateSystem = { yAxis: 'up', bounds: { minX: -5, minY: -25, width: 20, height: 50 } };
    // Top row on screen: y = 100 (down) <-> y = 24 (up, maxY).
    expect(applyCanvasTransform({ x: 0, y: 100 }, canvasSystemTransform(from, to))).toEqual({ x: 0, y: 24 });
    expect(applyCanvasTransform({ x: 0, y: 149 }, canvasSystemTransform(from, to))).toEqual({ x: 0, y: -25 });
  });

  it('a converted placement paints exactly the same physical pixels', () => {
    const size = { width: 4, height: 3 };
    const original = at(2, 5);
    const converted = convertPlacement(original, downB, upB);
    const toUp = canvasSystemTransform(downB, upB);
    for (let iy = 0; iy < size.height; iy++) {
      for (let ix = 0; ix < size.width; ix++) {
        const physical = applyCanvasTransform(imageToCanvas({ ix, iy }, original, downB), toUp);
        expect(imageToCanvas({ ix, iy }, converted, upB)).toEqual(physical);
      }
    }
  });

  it('refuses ambiguous conversions instead of guessing', () => {
    expectGeometryError(() => canvasSystemTransform(DOWN, UP), 'AMBIGUOUS_TRANSFORM');
    expectGeometryError(() => canvasSystemTransform(downB, UP), 'AMBIGUOUS_TRANSFORM');
    expectGeometryError(() => canvasSystemTransform(downB, { yAxis: 'up', bounds: { ...bounds, height: 11 } }), 'AMBIGUOUS_TRANSFORM');
    expectGeometryError(() => canvasSystemTransform(downB, { yAxis: 'down', bounds: { ...bounds, minX: 1 } }), 'AMBIGUOUS_TRANSFORM');
  });
});
