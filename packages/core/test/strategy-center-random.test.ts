import { describe, expect, it } from 'vitest';
import type { TemplateImage } from '../src/index.js';
import { DEFAULT_RANDOM_SEED, RANDOM_STREAM, StrategyError, centerOut, createPcg32, random } from '../src/index.js';
import { art, coords, drainWith, image, inRegion, paintable, testRandom } from './helpers/strategy.js';

// ───────────── PCG32 ─────────────

/** Independent reference: the C code of pcg-c-basic, transcribed with BigInt. */
function referencePcg32(initState: bigint, initSeq: bigint): { next: () => number; bounded: (b: number) => number } {
  const M = (1n << 64n) - 1n;
  let state = 0n;
  const inc = ((initSeq << 1n) | 1n) & M;
  const step = (): void => {
    state = (state * 6364136223846793005n + inc) & M;
  };
  const next = (): number => {
    const old = state;
    step();
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  };
  step();
  state = (state + initState) & M;
  step();
  const bounded = (bound: number): number => {
    const threshold = (2 ** 32 - bound) % bound;
    for (;;) {
      const r = next();
      if (r >= threshold) return r % bound;
    }
  };
  return { next, bounded };
}

describe('PCG32', () => {
  it('reproduces the reference test vectors (pcg32-demo: initstate 42, initseq 54)', () => {
    const rng = createPcg32(42, 54);
    expect(Array.from({ length: 6 }, () => rng.next())).toEqual([0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e]);
  });

  it('matches an independent 64-bit BigInt implementation (many seeds, streams, bounds)', { timeout: 30_000 }, () => {
    const pick = testRandom(7);
    const seeds = [0, 1, 42, 0xffffffff, 2 ** 40 + 3, Number.MAX_SAFE_INTEGER, ...Array.from({ length: 20 }, () => pick(2 ** 31))];
    for (const seed of seeds) {
      for (const stream of [0, 54, RANDOM_STREAM, 2 ** 52 + 1]) {
        const fast = createPcg32(seed, stream);
        const ref = referencePcg32(BigInt(seed), BigInt(stream));
        for (let k = 0; k < 200; k++) expect(fast.next()).toBe(ref.next());
        for (const bound of [1, 2, 3, 6, 7, 1000, 2 ** 31 + 1, 2 ** 32]) expect(fast.bounded(bound)).toBe(ref.bounded(bound));
      }
    }
  });

  it('rejects invalid seeds and bounds', () => {
    expect(() => createPcg32(-1, 0)).toThrow(RangeError);
    expect(() => createPcg32(1.5, 0)).toThrow(RangeError);
    expect(() => createPcg32(0, 0).bounded(0)).toThrow(RangeError);
    expect(() => createPcg32(0, 0).bounded(2 ** 32 + 1)).toThrow(RangeError);
  });
});

// ───────────── center-out ─────────────

const center = (img: TemplateImage) => coords(img, centerOut.order(img, { id: 'center-out' }));

describe('center-out', () => {
  it('starts from the middle pixel of an odd image, then by distance, then by index', () => {
    expect(center(art(['xxx', 'xxx', 'xxx']))).toEqual(['1,1', '1,0', '0,1', '2,1', '1,2', '0,0', '2,0', '0,2', '2,2']);
  });

  it('uses the point between the middle pixels on even sides', () => {
    expect(center(art(['xx', 'xx']))).toEqual(['0,0', '1,0', '0,1', '1,1']); // all at the same distance: index order
    expect(center(art(['xxxx']))).toEqual(['1,0', '2,0', '0,0', '3,0']);
    // 4 x 3: centre (1.5, 1): (1,1) and (2,1) first, then (1,0), (2,0), (1,2), (2,2) at d2 = 5 ...
    expect(center(art(['xxxx', 'xxxx', 'xxxx'])).slice(0, 6)).toEqual(['1,1', '2,1', '1,0', '2,0', '1,2', '2,2']);
    expect(center(art(['x', 'x', 'x', 'x']))).toEqual(['0,1', '0,2', '0,0', '0,3']);
  });

  it('skips transparent pixels and holes, and handles 1 x 1 and empty images', () => {
    expect(center(art(['xxx', 'x.x', 'xxx']))).toEqual(['1,0', '0,1', '2,1', '1,2', '0,0', '2,0', '0,2', '2,2']);
    expect(center(art(['x']))).toEqual(['0,0']);
    expect(center(art(['..', '..']))).toEqual([]);
  });

  it('sorts exactly by (squared distance, index) on random images', () => {
    const pick = testRandom(11);
    for (let t = 0; t < 40; t++) {
      const img = image(1 + pick(23), 1 + pick(23), () => (pick(5) === 0 ? null : 1));
      const d2 = (i: number) => (2 * (i % img.width) - (img.width - 1)) ** 2 + (2 * Math.floor(i / img.width) - (img.height - 1)) ** 2;
      const expected = paintable(img).sort((a, b) => d2(a) - d2(b) || a - b);
      expect([...centerOut.order(img, { id: 'center-out' })]).toEqual(expected);
    }
  });

  it('keeps the centre of the image, not of the region', () => {
    const img = art(['xxxxx', 'xxxxx', 'xxxxx']);
    const r = { ix: 3, iy: 0, width: 2, height: 3 };
    const full = [...centerOut.order(img, { id: 'center-out' })];
    expect([...centerOut.order(img, { id: 'center-out' }, r)]).toEqual(full.filter((i) => inRegion(img, r, i)));
    expect(coords(img, centerOut.order(img, { id: 'center-out' }, r))[0]).toBe('3,1');
  });
});

// ───────────── random ─────────────

describe('random', () => {
  const img = image(17, 9, (ix, iy) => ((ix * 7 + iy * 3) % 5 === 0 ? null : 1));
  const shuffle = (seed?: number) => [...random.order(img, seed === undefined ? { id: 'random' } : { id: 'random', seed })];

  it('is a permutation of the paintable pixels, reproducible by seed', () => {
    const a = shuffle(1234);
    expect([...a].sort((x, y) => x - y)).toEqual(paintable(img));
    expect(shuffle(1234)).toEqual(a);
    expect(shuffle(1235)).not.toEqual(a);
    expect(shuffle()).toEqual(shuffle(DEFAULT_RANDOM_SEED));
    expect(shuffle(0xffffffff)).not.toEqual(shuffle(0));
  });

  it('is frozen: version 1 of the order for a known seed', () => {
    // Any change of PCG32, of the stream or of the Fisher-Yates walk changes this
    // sequence and must bump the strategy version.
    const small = art(['abc', 'd.e']);
    expect(random.version).toBe(1);
    expect([...random.order(small, { id: 'random', seed: 42 })]).toEqual(FROZEN_SEED_42);
  });

  it('gives the same sequence whatever the batch size, and filters by region', () => {
    const full = shuffle(99);
    for (const sizes of [[1], [3, 5], [10_000]]) expect(drainWith(random.cursor(img, { id: 'random', seed: 99 }), sizes)).toEqual(full);
    const r = { ix: 2, iy: 3, width: 9, height: 4 };
    expect([...random.order(img, { id: 'random', seed: 99 }, r)]).toEqual(full.filter((i) => inRegion(img, r, i)));
  });

  it('spreads the first pixels over the image (not a scan order in disguise)', () => {
    const big = image(64, 64, () => 1);
    const first = [...random.order(big, { id: 'random', seed: 5 })].slice(0, 400);
    const quadrants = [0, 0, 0, 0];
    for (const i of first) quadrants[(i % 64 < 32 ? 0 : 1) + (i < 64 * 32 ? 0 : 2)]! += 1;
    for (const q of quadrants) expect(q).toBeGreaterThan(60); // 100 expected each
  });

  it('rejects seeds outside the unsigned 32-bit range', () => {
    for (const seed of [-1, 2 ** 32, 0.5, Number.NaN]) {
      expect(() => random.order(img, { id: 'random', seed })).toThrow(StrategyError);
    }
  });
});

/** Captured from version 1 (regression lock; the external reference is the PCG32 test vector above). */
const FROZEN_SEED_42: number[] = [3, 0, 1, 2, 5];
