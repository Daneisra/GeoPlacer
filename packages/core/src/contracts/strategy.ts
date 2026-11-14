/**
 * Drawing strategies. Layer 3.
 */

import type { DrawingStrategyId, StrategyConfig, TemplateImage } from './template.js';

/**
 * Pure and deterministic: returns the drawing order as image pixel indices
 * (iy * width + ix) of the non-transparent pixels — a permutation, with no
 * loss and no duplicate. Defined in image space (as the user sees the
 * template), independent of the canvas y direction.
 */
export interface DrawingStrategy {
  readonly id: DrawingStrategyId;
  order(image: TemplateImage, config: StrategyConfig): Uint32Array;
}
