/**
 * Palettes and color matching. Layer 1.
 *
 * A Palette is a catalog (quantization, UI). What an agent can actually paint
 * is its own unlocked color set (ResourceSnapshot.unlockedColors): each agent
 * has its own palette.
 */

import type { Rgb } from './primitives.js';

export interface PaletteColor {
  readonly rgb: Rgb;
  readonly name?: string;
  /** Configurable unlock cost, never hard-coded in the engine. */
  readonly unlockCost?: number;
}

export interface Palette {
  readonly id: string;
  readonly colors: readonly PaletteColor[];
}

/**
 * Replaceable color distance. Phase 1B.1 provides OKLab (perceptual);
 * other metrics can be plugged in without touching the callers.
 */
export interface ColorDistance {
  readonly id: string;
  /** Non-negative; 0 means identical colors. */
  distance(a: Rgb, b: Rgb): number;
}

export interface QuantizeOptions {
  readonly distance: ColorDistance;
  /** Source pixels with alpha below this value (0-255) become transparent. */
  readonly alphaThreshold: number;
}

export interface QuantizedImage {
  readonly width: number;
  readonly height: number;
  /** Row-major, top-down; 24-bit RGB or TRANSPARENT_U32. */
  readonly pixels: Uint32Array;
}

export interface PaletteManager {
  /** Deterministic: ties are broken by palette order. */
  nearest(rgb: Rgb, colors: readonly Rgb[], distance: ColorDistance): Rgb;
  /** Convert decoded RGBA pixels (row-major, top-down) to palette colors. Deterministic. */
  quantize(rgba: Uint8ClampedArray, width: number, height: number, palette: Palette, options: QuantizeOptions): QuantizedImage;
  /** Colors used by an image that the given set cannot paint. */
  missingColors(image: QuantizedImage, available: ReadonlySet<Rgb>): ReadonlySet<Rgb>;
}
