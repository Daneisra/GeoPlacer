/**
 * 24-bit RGB colors (0xRRGGBB) and explicit alpha handling.
 *
 * Black (0x000000) is a regular color. Transparency is never encoded as a
 * color: it is TRANSPARENT (-1) at the API level and TRANSPARENT_U32
 * (0xFFFFFFFF, outside the 24-bit range) in compact pixel buffers.
 */

import type { Rgb } from '../contracts/index.js';
import { ColorError } from './errors.js';

export const RGB_MAX = 0xffffff;

function assertChannel(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new ColorError('INVALID_CHANNEL', `${name} must be an integer in [0, 255], got ${String(value)}`);
  }
}

/** True for an integer in [0, 0xFFFFFF]. */
export function isRgb(value: number): value is Rgb {
  return Number.isInteger(value) && value >= 0 && value <= RGB_MAX;
}

/** Validates and brands a 24-bit value. */
export function asRgb(value: number): Rgb {
  if (!isRgb(value)) throw new ColorError('INVALID_RGB', `expected a 24-bit RGB integer, got ${String(value)}`);
  return value;
}

export function rgb(r: number, g: number, b: number): Rgb {
  assertChannel(r, 'red');
  assertChannel(g, 'green');
  assertChannel(b, 'blue');
  return ((r << 16) | (g << 8) | b) as Rgb;
}

export function redOf(color: Rgb): number {
  return (color >>> 16) & 0xff;
}

export function greenOf(color: Rgb): number {
  return (color >>> 8) & 0xff;
}

export function blueOf(color: Rgb): number {
  return color & 0xff;
}

/** Accepts "#RRGGBB", "RRGGBB", "#RGB" or "RGB" (case-insensitive). Alpha forms are refused. */
export function rgbFromHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match || match[1] === undefined) throw new ColorError('INVALID_HEX', `expected #RGB or #RRGGBB, got ${JSON.stringify(hex)}`);
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return parseInt(digits, 16) as Rgb;
}

/** Canonical form: lower-case "#rrggbb". */
export function rgbToHex(color: Rgb): string {
  return `#${asRgb(color).toString(16).padStart(6, '0')}`;
}

/**
 * Alpha rule used by quantization: a pixel whose alpha (0-255) is below the
 * threshold is transparent; otherwise its RGB is used as is (no blending
 * with a background, no premultiplication). Threshold 0 keeps every pixel,
 * threshold 256 makes every pixel transparent.
 */
export function isTransparentAlpha(alpha: number, threshold: number): boolean {
  return alpha < threshold;
}

export function assertAlphaThreshold(threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 256) {
    throw new ColorError('INVALID_ALPHA_THRESHOLD', `alphaThreshold must be an integer in [0, 256], got ${String(threshold)}`);
  }
}
