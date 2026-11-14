import { describe, expect, it } from 'vitest';
import type { StrategyConfig } from '../src/index.js';
import { DRAWING_STRATEGIES, StrategyError, prepareOrderKeys, random } from '../src/index.js';
import { image, inRegion, paintable, testRandom } from './helpers/strategy.js';

const STRATEGIES = Object.values(DRAWING_STRATEGIES);

describe('order keys reproduce the strategy orders exactly', () => {
  it('sorting the paintable pixels by key equals order(), for the 8 strategies, with regions', () => {
    const pick = testRandom(606);
    for (let t = 0; t < 120; t++) {
      const w = 1 + pick(30);
      const h = 1 + pick(30);
      const transparency = [0, 3, 1000][pick(3)]!;
      const img = image(w, h, () => (transparency > 0 && pick(transparency) === 0 ? null : 0x010203 * pick(1 + pick(6))));
      for (const s of STRATEGIES) {
        const config: StrategyConfig = s.id === 'random' ? { id: 'random', seed: pick(1000) } : s.id === 'color-by-color' && pick(2) === 0 ? { id: s.id, colorOrder: [0x010203 as never] } : { id: s.id };
        const keys = prepareOrderKeys(img, config);
        const byKey = paintable(img).sort((a, b) => keys.key(a) - keys.key(b));
        expect(byKey, s.id).toEqual([...s.order(img, config)]);
        // Keys are distinct integers (a total order, no tie left to chance).
        const values = byKey.map((i) => keys.key(i));
        expect(new Set(values).size, s.id).toBe(values.length);
        expect(values.every((v) => Number.isSafeInteger(v)), s.id).toBe(true);
        const ix = pick(w);
        const iy = pick(h);
        const region = { ix, iy, width: pick(w - ix + 1), height: pick(h - iy + 1) };
        expect(byKey.filter((i) => inRegion(img, region, i)), s.id).toEqual([...s.order(img, config, region)]);
      }
    }
  });

  it('uses a supplied random order (cache) instead of regenerating it, and keeps keys exact at 4096 x 4096', () => {
    const img = image(64, 32, (x, y) => ((x + y) % 7 === 0 ? null : 5));
    const order = random.order(img, { id: 'random', seed: 3 });
    const keys = prepareOrderKeys(img, { id: 'random', seed: 3 }, { randomOrder: order });
    expect(keys.bytes).toBe(64 * 32 * 4);
    expect(paintable(img).sort((a, b) => keys.key(a) - keys.key(b))).toEqual([...order]);
    // Largest supported template: the center-out key stays below 2^53.
    const big = { width: 4096, height: 4096, pixels: new Uint32Array(4096 * 4096) };
    const center = prepareOrderKeys(big, { id: 'center-out' });
    expect(Number.isSafeInteger(center.key(0))).toBe(true);
    expect(center.key(0)).toBeGreaterThan(center.key(2048 * 4096 + 2048));
    const huge = { width: 2 ** 16, height: 2 ** 15, pixels: new Uint32Array(0) };
    expect(() => prepareOrderKeys({ ...huge, pixels: { length: 2 ** 31 } as never }, { id: 'center-out' })).toThrow(StrategyError);
  });
});
