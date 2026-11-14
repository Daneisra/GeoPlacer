/**
 * Axis-aligned integer rectangles. Edges are inclusive: a rect covers
 * x in [minX, maxX] and y in [minY, maxY], whatever the canvas y direction.
 */

import type { CanvasPoint, CanvasRect } from '../contracts/index.js';

export function rectMaxX(rect: CanvasRect): number {
  return rect.minX + rect.width - 1;
}

export function rectMaxY(rect: CanvasRect): number {
  return rect.minY + rect.height - 1;
}

export function rectArea(rect: CanvasRect): number {
  return rect.width * rect.height;
}

export function rectContains(rect: CanvasRect, point: CanvasPoint): boolean {
  return point.x >= rect.minX && point.x <= rectMaxX(rect) && point.y >= rect.minY && point.y <= rectMaxY(rect);
}

export function rectContainsRect(outer: CanvasRect, inner: CanvasRect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.minY >= outer.minY &&
    rectMaxX(inner) <= rectMaxX(outer) &&
    rectMaxY(inner) <= rectMaxY(outer)
  );
}

/** Overlap of two rectangles, or null when they do not intersect. */
export function rectIntersection(a: CanvasRect, b: CanvasRect): CanvasRect | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(rectMaxX(a), rectMaxX(b));
  const maxY = Math.min(rectMaxY(a), rectMaxY(b));
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function rectEquals(a: CanvasRect, b: CanvasRect): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.width === b.width && a.height === b.height;
}
