/**
 * sRGB <-> OKLab conversions and perceptual distance.
 *
 * Reference: Björn Ottosson, "A perceptual color space for image processing"
 * (2020). sRGB channels are first linearised with the standard sRGB transfer
 * function, then mapped to LMS, cube-rooted and mapped to (L, a, b).
 *
 * Determinism: the same inputs give the same outputs on a given JavaScript
 * engine. Math.cbrt and Math.pow are implementation-approximated by the
 * ECMAScript spec, so results may differ in the last bits across engines;
 * tie-breaking is still deterministic (see palette matching).
 */

import type { ColorDistance, Rgb } from '../contracts/index.js';
import { blueOf, greenOf, redOf } from './rgb.js';

export interface Oklab {
  /** Lightness, 0 (black) to ~1 (white). */
  readonly L: number;
  /** Green (-) to red (+). */
  readonly a: number;
  /** Blue (-) to yellow (+). */
  readonly b: number;
}

/** sRGB 8-bit channel -> linear light, precomputed for the 256 values. */
const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbChannelToLinear(channel: number): number {
  return SRGB_TO_LINEAR[channel] ?? Number.NaN;
}

/** Linear light -> sRGB 8-bit channel, rounded to nearest and clamped to [0, 255]. */
export function linearToSrgbChannel(value: number): number {
  const v = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

/** Writes the OKLab coordinates of `color` into out[offset..offset+2] (no allocation). */
export function rgbToOklabInto(color: Rgb, out: Float64Array | number[], offset = 0): void {
  const r = srgbChannelToLinear(redOf(color));
  const g = srgbChannelToLinear(greenOf(color));
  const b = srgbChannelToLinear(blueOf(color));

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  out[offset] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[offset + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[offset + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

export function rgbToOklab(color: Rgb): Oklab {
  const out = [0, 0, 0];
  rgbToOklabInto(color, out);
  return { L: out[0] ?? 0, a: out[1] ?? 0, b: out[2] ?? 0 };
}

/**
 * OKLab -> nearest 24-bit sRGB color. Out-of-gamut values are clamped per
 * channel (documented, not an error): OKLab covers more than sRGB.
 */
export function oklabToRgb(lab: Oklab): Rgb {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);

  const r = linearToSrgbChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = linearToSrgbChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = linearToSrgbChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return ((r << 16) | (g << 8) | b) as Rgb;
}

/** Euclidean distance in OKLab (ΔE_OK). */
export function oklabDeltaE(x: Oklab, y: Oklab): number {
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

/**
 * OKLab perceptual distance as a replaceable ColorDistance. Converted colors
 * are memoised (bounded cache, cleared when full) because nearest-color
 * searches compare the same palette colors many times.
 */
export function createOklabDistance(maxCachedColors = 65_536): ColorDistance {
  const cache = new Map<number, Float64Array>();
  const labOf = (color: Rgb): Float64Array => {
    let lab = cache.get(color);
    if (lab === undefined) {
      if (cache.size >= maxCachedColors) cache.clear();
      lab = new Float64Array(3);
      rgbToOklabInto(color, lab);
      cache.set(color, lab);
    }
    return lab;
  };
  return {
    id: 'oklab',
    distance(a: Rgb, b: Rgb): number {
      if (a === b) return 0;
      const x = labOf(a);
      const y = labOf(b);
      return Math.hypot((x[0] ?? 0) - (y[0] ?? 0), (x[1] ?? 0) - (y[1] ?? 0), (x[2] ?? 0) - (y[2] ?? 0));
    },
  };
}

/** Default OKLab distance instance. */
export const oklabDistance: ColorDistance = createOklabDistance();

/** Euclidean distance in sRGB (the legacy Wplacer metric), kept for comparison. */
export const rgbEuclideanDistance: ColorDistance = {
  id: 'rgb-euclidean',
  distance(a: Rgb, b: Rgb): number {
    return Math.hypot(redOf(a) - redOf(b), greenOf(a) - greenOf(b), blueOf(a) - blueOf(b));
  },
};
