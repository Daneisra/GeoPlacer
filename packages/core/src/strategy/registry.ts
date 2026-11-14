/**
 * The drawing strategies by id, and the drawing order of a loaded template.
 */

import type { DrawingOrderCursor, DrawingStrategy, DrawingStrategyId, Template } from '../contracts/index.js';
import { eligibleRegion, StrategyError } from './common.js';
import { centerOut, random } from './center-random.js';
import { colorByColor, outlineFirst } from './color-outline.js';
import { bottomToTop, leftToRight, rightToLeft, topToBottom } from './directional.js';

export const DRAWING_STRATEGIES: Readonly<Record<DrawingStrategyId, DrawingStrategy>> = {
  'top-to-bottom': topToBottom,
  'bottom-to-top': bottomToTop,
  'left-to-right': leftToRight,
  'right-to-left': rightToLeft,
  'center-out': centerOut,
  random,
  'color-by-color': colorByColor,
  'outline-first': outlineFirst,
};

export function drawingStrategy(id: DrawingStrategyId): DrawingStrategy {
  const strategy = Object.hasOwn(DRAWING_STRATEGIES, id) ? DRAWING_STRATEGIES[id] : undefined;
  if (strategy === undefined) throw new StrategyError('INVALID_CONFIG', `unknown drawing strategy '${String(id)}'`);
  return strategy;
}

/**
 * Drawing order of a loaded template revision: its strategy over its stored
 * (never re-quantized) image, restricted to the pixels inside the canvas
 * bounds. Pure: the current canvas content is not consulted here (the work
 * planner compares with a canvas snapshot afterwards).
 */
export function templateOrderCursor(template: Pick<Template, 'image' | 'strategy' | 'placement' | 'coordinateSystem'>): DrawingOrderCursor {
  const region = eligibleRegion(template.image, template.placement, template.coordinateSystem);
  return drawingStrategy(template.strategy.id).cursor(template.image, template.strategy, region);
}
