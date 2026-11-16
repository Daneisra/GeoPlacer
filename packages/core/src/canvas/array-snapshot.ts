/**
 * In-memory canvas snapshot over an Int32Array (pure, no I/O): the common
 * form of a simulated canvas region or of an imported image, once decoded by
 * an adapter.
 *
 * Layout: row-major over `rect`, by increasing canvas y then x, whatever the
 * y direction: pixels[(y - rect.minY) * rect.width + (x - rect.minX)].
 * Values: a 24-bit color, TRANSPARENT (-1, empty canvas pixel) or UNKNOWN
 * (-2, not observed). Points outside `rect` are UNKNOWN.
 */

import type { CanvasPixel, CanvasPoint, CanvasRect, CanvasSnapshot, CanvasSource, CoordinateSystem, Timestamp } from '../contracts/index.js';
import { UNKNOWN } from '../contracts/index.js';
import { assertCoordinateSystem, assertRect } from '../geometry/validate.js';

export interface ArraySnapshotInput {
  readonly rect: CanvasRect;
  readonly coordinateSystem: CoordinateSystem;
  readonly source: CanvasSource;
  readonly observedAt: Timestamp;
  readonly pixels: Int32Array;
}

export class SnapshotError extends Error {
  readonly code = 'INVALID_SNAPSHOT';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Builds a snapshot; the pixel array is used as is (not copied) and must not change afterwards. */
export function createArraySnapshot(input: ArraySnapshotInput): CanvasSnapshot {
  const { rect, coordinateSystem, source, observedAt, pixels } = input;
  assertRect(rect);
  assertCoordinateSystem(coordinateSystem);
  if (source !== 'simulated' && source !== 'imported-snapshot' && source !== 'geopixels-observed' && source !== 'geopixels-fixture') throw new SnapshotError(`unknown snapshot source ${String(source)}`);
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new SnapshotError('observedAt must be a non-negative integer timestamp');
  if (!(pixels instanceof Int32Array) || pixels.length !== rect.width * rect.height) {
    throw new SnapshotError('pixels must be an Int32Array of rect.width * rect.height entries');
  }
  const { minX, minY, width, height } = rect;
  return {
    rect,
    coordinateSystem,
    source,
    observedAt,
    get(point: CanvasPoint): CanvasPixel {
      const dx = point.x - minX;
      const dy = point.y - minY;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) return UNKNOWN;
      return pixels[dy * width + dx]! as CanvasPixel;
    },
    readRow(y: number, x0: number, x1: number, out: Int32Array): void {
      const count = x1 - x0;
      const dy = y - minY;
      if (dy < 0 || dy >= height) {
        out.fill(UNKNOWN, 0, count);
        return;
      }
      // Columns inside the rect are copied; the others are UNKNOWN, as with get().
      const from = Math.max(x0, minX);
      const to = Math.min(x1, minX + width);
      if (to <= from) {
        out.fill(UNKNOWN, 0, count);
        return;
      }
      out.fill(UNKNOWN, 0, from - x0);
      out.set(pixels.subarray(dy * width + (from - minX), dy * width + (to - minX)), from - x0);
      out.fill(UNKNOWN, to - x0, count);
    },
  };
}
