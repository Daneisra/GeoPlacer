import { describe, expect, it } from 'vitest';
import type { Rgb } from '../src/index.js';
import {
  ColorError,
  TRANSPARENT,
  TRANSPARENT_U32,
  asRgb,
  blueOf,
  greenOf,
  isRgb,
  isTransparentAlpha,
  oklabDeltaE,
  oklabDistance,
  oklabToRgb,
  redOf,
  rgb,
  rgbEuclideanDistance,
  rgbFromHex,
  rgbToHex,
  rgbToOklab,
  rgbToOklabInto,
} from '../src/index.js';

function expectColorError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ColorError);
    expect((error as ColorError).code).toBe(code);
    return;
  }
  throw new Error(`expected ColorError ${code}`);
}

describe('RGB representation', () => {
  it('packs and unpacks channels', () => {
    const c = rgb(0x12, 0x34, 0x56);
    expect(c).toBe(0x123456);
    expect([redOf(c), greenOf(c), blueOf(c)]).toEqual([0x12, 0x34, 0x56]);
  });

  it('round-trips hex in canonical lower-case form', () => {
    expect(rgbToHex(rgbFromHex('#ABCDEF'))).toBe('#abcdef');
    expect(rgbFromHex('abcdef')).toBe(0xabcdef);
    expect(rgbFromHex('#fa0')).toBe(0xffaa00);
    expect(rgbToHex(rgb(0, 0, 0))).toBe('#000000');
  });

  it('rejects invalid channels, values and hex strings', () => {
    for (const bad of [-1, 256, 1.5, NaN]) expectColorError(() => rgb(bad, 0, 0), 'INVALID_CHANNEL');
    for (const bad of [-1, 0x1000000, 0.5, TRANSPARENT, TRANSPARENT_U32]) expectColorError(() => asRgb(bad), 'INVALID_RGB');
    for (const bad of ['#ffff', '#ff00ff00', 'red', '', '#gg0000']) expectColorError(() => rgbFromHex(bad), 'INVALID_HEX');
  });

  it('keeps black and transparency distinct', () => {
    const black = rgb(0, 0, 0);
    expect(isRgb(black)).toBe(true);
    expect(isRgb(TRANSPARENT)).toBe(false);
    expect(isRgb(TRANSPARENT_U32)).toBe(false);
    expect(black).not.toBe(TRANSPARENT);
  });

  it('applies the explicit alpha rule', () => {
    expect(isTransparentAlpha(0, 128)).toBe(true);
    expect(isTransparentAlpha(127, 128)).toBe(true);
    expect(isTransparentAlpha(128, 128)).toBe(false);
    expect(isTransparentAlpha(0, 0)).toBe(false); // threshold 0: nothing is transparent
    expect(isTransparentAlpha(255, 256)).toBe(true); // threshold 256: everything is transparent
  });
});

describe('sRGB <-> OKLab', () => {
  // Matrices: B. Ottosson, "A perceptual color space for image processing" (published 23 Dec 2020,
  // sRGB matrices updated 25 Jan 2021), https://bottosson.github.io/posts/oklab/ (coefficients checked
  // against the page). The page only tabulates XYZ inputs: its D65 white (L 1, a 0, b 0) is sRGB white.
  // The primaries below are widely quoted values recomputed from those matrices: they serve as
  // regression values, not as values published on the page.
  const references: ReadonlyArray<readonly [string, number, number, number]> = [
    ['#ff0000', 0.627955, 0.224863, 0.125846],
    ['#00ff00', 0.86644, -0.233888, 0.179498],
    ['#0000ff', 0.452014, -0.032457, -0.311528],
    ['#ffffff', 1, 0, 0],
    ['#000000', 0, 0, 0],
  ];

  it('matches the published reference values', () => {
    for (const [hex, L, a, b] of references) {
      const lab = rgbToOklab(rgbFromHex(hex));
      expect(lab.L).toBeCloseTo(L, 5);
      expect(lab.a).toBeCloseTo(a, 5);
      expect(lab.b).toBeCloseTo(b, 5);
    }
  });

  it('gives neutral grays a ~0 chroma and a strictly increasing lightness', () => {
    let previous = -Infinity;
    for (let v = 0; v < 256; v++) {
      const lab = rgbToOklab(rgb(v, v, v));
      expect(Math.abs(lab.a)).toBeLessThan(1e-6);
      expect(Math.abs(lab.b)).toBeLessThan(1e-6);
      expect(lab.L).toBeGreaterThan(previous);
      previous = lab.L;
    }
  });

  it('round-trips exactly on a dense sample (every 3rd value per channel, plus edges)', () => {
    const values = [...Array.from({ length: 86 }, (_, i) => i * 3), 254, 255];
    const out = new Float64Array(3);
    let mismatches = 0;
    for (const r of values) for (const g of values) for (const b of values) {
      const c = rgb(r, g, b);
      rgbToOklabInto(c, out);
      if (oklabToRgb({ L: out[0] ?? 0, a: out[1] ?? 0, b: out[2] ?? 0 }) !== c) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it.runIf(process.env.GEOPLACER_EXHAUSTIVE === '1')('round-trips exactly for all 16,777,216 colors', () => {
    const out = new Float64Array(3);
    let mismatches = 0;
    for (let v = 0; v <= 0xffffff; v++) {
      rgbToOklabInto(v as Rgb, out);
      if (oklabToRgb({ L: out[0] ?? 0, a: out[1] ?? 0, b: out[2] ?? 0 }) !== v) mismatches++;
    }
    expect(mismatches).toBe(0);
  }, 120_000);

  it('clamps out-of-gamut OKLab values instead of failing', () => {
    expect(oklabToRgb({ L: 2, a: 0, b: 0 })).toBe(0xffffff);
    expect(oklabToRgb({ L: -1, a: 0, b: 0 })).toBe(0x000000);
    expect(isRgb(oklabToRgb({ L: 0.7, a: 0.4, b: -0.4 }))).toBe(true);
  });
});

describe('invalid values are rejected at the checked entry points', () => {
  it('refuses non-colors in conversions and distances', () => {
    for (const bad of [TRANSPARENT, TRANSPARENT_U32, 0x1000000, 0.5]) {
      expectColorError(() => rgbToOklab(bad as Rgb), 'INVALID_RGB');
      expectColorError(() => oklabDistance.distance(bad as Rgb, 0 as Rgb), 'INVALID_RGB');
      expectColorError(() => rgbEuclideanDistance.distance(0 as Rgb, bad as Rgb), 'INVALID_RGB');
    }
  });

  it('refuses non-finite OKLab coordinates instead of returning black', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expectColorError(() => oklabToRgb({ L: bad, a: 0, b: 0 }), 'INVALID_OKLAB');
      expectColorError(() => oklabToRgb({ L: 0.5, a: bad, b: 0 }), 'INVALID_OKLAB');
    }
  });
});

describe('color distances', () => {
  const samples = [0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x808080, 0x123456, 0xfedcba].map((v) => v as Rgb);

  it('is a metric on samples: identity, symmetry, triangle inequality', () => {
    for (const distance of [oklabDistance, rgbEuclideanDistance]) {
      for (const x of samples) {
        expect(distance.distance(x, x)).toBe(0);
        for (const y of samples) {
          expect(distance.distance(x, y)).toBeCloseTo(distance.distance(y, x), 12);
          if (x !== y) expect(distance.distance(x, y)).toBeGreaterThan(0);
          for (const z of samples) {
            expect(distance.distance(x, z)).toBeLessThanOrEqual(distance.distance(x, y) + distance.distance(y, z) + 1e-12);
          }
        }
      }
    }
  });

  it('agrees with ΔE_OK computed from the coordinates', () => {
    expect(oklabDistance.distance(0xff0000 as Rgb, 0x00ff00 as Rgb)).toBeCloseTo(
      oklabDeltaE(rgbToOklab(0xff0000 as Rgb), rgbToOklab(0x00ff00 as Rgb)),
      12
    );
  });

  it('ranks a near color closer than a far one', () => {
    const base = rgb(200, 30, 30);
    expect(oklabDistance.distance(base, rgb(201, 30, 30))).toBeLessThan(oklabDistance.distance(base, rgb(30, 30, 200)));
  });

  it('keeps black clearly distinct from white and from near-black', () => {
    const black = rgb(0, 0, 0);
    expect(oklabDistance.distance(black, rgb(255, 255, 255))).toBeCloseTo(1, 6);
    expect(oklabDistance.distance(black, rgb(1, 1, 1))).toBeGreaterThan(0);
  });

  it('declares Euclidean spaces consistent with distance()', () => {
    for (const distance of [oklabDistance, rgbEuclideanDistance]) {
      const space = distance.euclideanSpace;
      expect(space?.dimensions).toBe(3);
      if (space === undefined) continue;
      const x = new Float64Array(3);
      const y = new Float64Array(3);
      for (const a of samples) {
        for (const b of samples) {
          space.project(a, x, 0);
          space.project(b, y, 0);
          const euclid = Math.sqrt(((x[0] ?? 0) - (y[0] ?? 0)) ** 2 + ((x[1] ?? 0) - (y[1] ?? 0)) ** 2 + ((x[2] ?? 0) - (y[2] ?? 0)) ** 2);
          expect(distance.distance(a, b)).toBe(euclid);
        }
      }
    }
  });

  it('exposes stable identifiers so the metric can be replaced', () => {
    expect(oklabDistance.id).toBe('oklab');
    expect(rgbEuclideanDistance.id).toBe('rgb-euclidean');
  });
});
