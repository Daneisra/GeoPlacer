/**
 * The single classification of template pixels against a canvas snapshot
 * (Phase 1B.6), shared by the progress calculator and the work planner so
 * that "correct", "incorrect" and "unknown" have one definition.
 *
 * Row by row over the eligible region (image order). The snapshot row is
 * read with readRow when the snapshot provides it (copy into a buffer),
 * otherwise pixel by pixel with get and one reused point: same values, same
 * rules for unknown and invalid ones.
 */

import type { CanvasPixel, CanvasSnapshot, ImageRect, ProgressTemplate } from '../contracts/index.js';
import { TRANSPARENT, TRANSPARENT_U32, UNKNOWN } from '../contracts/index.js';
import { placementTransform } from '../geometry/projection.js';
import { eligibleRegion } from '../strategy/common.js';

/** Per-pixel state codes written into the row's state buffer. */
export const PixelState = {
  /** Transparent template pixel: not eligible. */
  TRANSPARENT: 0,
  CORRECT: 1,
  /** Observed, another 24-bit color. */
  WRONG_COLOR: 2,
  /** Observed, empty canvas pixel. */
  MISSING: 3,
  /** Not observed (outside the snapshot, or UNKNOWN). */
  UNKNOWN: 4,
  /** Observed value neither a 24-bit color nor a sentinel: counted as unknown. */
  INVALID: 5,
} as const;

/**
 * The ONE classification of an observed value against the expected color
 * (also used by the incremental progress, Phase 1B.10).
 */
export function classifyValue(expected: number, seen: CanvasPixel | number): number {
  if (expected === TRANSPARENT_U32) return PixelState.TRANSPARENT;
  if (seen === expected) return PixelState.CORRECT;
  if (seen === UNKNOWN) return PixelState.UNKNOWN;
  if (seen === TRANSPARENT) return PixelState.MISSING;
  if (Number.isInteger(seen) && seen >= 0 && seen <= 0xffffff) return PixelState.WRONG_COLOR;
  return PixelState.INVALID;
}

export interface RowScan {
  /** Image row. */
  readonly iy: number;
  /** First image column of the row segment (the eligible region's ix). */
  readonly ix0: number;
  /** Canvas coordinates of (ix0, iy). */
  readonly x0: number;
  readonly y: number;
  readonly count: number;
  /** States of the `count` pixels (PixelState codes); reused between rows. */
  readonly states: Uint8Array;
}

/**
 * Calls `onRow` for every row of the eligible region, by increasing image
 * row (or decreasing with `descending`: same rows, same states). The
 * template and snapshot must share the coordinate system (checked by the
 * callers).
 */
export function scanEligibleRows(template: ProgressTemplate, snapshot: CanvasSnapshot, onRow: (row: RowScan) => void, descending = false): ImageRect {
  const { image, placement, coordinateSystem } = template;
  const { width, pixels } = image;
  const region = eligibleRegion(image, placement, coordinateSystem);
  const t = placementTransform(placement, coordinateSystem);
  const readRow = snapshot.readRow?.bind(snapshot);
  // readRow fills Int32 values; get() may return anything (NaN, fractions):
  // a Float64Array keeps such invalid values instead of truncating them.
  const rowValues = new Int32Array(readRow !== undefined ? region.width : 0);
  const pointValues = new Float64Array(readRow !== undefined ? 0 : region.width);
  const observed: Int32Array | Float64Array = readRow !== undefined ? rowValues : pointValues;
  const states = new Uint8Array(region.width);
  const point = { x: 0, y: 0 };
  const x0 = t.originX + region.ix;
  // Pixels outside the snapshot rectangle are unknown, without asking the snapshot.
  const { minX: rx0, minY: ry0 } = snapshot.rect;
  const rx1 = rx0 + snapshot.rect.width;
  const ry1 = ry0 + snapshot.rect.height;
  const kFrom = Math.max(0, Math.min(region.width, rx0 - x0));
  const kTo = Math.max(kFrom, Math.min(region.width, rx1 - x0));
  for (let r = 0; r < region.height; r++) {
    const iy = descending ? region.iy + region.height - 1 - r : region.iy + r;
    const y = t.originY + t.yStep * iy;
    observed.fill(UNKNOWN);
    if (y >= ry0 && y < ry1 && kTo > kFrom) {
      if (readRow !== undefined) readRow(y, x0 + kFrom, x0 + kTo, rowValues.subarray(kFrom, kTo));
      else {
        point.y = y;
        for (let k = kFrom; k < kTo; k++) {
          point.x = x0 + k;
          pointValues[k] = snapshot.get(point) as number;
        }
      }
    }
    const base = iy * width + region.ix;
    for (let k = 0; k < region.width; k++) states[k] = classifyValue(pixels[base + k]!, observed[k]!);
    onRow({ iy, ix0: region.ix, x0, y, count: region.width, states });
  }
  return region;
}
