/**
 * Explicit conversion between two coordinate systems describing the SAME
 * canvas (for instance a template stored with yAxis 'down' while the canvas
 * reader uses 'up'). The canvas reader's system is the reference.
 *
 * Rules (no silent correction):
 * - same y direction, compatible bounds        -> identity;
 * - same y direction, two different bounds     -> AMBIGUOUS_TRANSFORM;
 * - opposite y directions, identical x range
 *   and height in both bounds                  -> vertical reflection;
 * - opposite y directions, bounds missing or
 *   different                                  -> AMBIGUOUS_TRANSFORM
 *   (the reflection axis cannot be known).
 */

import type { CanvasPoint, CoordinateSystem, TemplatePlacement } from '../contracts/index.js';
import { GeometryError } from './errors.js';
import { rectEquals, rectMaxY } from './rect.js';
import { assertCanvasPoint, assertCoordinateSystem, safeAdd } from './validate.js';

export type CanvasTransform =
  | { readonly kind: 'identity' }
  /** y' = ySum - y, x unchanged. */
  | { readonly kind: 'flip-y'; readonly ySum: number };

export function canvasSystemTransform(from: CoordinateSystem, to: CoordinateSystem): CanvasTransform {
  assertCoordinateSystem(from, 'from');
  assertCoordinateSystem(to, 'to');

  if (from.yAxis === to.yAxis) {
    if (from.bounds !== undefined && to.bounds !== undefined && !rectEquals(from.bounds, to.bounds)) {
      throw new GeometryError('AMBIGUOUS_TRANSFORM', 'same y direction but different bounds: the systems may describe different canvases');
    }
    return { kind: 'identity' };
  }

  const fb = from.bounds;
  const tb = to.bounds;
  if (fb === undefined || tb === undefined) {
    throw new GeometryError('AMBIGUOUS_TRANSFORM', 'opposite y directions require the bounds of both systems to locate the reflection axis');
  }
  if (fb.minX !== tb.minX || fb.width !== tb.width || fb.height !== tb.height) {
    throw new GeometryError('AMBIGUOUS_TRANSFORM', 'opposite y directions require the same x range and the same height in both bounds');
  }
  // Row counted from the top of the screen is preserved:
  //   'down' -> 'up' : y' = maxY(to) - (y - minY(from))
  //   'up' -> 'down' : y' = minY(to) + (maxY(from) - y)
  const ySum = from.yAxis === 'down' ? safeAdd(rectMaxY(tb), fb.minY, 'reflection axis') : safeAdd(tb.minY, rectMaxY(fb), 'reflection axis');
  return { kind: 'flip-y', ySum };
}

export function applyCanvasTransform(point: CanvasPoint, transform: CanvasTransform): CanvasPoint {
  assertCanvasPoint(point);
  if (transform.kind === 'identity') return { x: point.x, y: point.y };
  return { x: point.x, y: safeAdd(transform.ySum, -point.y, 'reflected y') };
}

/**
 * Re-expresses a placement in another system of the same canvas. The
 * placement anchors the template's top-left pixel as seen on screen, so the
 * same physical pixel is simply converted.
 */
export function convertPlacement(placement: TemplatePlacement, from: CoordinateSystem, to: CoordinateSystem): TemplatePlacement {
  return { topLeft: applyCanvasTransform(placement.topLeft, canvasSystemTransform(from, to)) };
}
