import { describe, expect, it } from 'vitest';
import type { CanvasRect, CanvasSnapshot, CoordinateSystem, ProgressTemplate, TemplateId, TemplateImage } from '../src/index.js';
import {
  ProgressError,
  SnapshotError,
  TRANSPARENT,
  TRANSPARENT_U32,
  UNKNOWN,
  computeProgress,
  createArraySnapshot,
  createProgressCalculator,
  eligibleRegion,
  imageToCanvas,
  snapshotFreshness,
} from '../src/index.js';
import { art, image, testRandom } from './helpers/strategy.js';

const C = (ch: string): number => ch.charCodeAt(0);
const down: CoordinateSystem = { yAxis: 'down' };

function template(img: TemplateImage, x = 0, y = 0, system: CoordinateSystem = down): ProgressTemplate {
  return { id: 'modele' as TemplateId, revision: 1, image: img, placement: { topLeft: { x, y } }, coordinateSystem: system };
}

/** Snapshot over `rect` whose pixel at (x, y) is given by `pixel` (a color, TRANSPARENT or UNKNOWN). */
function snapshot(rect: CanvasRect, system: CoordinateSystem, pixel: (x: number, y: number) => number, extra: Partial<Pick<CanvasSnapshot, 'source' | 'observedAt'>> = {}): CanvasSnapshot {
  const pixels = new Int32Array(rect.width * rect.height);
  for (let dy = 0; dy < rect.height; dy++) for (let dx = 0; dx < rect.width; dx++) pixels[dy * rect.width + dx] = pixel(rect.minX + dx, rect.minY + dy);
  return createArraySnapshot({ rect, coordinateSystem: system, source: extra.source ?? 'simulated', observedAt: extra.observedAt ?? 1000, pixels });
}

/** The canvas exactly as the template wants it (TRANSPARENT where the template is transparent or absent). */
function painted(t: ProgressTemplate): (x: number, y: number) => number {
  const map = new Map<string, number>();
  for (let iy = 0; iy < t.image.height; iy++) {
    for (let ix = 0; ix < t.image.width; ix++) {
      const p = t.image.pixels[iy * t.image.width + ix]!;
      const c = imageToCanvas({ ix, iy }, t.placement, t.coordinateSystem);
      map.set(`${c.x},${c.y}`, p === TRANSPARENT_U32 ? TRANSPARENT : p);
    }
  }
  return (x, y) => map.get(`${x},${y}`) ?? TRANSPARENT;
}

const counts = (p: ReturnType<typeof computeProgress>) => ({ total: p.total, correct: p.correct, wrongColor: p.wrongColor, missing: p.missing, unknown: p.unknown });
const big: CanvasRect = { minX: -50, minY: -50, width: 200, height: 200 };

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect((error as { code?: string } | null)?.code).toBe(code);
}

describe('ProgressCalculator: pixel states', () => {
  // a a b
  // c . b      5 eligible pixels: a 2, b 2, c 1
  const img = art(['aab', 'c.b']);
  const t = template(img, 10, 20);

  it('reports a fully correct template as complete', () => {
    const p = computeProgress(t, snapshot(big, down, painted(t)), 2000);
    expect(counts(p)).toEqual({ total: 5, correct: 5, wrongColor: 0, missing: 0, unknown: 0 });
    expect(p).toMatchObject({ incorrect: 0, conformityPercent: 100, coveragePercent: 100, completion: 'complete', invalidObservations: 0 });
    expect(p.excluded).toEqual({ transparent: 1, outsideCanvas: 0 });
  });

  it('distinguishes wrong colors and empty pixels, all known incorrect', () => {
    const wrong = computeProgress(t, snapshot(big, down, () => C('z')), 2000);
    expect(counts(wrong)).toEqual({ total: 5, correct: 0, wrongColor: 5, missing: 0, unknown: 0 });
    expect(wrong).toMatchObject({ incorrect: 5, conformityPercent: 0, coveragePercent: 100, completion: 'incomplete' });
    const empty = computeProgress(t, snapshot(big, down, () => TRANSPARENT), 2000);
    expect(counts(empty)).toEqual({ total: 5, correct: 0, wrongColor: 0, missing: 5, unknown: 0 });
  });

  it('counts a partially painted template exactly, by color', () => {
    const want = painted(t);
    // (10,20) a correct, (11,20) a empty, (12,20) b wrong, (10,21) c correct, (12,21) b correct.
    const canvas = (x: number, y: number) => (x === 11 && y === 20 ? TRANSPARENT : x === 12 && y === 20 ? C('z') : want(x, y));
    const p = computeProgress(t, snapshot(big, down, canvas), 2000);
    expect(counts(p)).toEqual({ total: 5, correct: 3, wrongColor: 1, missing: 1, unknown: 0 });
    expect(p.conformityPercent).toBe(60);
    expect(p.byColor).toEqual([
      { color: C('a'), total: 2, correct: 1, incorrect: 1, wrongColor: 0, missing: 1, unknown: 0 },
      { color: C('b'), total: 2, correct: 1, incorrect: 1, wrongColor: 1, missing: 0, unknown: 0 },
      { color: C('c'), total: 1, correct: 1, incorrect: 0, wrongColor: 0, missing: 0, unknown: 0 },
    ]);
  });

  it('keeps unobserved pixels unknown, never correct', () => {
    // Snapshot covering only column x = 10: the 3 other eligible pixels are unknown.
    const narrow = snapshot({ minX: 10, minY: 0, width: 1, height: 100 }, down, painted(t));
    const p = computeProgress(t, narrow, 2000);
    expect(counts(p)).toEqual({ total: 5, correct: 2, wrongColor: 0, missing: 0, unknown: 3 });
    expect(p).toMatchObject({ completion: 'undetermined', coveragePercent: 40, conformityPercent: 40 });
    // UNKNOWN inside the snapshot, too.
    const holes = computeProgress(t, snapshot(big, down, () => UNKNOWN), 2000);
    expect(counts(holes)).toEqual({ total: 5, correct: 0, wrongColor: 0, missing: 0, unknown: 5 });
    expect(holes.coveragePercent).toBe(0);
  });

  it('treats invalid observed values as unknown and counts them', () => {
    let k = 0;
    const odd = [Number.NaN, 0x1000000, 1.5, -3, Infinity];
    const weird: CanvasSnapshot = { ...snapshot(big, down, () => 0), get: () => odd[k++ % odd.length]! as never };
    const p = computeProgress(t, weird, 2000);
    expect(counts(p)).toEqual({ total: 5, correct: 0, wrongColor: 0, missing: 0, unknown: 5 });
    expect(p.invalidObservations).toBe(5);
  });

  it('defines the no-eligible-pixel case without division by zero', () => {
    const p = computeProgress(template(art(['..', '..'])), snapshot(big, down, () => 0), 2000);
    expect(p).toMatchObject({ total: 0, completion: 'no-eligible-pixels', conformityPercent: null, coveragePercent: null, byColor: [] });
    // Entirely outside a bounded canvas: also nothing eligible.
    const bounded: CoordinateSystem = { yAxis: 'down', bounds: { minX: 0, minY: 0, width: 5, height: 5 } };
    const outside = computeProgress(template(art(['ab']), 100, 100, bounded), snapshot(big, bounded, () => 0), 2000);
    expect(outside).toMatchObject({ total: 0, completion: 'no-eligible-pixels', excluded: { transparent: 0, outsideCanvas: 2 } });
  });

  it('handles 1 x 1 and non-square images', () => {
    const one = template(art(['x']), 3, 4);
    expect(computeProgress(one, snapshot(big, down, painted(one)), 1).completion).toBe('complete');
    const wide = template(image(13, 2, (ix) => (ix % 3 === 0 ? null : 7)), -5, 8);
    const p = computeProgress(wide, snapshot(big, down, painted(wide)), 1);
    expect(p).toMatchObject({ total: 16, correct: 16, completion: 'complete' });
  });
});

describe('ProgressCalculator: geometry', () => {
  it('maps image rows to canvas rows on a y-up canvas', () => {
    const up: CoordinateSystem = { yAxis: 'up' };
    const t = template(art(['ab', 'cd']), 5, 10, up); // image row 0 at canvas y 10, row 1 at y 9
    const expectedAt: Record<string, number> = { '5,10': C('a'), '6,10': C('b'), '5,9': C('c'), '6,9': C('d') };
    const canvas = (x: number, y: number) => expectedAt[`${x},${y}`] ?? TRANSPARENT;
    expect(computeProgress(t, snapshot(big, up, canvas), 1).completion).toBe('complete');
    // The same canvas read as y-down data does not match the template.
    const flipped = (x: number, y: number) => canvas(x, 19 - y);
    expect(computeProgress(t, snapshot(big, up, flipped), 1).correct).toBe(0);
  });

  it('refuses a snapshot in another coordinate system (explicit conversion only)', () => {
    const t = template(art(['ab']), 0, 0, { yAxis: 'up' });
    expectCode(() => computeProgress(t, snapshot(big, down, () => 0), 1), 'COORDINATE_SYSTEM_MISMATCH');
    const bounded: CoordinateSystem = { yAxis: 'up', bounds: { minX: 0, minY: 0, width: 9, height: 9 } };
    expectCode(() => computeProgress(t, snapshot(big, bounded, () => 0), 1), 'COORDINATE_SYSTEM_MISMATCH');
  });

  it('excludes pixels outside a bounded canvas from the total (partial placement)', () => {
    const bounded: CoordinateSystem = { yAxis: 'down', bounds: { minX: 0, minY: 0, width: 10, height: 10 } };
    const t = template(art(['abcd', 'efgh']), 8, 9, bounded); // inside: (8,9) a and (9,9) b
    const p = computeProgress(t, snapshot({ minX: 0, minY: 0, width: 10, height: 10 }, bounded, painted(t)), 1);
    expect(p).toMatchObject({ total: 2, correct: 2, completion: 'complete', excluded: { transparent: 0, outsideCanvas: 6 } });
  });

  it('works with coordinates near the safe-integer limit', () => {
    const x = 2 ** 52;
    const t = template(art(['ab']), x, -x);
    const rect = { minX: x, minY: -x, width: 2, height: 1 };
    expect(computeProgress(t, snapshot(rect, down, painted(t)), 1).completion).toBe('complete');
  });
});

describe('ProgressCalculator: provenance and freshness', () => {
  const t = template(art(['ab']));

  it('keeps the source and date; an imported image is an observation, never a live reading', () => {
    const imported = computeProgress(t, snapshot(big, down, painted(t), { source: 'imported-snapshot', observedAt: 5000 }), 9000);
    expect(imported.basis).toEqual({ source: 'imported-snapshot', kind: 'imported-observation', observedAt: 5000, freshness: { status: 'unchecked', ageMs: 4000, maxAgeMs: null } });
    expect(imported.computedAt).toBe(9000);
    const simulated = computeProgress(t, snapshot(big, down, painted(t)), 1000);
    expect(simulated.basis.kind).toBe('simulation');
  });

  it('applies a freshness policy per source, without a global default', () => {
    const calc = createProgressCalculator({ freshness: { 'imported-snapshot': { maxAgeMs: 60_000 } } });
    const at = (observedAt: number, source: 'simulated' | 'imported-snapshot') => calc.compute(t, snapshot(big, down, painted(t), { source, observedAt }), 100_000).basis.freshness;
    expect(at(50_000, 'imported-snapshot')).toEqual({ status: 'fresh', ageMs: 50_000, maxAgeMs: 60_000 });
    expect(at(40_000, 'imported-snapshot')).toEqual({ status: 'fresh', ageMs: 60_000, maxAgeMs: 60_000 });
    expect(at(39_999, 'imported-snapshot')).toEqual({ status: 'stale', ageMs: 60_001, maxAgeMs: 60_000 });
    expect(at(0, 'simulated').status).toBe('unchecked');
    expect(snapshotFreshness({ source: 'simulated', observedAt: 200 }, 100)).toEqual({ status: 'future', ageMs: -100, maxAgeMs: null });
  });

  it('rejects invalid timestamps, policies and snapshots', () => {
    const good = snapshot(big, down, painted(t));
    expectCode(() => computeProgress(t, good, -1), 'INVALID_INPUT');
    expectCode(() => computeProgress(t, good, 1.5), 'INVALID_INPUT');
    expectCode(() => computeProgress(t, { ...good, observedAt: Number.NaN }, 10), 'INVALID_INPUT');
    expectCode(() => computeProgress(t, { ...good, rect: { ...big, width: 0 } }, 10), 'INVALID_INPUT');
    expectCode(() => computeProgress(t, good, 10, { freshness: { simulated: { maxAgeMs: -1 } } }), 'INVALID_INPUT');
    expectCode(() => createProgressCalculator({ freshness: { simulated: { maxAgeMs: Infinity } } }), 'INVALID_INPUT');
    expectCode(() => computeProgress({ ...t, image: { width: 2, height: 2, pixels: new Uint32Array(3) } }, good, 10), 'INVALID_INPUT');
    expect(() => createArraySnapshot({ rect: big, coordinateSystem: down, source: 'simulated', observedAt: 0, pixels: new Int32Array(3) })).toThrow(SnapshotError);
    expect(() => createArraySnapshot({ rect: big, coordinateSystem: down, source: 'live' as never, observedAt: 0, pixels: new Int32Array(big.width * big.height) })).toThrow(SnapshotError);
    expect(new ProgressError('INVALID_INPUT', 'x').name).toBe('ProgressError');
  });
});

describe('ProgressCalculator: properties', () => {
  /** Naive reference: one imageToCanvas and one get per pixel. */
  function reference(t: ProgressTemplate, s: CanvasSnapshot) {
    const r = eligibleRegion(t.image, t.placement, t.coordinateSystem);
    const out = { total: 0, correct: 0, wrongColor: 0, missing: 0, unknown: 0 };
    for (let iy = r.iy; iy < r.iy + r.height; iy++) {
      for (let ix = r.ix; ix < r.ix + r.width; ix++) {
        const p = t.image.pixels[iy * t.image.width + ix]!;
        if (p === TRANSPARENT_U32) continue;
        out.total++;
        const v = s.get(imageToCanvas({ ix, iy }, t.placement, t.coordinateSystem));
        if (v === p) out.correct++;
        else if (v === TRANSPARENT) out.missing++;
        else if (v === UNKNOWN) out.unknown++;
        else out.wrongColor++;
      }
    }
    return out;
  }

  it('match the naive reference and keep every counter invariant', () => {
    const pick = testRandom(404);
    for (let k = 0; k < 150; k++) {
      const yAxis = pick(2) === 0 ? 'down' : 'up';
      const system: CoordinateSystem = pick(3) === 0 ? { yAxis } : { yAxis, bounds: { minX: -5, minY: -5, width: 20 + pick(10), height: 20 + pick(10) } };
      const img = image(1 + pick(12), 1 + pick(12), () => (pick(5) === 0 ? null : pick(4)));
      const t = template(img, pick(30) - 10, pick(30) - 10, system);
      const rect = { minX: pick(20) - 15, minY: pick(20) - 15, width: 1 + pick(30), height: 1 + pick(30) };
      const s = snapshot(rect, system, () => [TRANSPARENT, UNKNOWN, 0, 1, 2, 3, 9][pick(7)]!);
      const p = computeProgress(t, s, 5000);
      expect(counts(p)).toEqual(reference(t, s));
      expect(p.total).toBe(p.correct + p.incorrect + p.unknown);
      expect(p.incorrect).toBe(p.wrongColor + p.missing);
      for (const c of p.byColor) {
        expect(c.total).toBe(c.correct + c.incorrect + c.unknown);
        expect(c.incorrect).toBe(c.wrongColor + c.missing);
        expect(c.total).toBeGreaterThan(0);
      }
      for (const key of ['total', 'correct', 'wrongColor', 'missing', 'unknown'] as const) {
        expect(p.byColor.reduce((n, c) => n + c[key], 0)).toBe(p[key]);
      }
      expect(p.total + p.excluded.transparent + p.excluded.outsideCanvas).toBe(img.width * img.height);
      if (p.total > 0) {
        expect(p.conformityPercent).toBeGreaterThanOrEqual(0);
        expect(p.coveragePercent).toBeLessThanOrEqual(100);
        expect(p.conformityPercent! <= p.coveragePercent!).toBe(true);
        expect(p.completion === 'complete').toBe(p.correct === p.total);
      } else expect(p.completion).toBe('no-eligible-pixels');
    }
  });

  it('do not depend on the drawing strategy, its seed or the agents (not even an input)', () => {
    const img = art(['abba', 'c..c']);
    const s = snapshot(big, down, (x) => (x % 2 === 0 ? C('a') : C('c')));
    const results = (['top-to-bottom', 'random', 'color-by-color', 'outline-first'] as const).map((id) =>
      computeProgress({ ...template(img, 1, 1), strategy: { id, seed: 7 } } as ProgressTemplate, s, 10)
    );
    for (const r of results) expect(r).toEqual(results[0]);
  });
});
