/**
 * Phase 1B.10: the incremental progress gives EXACTLY the full computation
 * at every step of random histories (agent writes, outside changes, unknown
 * and invalid values, partial snapshots, both y axes), and rebuilds on any
 * change of template, revision, placement or snapshot rectangle.
 */

import { describe, expect, it } from 'vitest';
import type { CanvasRect, CanvasSnapshot, CoordinateSystem, ProgressSnapshot, ProgressTemplate, TemplateId, TemplateImage } from '../src/index.js';
import { TRANSPARENT, UNKNOWN, computeProgress, createArraySnapshot, createIncrementalProgress, imageToCanvas } from '../src/index.js';
import { image, testRandom } from './helpers/strategy.js';

function template(img: TemplateImage, x: number, y: number, system: CoordinateSystem, revision = 1): ProgressTemplate {
  return { id: 'modele' as TemplateId, revision, image: img, placement: { topLeft: { x, y } }, coordinateSystem: system };
}

function snap(rect: CanvasRect, system: CoordinateSystem, values: Int32Array, at = 1000): CanvasSnapshot {
  return createArraySnapshot({ rect, coordinateSystem: system, source: 'simulated', observedAt: at, pixels: Int32Array.from(values) });
}

/** The counters that matter, comparable. */
const essence = (p: ProgressSnapshot) => ({
  total: p.total,
  correct: p.correct,
  wrongColor: p.wrongColor,
  missing: p.missing,
  unknown: p.unknown,
  invalid: p.invalidObservations,
  excluded: p.excluded,
  completion: p.completion,
  conformity: p.conformityPercent,
  byColor: p.byColor,
});

describe('incremental progress (Phase 1B.10)', () => {
  for (const yAxis of ['down', 'up'] as const) {
    it(`equals the full computation at every step of random histories (y ${yAxis})`, () => {
      const system: CoordinateSystem = { yAxis };
      for (let seed = 1; seed <= 6; seed++) {
        const next = testRandom(seed * 7919);
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00];
        const img = image(23 + seed, 17, (ix, iy) => ((ix * 3 + iy * 5 + seed) % 7 === 0 ? null : colors[(ix + iy * seed) % colors.length]!));
        const t = template(img, 4, 5, system);
        // The snapshot covers the template partly (some pixels unknown: outside the read).
        const rect = { minX: 2, minY: 3, width: 26 + seed, height: 15 };
        const values = new Int32Array(rect.width * rect.height).fill(TRANSPARENT);
        const calc = createIncrementalProgress({ verifyEvery: 0, rebuildEvery: 1_000 });
        for (let step = 0; step < 60; step++) {
          // A few changes: the template color (agent), another color (outside actor), erase, unknown, invalid.
          const n = 1 + next(12);
          for (let k = 0; k < n; k++) {
            const i = next(values.length);
            const kind = next(10);
            if (kind < 5) {
              const x = rect.minX + (i % rect.width);
              const y = rect.minY + Math.floor(i / rect.width);
              let expected: number = TRANSPARENT;
              for (let iy = 0; iy < img.height && expected === TRANSPARENT; iy++)
                for (let ix = 0; ix < img.width; ix++) {
                  const c = imageToCanvas({ ix, iy }, t.placement, system);
                  if (c.x === x && c.y === y) {
                    expected = img.pixels[iy * img.width + ix]!;
                    break;
                  }
                }
              values[i] = expected === 0xffffffff ? TRANSPARENT : expected;
            } else if (kind < 7) values[i] = colors[next(colors.length)]! ^ 0x010101;
            else if (kind < 8) values[i] = TRANSPARENT;
            else if (kind < 9) values[i] = UNKNOWN;
            else values[i] = 0x7fffffff; // invalid
          }
          const s = snap(rect, system, values, 1000 + step);
          const got = calc.compute(t, s, 2000 + step);
          const want = computeProgress(t, s, 2000 + step);
          expect(essence(got), `seed ${seed} step ${step}`).toEqual(essence(want));
        }
        const stats = calc.stats;
        expect(stats.full).toBe(1);
        expect(stats.incremental).toBe(59);
      }
    });
  }

  it('rebuilds on a new revision, a moved template, another snapshot rectangle, after invalidate(), and every rebuildEvery calls', () => {
    const img = image(10, 8, (ix, iy) => ((ix + iy) % 2 === 0 ? 0xff0000 : 0x00ff00));
    const system: CoordinateSystem = { yAxis: 'down' };
    const rect = { minX: 0, minY: 0, width: 20, height: 20 };
    const values = new Int32Array(400).fill(TRANSPARENT);
    const calc = createIncrementalProgress({ verifyEvery: 0, rebuildEvery: 5 });
    const run = (t: ProgressTemplate, r: CanvasRect = rect) => {
      const v = r === rect ? values : new Int32Array(r.width * r.height).fill(TRANSPARENT);
      const s = snap(r, system, v);
      expect(essence(calc.compute(t, s, 5000))).toEqual(essence(computeProgress(t, s, 5000)));
    };
    run(template(img, 1, 1, system));
    run(template(img, 1, 1, system));
    expect(calc.stats.full).toBe(1);
    run(template(img, 1, 1, system, 2)); // new revision
    run(template(img, 2, 1, system, 2)); // moved
    run(template(img, 2, 1, system, 2), { minX: 0, minY: 0, width: 15, height: 15 }); // another rectangle
    expect(calc.stats.full).toBe(4);
    calc.invalidate();
    run(template(img, 2, 1, system, 2), { minX: 0, minY: 0, width: 15, height: 15 });
    expect(calc.stats.full).toBe(5);
    for (let i = 0; i < 6; i++) run(template(img, 2, 1, system, 2), { minX: 0, minY: 0, width: 15, height: 15 });
    expect(calc.stats.full).toBe(6); // the periodic rebuild
  });

  it('verification catches a disagreement: the full result is returned, the state rebuilt, the mismatch counted', () => {
    const img = image(6, 6, () => 0xff0000);
    const system: CoordinateSystem = { yAxis: 'down' };
    const rect = { minX: 0, minY: 0, width: 6, height: 6 };
    const t = template(img, 0, 0, system);
    const calc = createIncrementalProgress({ verifyEvery: 1 });
    calc.compute(t, snap(rect, system, new Int32Array(36).fill(TRANSPARENT)), 1);
    // A drift: the incremental update reads the canvas empty, the verification reads it painted
    // (as if the calculator's state no longer matched the canvas).
    const s = snap(rect, system, new Int32Array(36).fill(TRANSPARENT));
    const real = s.readRow!.bind(s);
    let reads = 0;
    (s as { readRow?: unknown }).readRow = (y: number, x0: number, x1: number, out: Int32Array) => {
      real(y, x0, x1, out);
      if (reads++ >= 6) out.fill(0xff0000);
    };
    const got = calc.compute(t, s, 2);
    expect(calc.stats.mismatches).toBe(1);
    expect(got.correct).toBe(36); // the full computation's answer, never the stale counter
    expect(got.completion).toBe('complete');
  });

  it('a snapshot without readRow always uses the full computation', () => {
    const img = image(4, 4, () => 0xff0000);
    const system: CoordinateSystem = { yAxis: 'down' };
    const rect = { minX: 0, minY: 0, width: 4, height: 4 };
    const base = snap(rect, system, new Int32Array(16).fill(TRANSPARENT));
    const pointOnly: CanvasSnapshot = { rect, coordinateSystem: system, source: 'simulated', observedAt: 1, get: (p) => base.get(p) };
    const calc = createIncrementalProgress();
    calc.compute(template(img, 0, 0, system), pointOnly, 1);
    calc.compute(template(img, 0, 0, system), pointOnly, 2);
    expect(calc.stats).toMatchObject({ full: 2, incremental: 0 });
  });
});
