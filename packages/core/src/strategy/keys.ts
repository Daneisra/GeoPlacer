/**
 * Order keys (Phase 1B.6): a numeric sort key per pixel such that sorting
 * the paintable pixels by key gives EXACTLY the strategy order, tie rules
 * included. A work planner can then pick the next pixels among those still
 * to paint without generating the full order.
 *
 *   top-to-bottom   index                         (iy * W + ix)
 *   bottom-to-top   (H - 1 - iy) * W + ix
 *   left-to-right   ix * H + iy
 *   right-to-left   (W - 1 - ix) * H + iy
 *   center-out      d2 * N + index                (d2 in doubled coordinates)
 *   color-by-color  colorRank * N + index         (rank computed once)
 *   outline-first   (outline ? 0 : 1) * N + index
 *   random          position in the PCG32 v1 order (rank table, 4 bytes/pixel)
 *
 * N = W * H. Every key is an integer below 2^53; prepareOrderKeys refuses
 * an image for which that cannot be guaranteed.
 */

import type { DrawingStrategyId, StrategyConfig, TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { colorRanking } from './color-outline.js';
import { ColorIdTable } from './color-table.js';
import { assertImage, StrategyError } from './common.js';
import { random } from './center-random.js';

export interface OrderKeys {
  readonly strategy: DrawingStrategyId;
  /** Version of the strategy order the keys reproduce. */
  readonly version: number;
  /** Sort key of a PAINTABLE pixel index (iy * width + ix): smaller comes first. */
  key(index: number): number;
  /** Bytes held by the keys (rank table, color ranks). */
  readonly bytes: number;
}

const NOT_RANKED = 0xffffffff;

/** Rank table of an order: rank[order[k]] = k; other pixels NOT_RANKED. */
export function rankTable(pixelCount: number, order: Uint32Array): Uint32Array {
  const ranks = new Uint32Array(pixelCount).fill(NOT_RANKED);
  for (let k = 0; k < order.length; k++) ranks[order[k]!] = k;
  return ranks;
}

/**
 * Keys of a strategy for one image. For `random`, `randomOrder` may supply
 * an already verified order (cache); otherwise it is generated (the costly
 * case, done once per revision).
 */
export function prepareOrderKeys(image: TemplateImage, config: StrategyConfig, options: { readonly randomOrder?: Uint32Array } = {}): OrderKeys {
  assertImage(image);
  const { width: W, height: H, pixels } = image;
  const N = W * H;
  const versionOf = (id: DrawingStrategyId): number => (id === 'random' ? random.version : 1);
  const make = (key: (i: number) => number, bytes = 0): OrderKeys => ({ strategy: config.id, version: versionOf(config.id), key, bytes });
  switch (config.id) {
    case 'top-to-bottom':
      return make((i) => i);
    case 'bottom-to-top':
      return make((i) => {
        const iy = Math.floor(i / W);
        return (H - 1 - iy) * W + (i - iy * W);
      });
    case 'left-to-right':
      return make((i) => {
        const iy = Math.floor(i / W);
        return (i - iy * W) * H + iy;
      });
    case 'right-to-left':
      return make((i) => {
        const iy = Math.floor(i / W);
        return (W - 1 - (i - iy * W)) * H + iy;
      });
    case 'center-out': {
      const maxD2 = (W - 1) * (W - 1) + (H - 1) * (H - 1);
      if ((maxD2 + 1) * N > Number.MAX_SAFE_INTEGER) throw new StrategyError('INVALID_IMAGE', 'image too large for exact center-out keys');
      return make((i) => {
        const iy = Math.floor(i / W);
        const dx = 2 * (i - iy * W) - (W - 1);
        const dy = 2 * iy - (H - 1);
        return (dx * dx + dy * dy) * N + i;
      });
    }
    case 'color-by-color': {
      const { colors } = colorRanking(image, config);
      if (colors.length * N > Number.MAX_SAFE_INTEGER) throw new StrategyError('INVALID_IMAGE', 'too many colors for exact color-by-color keys');
      // Phase 1B.7: typed open-addressing table (id = rank) instead of a Map:
      // the lookup dominates on noisy images, where the color changes at every pixel.
      const rankOf = new ColorIdTable(colors.length);
      for (const c of colors) rankOf.idOf(c);
      let lastColor = TRANSPARENT_U32;
      let lastRank = 0;
      return make((i) => {
        const c = pixels[i]!;
        if (c !== lastColor) {
          lastColor = c;
          lastRank = Math.max(0, rankOf.find(c));
        }
        return lastRank * N + i;
      }, rankOf.bytes);
    }
    case 'outline-first': {
      // Phase 1B.7: outline bitmap computed once per revision (N / 8 bytes)
      // instead of four neighbour reads per candidate.
      const outline = new Uint8Array((N + 7) >> 3);
      for (let iy = 0; iy < H; iy++) {
        const edgeRow = iy === 0 || iy === H - 1;
        for (let ix = 0, i = iy * W; ix < W; ix++, i++) {
          const p = pixels[i];
          if (edgeRow || ix === 0 || ix === W - 1 || pixels[i - 1] !== p || pixels[i + 1] !== p || pixels[i - W] !== p || pixels[i + W] !== p) outline[i >> 3]! |= 1 << (i & 7);
        }
      }
      return make((i) => ((outline[i >> 3]! >> (i & 7)) & 1 ? i : N + i), outline.byteLength);
    }
    case 'random': {
      const order = options.randomOrder ?? random.order(image, config);
      const ranks = rankTable(N, order);
      return make((i) => ranks[i]!, ranks.byteLength);
    }
  }
}
