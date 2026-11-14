/**
 * Shared building blocks of the drawing strategies: input validation, the
 * eligible region, cursors and the strategy factory.
 *
 * Memory rule: no object per pixel. Orders are Uint32Array indices
 * (iy * width + ix); cursors scan the image or a typed array.
 */

import type {
  CoordinateSystem,
  DrawingOrderCursor,
  DrawingStrategy,
  DrawingStrategyId,
  ImageRect,
  StrategyConfig,
  TemplateImage,
  TemplatePlacement,
} from '../contracts/index.js';
import { checkPlacement, placementTransform } from '../geometry/projection.js';

export type StrategyErrorCode =
  /** Width/height not positive integers, or pixels.length !== width * height. */
  | 'INVALID_IMAGE'
  /** config.id is not this strategy, seed outside [0, 2^32), duplicate colorOrder entry. */
  | 'INVALID_CONFIG'
  /** Region not made of integers, or not inside the image. */
  | 'INVALID_REGION';

export class StrategyError extends Error {
  readonly code: StrategyErrorCode;

  constructor(code: StrategyErrorCode, message: string) {
    super(message);
    this.name = 'StrategyError';
    this.code = code;
  }
}

export function assertImage(image: TemplateImage): void {
  const { width, height, pixels } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new StrategyError('INVALID_IMAGE', `image size must be positive integers, got ${String(width)} x ${String(height)}`);
  }
  if (!(pixels instanceof Uint32Array) || pixels.length !== width * height) {
    throw new StrategyError('INVALID_IMAGE', 'image pixels must be a Uint32Array of width * height entries');
  }
}

/** The whole image when `region` is omitted; otherwise validated (an empty region is allowed). */
export function resolveRegion(image: TemplateImage, region?: ImageRect): ImageRect {
  if (region === undefined) return { ix: 0, iy: 0, width: image.width, height: image.height };
  const { ix, iy, width, height } = region;
  const ints = [ix, iy, width, height].every((v) => Number.isSafeInteger(v));
  if (!ints || ix < 0 || iy < 0 || width < 0 || height < 0 || ix + width > image.width || iy + height > image.height) {
    throw new StrategyError('INVALID_REGION', `region must be integers inside the ${image.width} x ${image.height} image`);
  }
  return { ix, iy, width, height };
}

export function isWholeImage(image: TemplateImage, region: ImageRect): boolean {
  return region.ix === 0 && region.iy === 0 && region.width === image.width && region.height === image.height;
}

/**
 * Part of the image inside the canvas bounds, in image coordinates. Whole
 * image when the canvas is unbounded or contains the template; empty
 * (width 0) when the template lies entirely outside. Pixels outside the
 * bounds can never be painted, so they are never eligible.
 */
export function eligibleRegion(
  size: { readonly width: number; readonly height: number },
  placement: TemplatePlacement,
  system: CoordinateSystem
): ImageRect {
  const check = checkPlacement(size, placement, system);
  if (check.visible === null) return { ix: 0, iy: 0, width: 0, height: 0 };
  const t = placementTransform(placement, system);
  const v = check.visible;
  const iy = t.yStep === 1 ? v.minY - t.originY : t.originY - (v.minY + v.height - 1);
  return { ix: v.minX - t.originX, iy, width: v.width, height: v.height };
}

/** Cursor over a precomputed order. */
export function arrayCursor(order: Uint32Array): DrawingOrderCursor {
  let position = 0;
  return {
    next(out) {
      const n = Math.min(out.length, order.length - position);
      out.set(order.subarray(position, position + n));
      position += n;
      return n;
    },
  };
}

/** Collects a cursor into one array (at most `bound` indices). */
export function drain(cursor: DrawingOrderCursor, bound: number): Uint32Array {
  const all = new Uint32Array(bound);
  let length = 0;
  const chunk = new Uint32Array(Math.max(1, Math.min(bound, 1 << 16)));
  for (let n = cursor.next(chunk); n > 0; n = cursor.next(chunk)) {
    all.set(chunk.subarray(0, n), length);
    length += n;
  }
  return length === bound ? all : all.slice(0, length);
}

type CursorFactory = (image: TemplateImage, config: StrategyConfig, region: ImageRect) => DrawingOrderCursor;

/** Builds a strategy: validation once, `order` derived from `cursor`. */
export function defineStrategy(id: DrawingStrategyId, version: number, make: CursorFactory): DrawingStrategy {
  const cursor = (image: TemplateImage, config: StrategyConfig, region?: ImageRect): DrawingOrderCursor => {
    assertImage(image);
    if (config.id !== id) throw new StrategyError('INVALID_CONFIG', `configuration for '${config.id}' given to strategy '${id}'`);
    return make(image, config, resolveRegion(image, region));
  };
  return {
    id,
    version,
    cursor,
    order(image, config, region) {
      const c = cursor(image, config, region);
      const r = resolveRegion(image, region);
      return drain(c, r.width * r.height);
    },
  };
}
