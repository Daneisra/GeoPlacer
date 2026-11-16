/**
 * Phase 1C.0: computations cut into slices give EXACTLY the synchronous result, whatever the
 * slice size; the incremental progress is atomic (a call abandoned at ANY slice boundary leaves
 * the previous state untouched); invalidate() during a sliced call is never overwritten.
 */

import { describe, expect, it } from 'vitest';
import type { CanvasRect, CanvasSnapshot, CoordinateSystem, ProgressSnapshot, ProgressTemplate, Sliced, TemplateId, TemplateImage } from '../src/index.js';
import {
  SliceAbandoned,
  SliceBudget,
  TRANSPARENT,
  UNKNOWN,
  computeProgress,
  computeProgressSliced,
  createArraySnapshot,
  createIncrementalProgress,
  runSliced,
  runSlicedAsync,
} from '../src/index.js';
import { image, testRandom } from './helpers/strategy.js';

function template(img: TemplateImage, x: number, y: number, system: CoordinateSystem, revision = 1): ProgressTemplate {
  return { id: 'modele' as TemplateId, revision, image: img, placement: { topLeft: { x, y } }, coordinateSystem: system };
}

function snap(rect: CanvasRect, system: CoordinateSystem, values: Int32Array, at = 1000): CanvasSnapshot {
  return createArraySnapshot({ rect, coordinateSystem: system, source: 'simulated', observedAt: at, pixels: Int32Array.from(values) });
}

const essence = (p: ProgressSnapshot) => ({
  total: p.total,
  correct: p.correct,
  wrongColor: p.wrongColor,
  missing: p.missing,
  unknown: p.unknown,
  invalid: p.invalidObservations,
  excluded: p.excluded,
  completion: p.completion,
  byColor: p.byColor,
});

const COLORS = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00];

/** A template partly outside a snapshot, and a function that changes random canvas values. */
function world(seed: number, yAxis: 'down' | 'up') {
  const system: CoordinateSystem = { yAxis };
  const next = testRandom(seed * 104729);
  const img = image(19 + seed, 13, (ix, iy) => ((ix * 3 + iy * 5 + seed) % 7 === 0 ? null : COLORS[(ix + iy * seed) % COLORS.length]!));
  const t = template(img, 4, 5, system);
  const rect = { minX: 2, minY: 3, width: 22 + seed, height: 12 };
  const values = new Int32Array(rect.width * rect.height).fill(TRANSPARENT);
  const change = () => {
    for (let k = 1 + next(15); k > 0; k--) {
      const i = next(values.length);
      const kind = next(10);
      values[i] = kind < 6 ? COLORS[next(COLORS.length)]! : kind < 8 ? TRANSPARENT : kind < 9 ? UNKNOWN : 0x7fffffff;
    }
  };
  return { system, t, rect, values, change, next };
}

/** Runs a sliced computation, counting its slice boundaries. */
function countSlices<T>(work: Sliced<T>): { value: T; slices: number } {
  let slices = 0;
  for (;;) {
    const step = work.next();
    if (step.done === true) return { value: step.value, slices };
    slices++;
  }
}

describe('sliced computations (Phase 1C.0)', () => {
  it('computeProgressSliced gives exactly computeProgress for every slice size', () => {
    for (const yAxis of ['down', 'up'] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const w = world(seed, yAxis);
        for (let step = 0; step < 8; step++) {
          w.change();
          const s = snap(w.rect, w.system, w.values, 1000 + step);
          const want = essence(computeProgress(w.t, s, 5000));
          for (const per of [1, 3, 20, 64, 1000, Infinity]) {
            const { value, slices } = countSlices(computeProgressSliced(w.t, s, 5000, {}, new SliceBudget(per)));
            expect(essence(value), `seed ${seed} step ${step} per ${per}`).toEqual(want);
            if (per === Infinity) expect(slices).toBe(0);
            if (per === 1) expect(slices).toBeGreaterThan(10);
          }
        }
      }
    }
  });

  it('the incremental progress, sliced or not, gives the full computation at every step', () => {
    for (const yAxis of ['down', 'up'] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const w = world(seed, yAxis);
        const plain = createIncrementalProgress({ verifyEvery: 3, rebuildEvery: 7 });
        const sliced = createIncrementalProgress({ verifyEvery: 3, rebuildEvery: 7 });
        for (let step = 0; step < 40; step++) {
          w.change();
          const s = snap(w.rect, w.system, w.values, 1000 + step);
          const want = essence(computeProgress(w.t, s, 5000 + step));
          expect(essence(plain.compute(w.t, s, 5000 + step)), `plain ${seed}/${step}`).toEqual(want);
          expect(essence(runSliced(sliced.computeSliced(w.t, s, 5000 + step, new SliceBudget(1 + w.next(40))))), `sliced ${seed}/${step}`).toEqual(want);
        }
        expect(sliced.stats).toEqual(plain.stats);
        expect(plain.stats.mismatches).toBe(0);
      }
    }
  });

  it('a call abandoned at ANY slice boundary changes nothing: the next calls stay exact (update, rebuild, verification)', () => {
    for (const yAxis of ['down', 'up'] as const) {
      const w = world(3, yAxis);
      // verifyEvery 2 and rebuildEvery 4: the abandoned calls fall on every kind of call.
      const reference = createIncrementalProgress({ verifyEvery: 2, rebuildEvery: 4 });
      const victim = createIncrementalProgress({ verifyEvery: 2, rebuildEvery: 4 });
      for (let step = 0; step < 14; step++) {
        w.change();
        const s = snap(w.rect, w.system, w.values, 1000 + step);
        // The reference is in the same state as the victim: its call has the same slice boundaries.
        const statsBefore = victim.stats;
        const boundaries = countSlices(reference.computeSliced(w.t, s, 5000 + step, new SliceBudget(5))).slices;
        for (let k = 1; k <= boundaries; k++) {
          // Abandon the victim's call after k slices: the generator is closed, nothing is committed.
          const work = victim.computeSliced(w.t, s, 5000 + step, new SliceBudget(5));
          for (let i = 0; i < k; i++) expect(work.next().done).toBe(false);
          work.return(undefined as never);
        }
        // Abandoned calls are not counted as finished calls of any kind.
        expect(victim.stats.full + victim.stats.incremental, `step ${step}`).toBe(statsBefore.full + statsBefore.incremental);
        // Then the victim runs the call for real: same result and same state as the reference.
        const got = runSliced(victim.computeSliced(w.t, s, 5000 + step, new SliceBudget(5)));
        expect(essence(got), `step ${step}`).toEqual(essence(computeProgress(w.t, s, 5000 + step)));
        expect({ full: victim.stats.full, incremental: victim.stats.incremental, verified: victim.stats.verified }).toEqual({
          full: reference.stats.full,
          incremental: reference.stats.incremental,
          verified: reference.stats.verified,
        });
      }
      expect(victim.stats.mismatches).toBe(0);
    }
  });

  it('invalidate() during a sliced call: that call returns, but its (older) state is never kept', () => {
    const w = world(2, 'down');
    const calc = createIncrementalProgress({ verifyEvery: 0, rebuildEvery: 1_000 });
    w.change();
    calc.compute(w.t, snap(w.rect, w.system, w.values, 1000), 5000);
    w.change();
    const s = snap(w.rect, w.system, w.values, 1001);
    const work = calc.computeSliced(w.t, s, 5001, new SliceBudget(5));
    expect(work.next().done).toBe(false);
    calc.invalidate(); // a restore happened meanwhile
    expect(essence(runSliced(work))).toEqual(essence(computeProgress(w.t, s, 5001)));
    const fullBefore = calc.stats.full;
    w.change();
    const s2 = snap(w.rect, w.system, w.values, 1002);
    expect(essence(calc.compute(w.t, s2, 5002))).toEqual(essence(computeProgress(w.t, s2, 5002)));
    expect(calc.stats.full).toBe(fullBefore + 1); // a full rebuild, not an update of the older state
  });

  it('runSlicedAsync yields between slices, and abandon closes the computation (finally runs) and throws', async () => {
    let finished = false;
    let yields = 0;
    function* work(): Sliced<number> {
      try {
        for (let i = 0; i < 5; i++) yield;
        return 42;
      } finally {
        finished = true;
      }
    }
    expect(await runSlicedAsync(work(), async () => void yields++)).toBe(42);
    expect(yields).toBe(5);
    finished = false;
    let n = 0;
    await expect(runSlicedAsync(work(), async () => void n++, () => n >= 2)).rejects.toBeInstanceOf(SliceAbandoned);
    expect(n).toBe(2);
    expect(finished).toBe(true);
  });
});
