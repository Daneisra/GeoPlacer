/**
 * Projection between template image space and canvas space.
 *
 * Spaces:
 * - image (source PNG) = template space: origin at the top-left pixel,
 *   ix grows to the right, iy grows downward. No crop, scale or rotation.
 * - canvas: defined by its provider's CoordinateSystem; y grows downward
 *   ('down') or upward ('up').
 * - placement: canvas position of image pixel (0, 0), the top-left pixel as
 *   seen on screen.
 *
 * Mapping (x never flips):
 *   x = topLeft.x + ix
 *   y = topLeft.y + iy   when yAxis = 'down'
 *   y = topLeft.y - iy   when yAxis = 'up'
 */

import type { CanvasPoint, CanvasRect, CoordinateSystem, ImagePoint, Projection, TemplatePlacement } from '../contracts/index.js';
import { GeometryError } from './errors.js';
import { rectArea, rectContainsRect, rectIntersection } from './rect.js';
import {
  assertCanvasPoint,
  assertCoordinateSystem,
  assertImagePoint,
  assertSize,
  safeAdd,
  type ImageSize,
} from './validate.js';

/** Precomputed, allocation-free mapping for one placement in one coordinate system. */
export interface PlacementTransform {
  readonly originX: number;
  readonly originY: number;
  /** +1 when the canvas y axis points down, -1 when it points up. */
  readonly yStep: 1 | -1;
}

export function placementTransform(placement: TemplatePlacement, system: CoordinateSystem): PlacementTransform {
  assertCoordinateSystem(system);
  assertCanvasPoint(placement.topLeft, 'placement.topLeft');
  // `+ 0` turns a -0 input (e.g. JSON.parse('-0')) into +0: coordinates stay canonical.
  return { originX: placement.topLeft.x + 0, originY: placement.topLeft.y + 0, yStep: system.yAxis === 'down' ? 1 : -1 };
}

/** Canvas x of image column ix (no validation: hot path). */
export function canvasXOf(transform: PlacementTransform, ix: number): number {
  return transform.originX + ix + 0;
}

/** Canvas y of image row iy (no validation: hot path). */
export function canvasYOf(transform: PlacementTransform, iy: number): number {
  return transform.originY + transform.yStep * iy + 0;
}

/** Image column of canvas x (no validation: hot path). */
export function imageXOf(transform: PlacementTransform, x: number): number {
  return x - transform.originX + 0;
}

/** Image row of canvas y (no validation: hot path). */
export function imageYOf(transform: PlacementTransform, y: number): number {
  return (transform.yStep === 1 ? y - transform.originY : transform.originY - y) + 0;
}

export function imageToCanvas(point: ImagePoint, placement: TemplatePlacement, system: CoordinateSystem): CanvasPoint {
  assertImagePoint(point);
  const t = placementTransform(placement, system);
  return {
    x: safeAdd(t.originX, point.ix, 'canvas x') + 0,
    y: safeAdd(t.originY, t.yStep * point.iy, 'canvas y') + 0,
  };
}

/**
 * Image coordinates of a canvas point. The result may lie outside the image
 * (negative or beyond its size): use locateInImage to get null instead.
 */
export function canvasToImage(point: CanvasPoint, placement: TemplatePlacement, system: CoordinateSystem): ImagePoint {
  assertCanvasPoint(point);
  const t = placementTransform(placement, system);
  const ix = imageXOf(t, point.x);
  const iy = imageYOf(t, point.y);
  if (!Number.isSafeInteger(ix) || !Number.isSafeInteger(iy)) {
    throw new GeometryError('OUT_OF_RANGE', 'image coordinates leave the safe-integer range');
  }
  return { ix, iy };
}

/** Image pixel under a canvas point, or null when the point is outside the template. */
export function locateInImage(point: CanvasPoint, size: ImageSize, placement: TemplatePlacement, system: CoordinateSystem): ImagePoint | null {
  assertSize(size);
  const image = canvasToImage(point, placement, system);
  return image.ix >= 0 && image.iy >= 0 && image.ix < size.width && image.iy < size.height ? image : null;
}

/** Canvas rectangle covered by a template of the given size. */
export function templateBounds(size: ImageSize, placement: TemplatePlacement, system: CoordinateSystem): CanvasRect {
  assertSize(size);
  const t = placementTransform(placement, system);
  safeAdd(t.originX, size.width - 1, 'template right edge');
  const minY = t.yStep === 1 ? t.originY : safeAdd(t.originY, -(size.height - 1), 'template lower edge');
  safeAdd(minY, size.height - 1, 'template upper edge');
  return { minX: t.originX, minY, width: size.width, height: size.height };
}

/** The Projection contract, implemented by the functions above. */
export const projection: Projection = {
  imageToCanvas,
  canvasToImage,
  bounds: templateBounds,
};

// ───────────────────────── Placement against canvas bounds ─────────────────────────

export type PlacementStatus = 'unbounded' | 'inside' | 'partially-outside' | 'outside';

export interface PlacementCheck {
  readonly status: PlacementStatus;
  /** Canvas rectangle covered by the template. */
  readonly covered: CanvasRect;
  /** Part of `covered` inside the canvas bounds (equal to `covered` when unbounded); null when outside. */
  readonly visible: CanvasRect | null;
  /** Template pixels (transparent ones included) that fall outside the bounds. */
  readonly pixelsOutside: number;
}

export function checkPlacement(size: ImageSize, placement: TemplatePlacement, system: CoordinateSystem): PlacementCheck {
  const covered = templateBounds(size, placement, system);
  const bounds = system.bounds;
  if (bounds === undefined) return { status: 'unbounded', covered, visible: covered, pixelsOutside: 0 };
  if (rectContainsRect(bounds, covered)) return { status: 'inside', covered, visible: covered, pixelsOutside: 0 };
  const visible = rectIntersection(bounds, covered);
  if (visible === null) return { status: 'outside', covered, visible: null, pixelsOutside: rectArea(covered) };
  return { status: 'partially-outside', covered, visible, pixelsOutside: rectArea(covered) - rectArea(visible) };
}

export interface PlacementPolicy {
  /** Accept a template that crosses the canvas bounds (its outside pixels are simply never painted). */
  readonly allowPartial: boolean;
}

/** Like checkPlacement, but throws when the placement violates the policy. */
export function assertPlacement(
  size: ImageSize,
  placement: TemplatePlacement,
  system: CoordinateSystem,
  policy: PlacementPolicy
): PlacementCheck {
  const check = checkPlacement(size, placement, system);
  if (check.status === 'outside') {
    throw new GeometryError('PLACEMENT_OUTSIDE_BOUNDS', 'the template does not intersect the canvas bounds');
  }
  if (check.status === 'partially-outside' && !policy.allowPartial) {
    throw new GeometryError(
      'PLACEMENT_PARTIALLY_OUTSIDE',
      `${check.pixelsOutside} template pixel(s) fall outside the canvas bounds`
    );
  }
  return check;
}
