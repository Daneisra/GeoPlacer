/**
 * Quantization methods recorded in revisions. A method is identified by
 * (algorithm, distance id, version); changing any of them is a new revision.
 */

import type { ColorDistance, DecodedImage, Palette, QuantizationMethod, QuantizationStats, Rgb, TemplateImage } from '../contracts/index.js';
import { isRgb } from '../color/rgb.js';
import { oklabDistance, rgbEuclideanDistance } from '../color/oklab.js';
import { quantizeRgba } from '../palette/quantize.js';
import { TemplateError } from './errors.js';

export const DEFAULT_ALPHA_THRESHOLD = 128;

export const DEFAULT_QUANTIZATION: QuantizationMethod = { algorithm: 'nearest-color', distance: 'oklab', version: 1 };

const DISTANCES: Readonly<Record<string, ColorDistance>> = {
  [oklabDistance.id]: oklabDistance,
  [rgbEuclideanDistance.id]: rgbEuclideanDistance,
};

export function supportedDistances(): readonly string[] {
  return Object.keys(DISTANCES);
}

export function resolveQuantization(method: QuantizationMethod): ColorDistance {
  const distance = DISTANCES[method.distance];
  if (method.algorithm !== 'nearest-color' || method.version !== 1 || distance === undefined) {
    throw new TemplateError(
      'UNSUPPORTED_QUANTIZATION',
      `unsupported quantization ${JSON.stringify(method)} (supported: nearest-color v1 with ${supportedDistances().join(', ')})`
    );
  }
  return distance;
}

export function assertAlphaThresholdValue(threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 256) {
    throw new TemplateError('INVALID_INPUT', `alphaThreshold must be an integer in [0, 256], got ${String(threshold)}`);
  }
}

/** Ordered RGB list of a palette (the order breaks ties, so it is identity). */
export function paletteColors(palette: Palette): readonly Rgb[] {
  if (palette.colors.length === 0) throw new TemplateError('INVALID_INPUT', 'the palette is empty');
  return palette.colors.map((entry, i) => {
    if (!isRgb(entry.rgb)) throw new TemplateError('INVALID_INPUT', `palette color ${i} is not a 24-bit RGB value`);
    return entry.rgb;
  });
}

export interface QuantizedSource {
  readonly image: TemplateImage;
  readonly stats: QuantizationStats;
}

export function quantizeDecoded(decoded: DecodedImage, palette: Palette, alphaThreshold: number, method: QuantizationMethod): QuantizedSource {
  assertAlphaThresholdValue(alphaThreshold);
  const distance = resolveQuantization(method);
  const result = quantizeRgba(decoded.rgba, decoded.width, decoded.height, paletteColors(palette), distance, { alphaThreshold });
  return { image: result.image, stats: result.stats };
}
