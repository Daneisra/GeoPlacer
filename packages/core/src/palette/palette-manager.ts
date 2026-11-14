/**
 * PaletteManager contract implementation.
 */

import type { ColorDistance, Palette, PaletteManager, QuantizeOptions, QuantizedImage, Rgb } from '../contracts/index.js';
import { createPaletteMatcher } from './matcher.js';
import { missingColors, quantizeRgba } from './quantize.js';

export function createPaletteManager(): PaletteManager {
  return {
    nearest(color: Rgb, colors: readonly Rgb[], distance: ColorDistance): Rgb {
      return createPaletteMatcher(colors, distance).nearest(color);
    },
    quantize(rgba: Uint8ClampedArray, width: number, height: number, palette: Palette, options: QuantizeOptions): QuantizedImage {
      const colors = palette.colors.map((entry) => entry.rgb);
      return quantizeRgba(rgba, width, height, colors, options.distance, { alphaThreshold: options.alphaThreshold }).image;
    },
    missingColors,
  };
}
