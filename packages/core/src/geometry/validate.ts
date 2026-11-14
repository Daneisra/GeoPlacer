/**
 * Input validation for geometry. Coordinates are safe integers (negative
 * values are allowed unless the canvas bounds exclude them); sizes are >= 1.
 */

import type { CanvasPoint, CanvasRect, CoordinateSystem, ImagePoint } from '../contracts/index.js';
import { GeometryError } from './errors.js';

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new GeometryError('NOT_AN_INTEGER', `${name} must be a safe integer, got ${String(value)}`);
  }
}

/** Result of an addition that must stay a safe integer. */
export function safeAdd(a: number, b: number, what: string): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new GeometryError('OUT_OF_RANGE', `${what} leaves the safe-integer range (${a} + ${b})`);
  }
  return sum;
}

export function assertSize(size: ImageSize, name = 'size'): void {
  assertSafeInteger(size.width, `${name}.width`);
  assertSafeInteger(size.height, `${name}.height`);
  if (size.width < 1 || size.height < 1) {
    throw new GeometryError('INVALID_SIZE', `${name} must be at least 1x1, got ${size.width}x${size.height}`);
  }
}

export function assertCanvasPoint(point: CanvasPoint, name = 'point'): void {
  assertSafeInteger(point.x, `${name}.x`);
  assertSafeInteger(point.y, `${name}.y`);
}

export function assertImagePoint(point: ImagePoint, name = 'point'): void {
  assertSafeInteger(point.ix, `${name}.ix`);
  assertSafeInteger(point.iy, `${name}.iy`);
}

export function assertRect(rect: CanvasRect, name = 'rect'): void {
  assertSafeInteger(rect.minX, `${name}.minX`);
  assertSafeInteger(rect.minY, `${name}.minY`);
  assertSize(rect, name);
  safeAdd(rect.minX, rect.width - 1, `${name} right edge`);
  safeAdd(rect.minY, rect.height - 1, `${name} bottom edge`);
}

/** Rejects unknown y directions (e.g. a value read from an untrusted JSON file). */
export function assertCoordinateSystem(system: CoordinateSystem, name = 'coordinateSystem'): void {
  const yAxis: unknown = (system as { readonly yAxis?: unknown }).yAxis;
  if (yAxis !== 'down' && yAxis !== 'up') {
    throw new GeometryError('UNKNOWN_COORDINATE_SYSTEM', `${name}.yAxis must be "down" or "up", got ${JSON.stringify(yAxis)}`);
  }
  if (system.bounds !== undefined) assertRect(system.bounds, `${name}.bounds`);
}
