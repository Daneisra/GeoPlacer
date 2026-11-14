/**
 * Property tests of the 8 drawing strategies on random images (sizes from
 * 1 x 1, rectangles, even and odd sides, transparent areas, one or many
 * colors), random regions, placements and batch sizes.
 */

import { describe, expect, it } from 'vitest';
import type { CoordinateSystem, DrawingStrategy, StrategyConfig, TemplateImage } from '../src/index.js';
import {
  DRAWING_STRATEGIES,
  TRANSPARENT_U32,
  asProjectId,
  createMemoryTemplateStorage,
  createTemplateManager,
  eligibleRegion,
  rgb,
  templateOrderCursor,
} from '../src/index.js';
import { rgbaPng } from './helpers/png.js';
import { manualClock, sequentialIds, testCodec, testHasher } from './helpers/ports.js';
import { drainWith, image, inRegion, paintable, testRandom } from './helpers/strategy.js';

const STRATEGIES = Object.values(DRAWING_STRATEGIES);
const pick = testRandom(2026);

function randomImage(): TemplateImage {
  const shape = pick(10);
  const width = shape === 0 ? 1 : 1 + pick(33);
  const height = shape === 1 ? 1 : 1 + pick(33);
  const transparency = [0, 2, 4, 1000][pick(4)] ?? 0; // 1 pixel in N transparent (0 = none, 1000 ~ none)
  const colors = 1 + pick(6);
  if (shape === 2) return image(width, height, () => null); // fully transparent
  return image(width, height, () => (transparency > 0 && pick(transparency) === 0 ? null : 0x010203 * pick(colors)));
}

function randomConfig(s: DrawingStrategy): StrategyConfig {
  if (s.id === 'random') return { id: 'random', seed: pick(2 ** 31) * 2 + pick(2) };
  if (s.id === 'color-by-color' && pick(2) === 0) return { id: 'color-by-color', colorOrder: [rgb(1, 2, 3), rgb(4, 6, 9)] };
  return { id: s.id };
}

describe('drawing strategies: properties (8 strategies x random images)', () => {
  it('order every paintable pixel exactly once, never a transparent one', () => {
    for (let t = 0; t < 60; t++) {
      const img = randomImage();
      const expected = paintable(img);
      for (const s of STRATEGIES) {
        const order = [...s.order(img, randomConfig(s))];
        expect(order.length, s.id).toBe(expected.length);
        expect(new Set(order).size, `${s.id}: duplicates`).toBe(order.length);
        expect([...order].sort((a, b) => a - b), `${s.id}: omissions`).toEqual(expected);
        expect(order.some((i) => img.pixels[i] === TRANSPARENT_U32), s.id).toBe(false);
      }
    }
  });

  it('are deterministic and independent of the batch size', () => {
    for (let t = 0; t < 30; t++) {
      const img = randomImage();
      for (const s of STRATEGIES) {
        const config = randomConfig(s);
        const once = [...s.order(img, config)];
        expect([...s.order(img, config)], s.id).toEqual(once);
        const sizes = [1 + pick(5), 1 + pick(50), 1 + pick(500)];
        expect(drainWith(s.cursor(img, config), sizes), s.id).toEqual(once);
      }
    }
  });

  it('restrict to any region as exactly the filtered full order', () => {
    for (let t = 0; t < 60; t++) {
      const img = randomImage();
      const ix = pick(img.width);
      const iy = pick(img.height);
      const region = { ix, iy, width: pick(img.width - ix + 1), height: pick(img.height - iy + 1) };
      for (const s of STRATEGIES) {
        const config = randomConfig(s);
        const full = [...s.order(img, config)];
        expect([...s.order(img, config, region)], s.id).toEqual(full.filter((i) => inRegion(img, region, i)));
      }
    }
  });

  it('keep the image-space order across placements and y directions; clipping only removes pixels', () => {
    for (let t = 0; t < 30; t++) {
      const img = randomImage();
      const bounds = { minX: 0, minY: 0, width: 40, height: 40 };
      const systems: CoordinateSystem[] = [{ yAxis: 'down', bounds }, { yAxis: 'up', bounds }, { yAxis: 'down' }];
      for (const s of STRATEGIES) {
        const strategy = randomConfig(s);
        const full = [...s.order(img, strategy)];
        for (const coordinateSystem of systems) {
          const placement = { topLeft: { x: pick(60) - 20, y: pick(60) - 20 } };
          const got = drainWith(templateOrderCursor({ image: img, strategy, placement, coordinateSystem }), [7]);
          const region = eligibleRegion(img, placement, coordinateSystem);
          expect(got, `${s.id} ${coordinateSystem.yAxis}`).toEqual(full.filter((i) => inRegion(img, region, i)));
        }
      }
    }
  });
});

describe('drawing strategies on a managed template', () => {
  it('order the stored image of a revision; a placement-only revision keeps the order', async () => {
    const storage = createMemoryTemplateStorage();
    const manager = createTemplateManager({ storage, hasher: testHasher, codec: testCodec, ids: sequentialIds(), clock: manualClock() });
    const palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(255, 0, 0) }] };
    const sourcePng = rgbaPng(9, 7, (x, y) => (x === 4 && y === 3 ? [0, 0, 0, 0] : [(x * 60) % 256, (y * 90) % 256, 0, 255]));
    const coordinateSystem = { yAxis: 'up', bounds: { minX: 0, minY: 0, width: 100, height: 100 } } as const;
    for (const strategy of STRATEGIES.map((s) => randomConfig(s))) {
      const created = await manager.create({ projectId: asProjectId('p'), name: strategy.id, sourcePng, palette, placement: { topLeft: { x: 10, y: 50 } }, coordinateSystem, strategy });
      const ref = { projectId: created.projectId, templateId: created.id };
      const before = drainWith(templateOrderCursor((await manager.load(ref)).template), [16]);
      expect(before.length).toBe(62);
      const moved = await manager.revise(ref, { placement: { topLeft: { x: 30, y: 80 } } });
      expect(drainWith(templateOrderCursor(moved.template), [5])).toEqual(before);
      // Partly outside: only the clipped pixels disappear, with a warning on the template.
      const clipped = await manager.revise(ref, { placement: { topLeft: { x: 95, y: 50 } } });
      expect(clipped.template.warnings[0]?.code).toBe('PLACEMENT_PARTIALLY_OUTSIDE');
      expect(drainWith(templateOrderCursor(clipped.template), [5])).toEqual(before.filter((i) => i % 9 < 5));
    }
  });
});
