/**
 * Drawing strategies. Layer 3.
 */

import type { DrawingStrategyId, StrategyConfig, TemplateImage } from './template.js';

/**
 * Image-space rectangle: ix in [ix, ix + width), iy in [iy, iy + height).
 * The eligible region of a template is the part of its image inside the
 * canvas bounds (strategy/region: eligibleRegion).
 */
export interface ImageRect {
  readonly ix: number;
  readonly iy: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Lazily produced drawing order. Batch size never changes the sequence:
 * concatenating the batches always gives `order()`.
 */
export interface DrawingOrderCursor {
  /** Writes the next image indices into `out`; returns how many (0 = finished, then always 0). */
  next(out: Uint32Array): number;
}

/**
 * Pure and deterministic: returns the drawing order as image pixel indices
 * (iy * width + ix) of the non-transparent pixels — a permutation, with no
 * loss and no duplicate. Defined in image space (as the user sees the
 * template), independent of the canvas y direction and of the placement.
 *
 * Eligible region (Phase 1B.3 amendment): with a region, the result is
 * exactly the full order filtered to the pixels inside it. The order is
 * therefore never computed relative to the region (its centre, its edges,
 * its colors): moving a template only adds or removes pixels at the
 * clipped edges, the relative order of the others never changes.
 */
export interface DrawingStrategy {
  readonly id: DrawingStrategyId;
  /** Version of the ordering rule: any change of the order for the same input bumps it. */
  readonly version: number;
  order(image: TemplateImage, config: StrategyConfig, region?: ImageRect): Uint32Array;
  /** Same sequence as `order`, produced in batches (the first batch is cheap for most strategies). */
  cursor(image: TemplateImage, config: StrategyConfig, region?: ImageRect): DrawingOrderCursor;
}

/**
 * Identity of a cached strategy order (Phase 1B.6). The order of the whole
 * image does not depend on the placement, but the key includes the template
 * revision as requested: a new revision rebuilds the cache.
 */
export interface OrderCacheKey {
  readonly projectId: string;
  readonly templateId: string;
  readonly revision: number;
  readonly strategy: DrawingStrategyId;
  readonly strategyVersion: number;
  readonly seed: number;
  /** SHA-256 of the canonical quantized pixels of the revision. */
  readonly quantizedImageHash: string;
  /** Cache file format. */
  readonly format: 1;
}

/**
 * Optional storage of strategy orders. Never the source of truth: a
 * missing, damaged or mismatching entry is rebuilt from the strategy.
 */
export interface OrderCacheStore {
  read(key: OrderCacheKey): Promise<Uint8Array | null>;
  write(key: OrderCacheKey, bytes: Uint8Array): Promise<void>;
}
