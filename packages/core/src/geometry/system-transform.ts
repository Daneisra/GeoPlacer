/**
 * Explicit conversion between two coordinate systems describing the SAME
 * canvas (for instance a template placement expressed with yAxis 'down'
 * while the canvas reader uses 'up'). The canvas reader's system is the
 * reference. The row counted from the top of the screen is always preserved.
 *
 * Rules (no silent correction):
 * - Both systems declare bounds: they must share minX, width and height
 *   (same canvas). Then:
 *     same y direction      -> vertical translation (identity when minY is equal);
 *     opposite y directions -> vertical reflection.
 *   Otherwise -> AMBIGUOUS_TRANSFORM.
 * - At least one system has no bounds:
 *     same y direction      -> identity (documented assumption: same origin);
 *     opposite y directions -> the reflection axis must be given explicitly
 *                              (options.reflectionYSum), otherwise
 *                              AMBIGUOUS_TRANSFORM. It is never guessed.
 */

import type { CanvasPoint, CoordinateSystem, TemplatePlacement } from '../contracts/index.js';
import { GeometryError } from './errors.js';
import { rectMaxY } from './rect.js';
import { assertCanvasPoint, assertCoordinateSystem, assertSafeInteger, safeAdd } from './validate.js';

export type CanvasTransform =
  | { readonly kind: 'identity' }
  /** y' = y + dy, x unchanged. */
  | { readonly kind: 'translate-y'; readonly dy: number }
  /** y' = ySum - y, x unchanged. */
  | { readonly kind: 'flip-y'; readonly ySum: number };

export interface SystemTransformOptions {
  /**
   * Explicit reflection axis (y' = reflectionYSum - y) for opposite y
   * directions when the bounds do not determine it. When both bounds are
   * known, it must agree with them.
   */
  readonly reflectionYSum?: number;
}

export function canvasSystemTransform(
  from: CoordinateSystem,
  to: CoordinateSystem,
  options: SystemTransformOptions = {}
): CanvasTransform {
  assertCoordinateSystem(from, 'from');
  assertCoordinateSystem(to, 'to');
  if (options.reflectionYSum !== undefined) assertSafeInteger(options.reflectionYSum, 'reflectionYSum');

  const sameDirection = from.yAxis === to.yAxis;
  if (sameDirection && options.reflectionYSum !== undefined) {
    throw new GeometryError('AMBIGUOUS_TRANSFORM', 'reflectionYSum only applies to opposite y directions');
  }

  const fb = from.bounds;
  const tb = to.bounds;
  if (fb !== undefined && tb !== undefined) {
    if (fb.minX !== tb.minX || fb.width !== tb.width || fb.height !== tb.height) {
      throw new GeometryError('AMBIGUOUS_TRANSFORM', 'the bounds differ in x range or size: the systems may describe different canvases');
    }
    if (sameDirection) {
      // Equal heights: the same screen row is minY + r ('down') or maxY - r ('up'),
      // so both directions translate by the difference of minY.
      const dy = safeAdd(tb.minY, -fb.minY, 'translation');
      return dy === 0 ? { kind: 'identity' } : { kind: 'translate-y', dy };
    }
    // 'down' -> 'up' : y' = maxY(to) - (y - minY(from)) ; 'up' -> 'down' : y' = minY(to) + (maxY(from) - y)
    const ySum = from.yAxis === 'down' ? safeAdd(rectMaxY(tb), fb.minY, 'reflection axis') : safeAdd(tb.minY, rectMaxY(fb), 'reflection axis');
    if (options.reflectionYSum !== undefined && options.reflectionYSum !== ySum) {
      throw new GeometryError('AMBIGUOUS_TRANSFORM', `reflectionYSum ${options.reflectionYSum} contradicts the bounds (${ySum})`);
    }
    return { kind: 'flip-y', ySum };
  }

  if (sameDirection) return { kind: 'identity' };
  if (options.reflectionYSum === undefined) {
    throw new GeometryError(
      'AMBIGUOUS_TRANSFORM',
      'opposite y directions without the bounds of both systems: give the reflection axis explicitly (reflectionYSum)'
    );
  }
  return { kind: 'flip-y', ySum: options.reflectionYSum };
}

export function applyCanvasTransform(point: CanvasPoint, transform: CanvasTransform): CanvasPoint {
  assertCanvasPoint(point);
  switch (transform.kind) {
    case 'identity':
      return { x: point.x + 0, y: point.y + 0 };
    case 'translate-y':
      return { x: point.x + 0, y: safeAdd(point.y, transform.dy, 'translated y') + 0 };
    case 'flip-y':
      return { x: point.x + 0, y: safeAdd(transform.ySum, -point.y, 'reflected y') + 0 };
  }
}

/**
 * Re-expresses a placement in another system of the same canvas. The
 * placement anchors the template's top-left pixel as seen on screen, so the
 * same physical pixel is simply converted.
 */
export function convertPlacement(
  placement: TemplatePlacement,
  from: CoordinateSystem,
  to: CoordinateSystem,
  options: SystemTransformOptions = {}
): TemplatePlacement {
  return { topLeft: applyCanvasTransform(placement.topLeft, canvasSystemTransform(from, to, options)) };
}
