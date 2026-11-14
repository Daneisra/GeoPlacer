/**
 * Template size limits (configurable internally; V1 defaults below).
 * Checked on the PNG header BEFORE decoding, then again on the decoded image.
 */

import { TemplateError } from './errors.js';

export interface TemplateLimits {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

export const DEFAULT_TEMPLATE_LIMITS: TemplateLimits = {
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 16_777_216,
};

/** Pixel indexes (iy * width + ix) must fit an unsigned 32-bit integer. */
const MAX_INDEXABLE_PIXELS = 2 ** 32;

export function assertValidLimits(limits: TemplateLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TemplateError('INVALID_INPUT', `limit ${key} must be a positive integer, got ${String(value)}`);
    }
  }
  if (limits.maxPixels > MAX_INDEXABLE_PIXELS) {
    throw new TemplateError('INVALID_INPUT', `maxPixels cannot exceed 2^32 (Uint32 pixel indexes)`);
  }
}

export function assertWithinLimits(width: number, height: number, limits: TemplateLimits = DEFAULT_TEMPLATE_LIMITS): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new TemplateError('INVALID_PNG', `image size must be at least 1x1, got ${String(width)}x${String(height)}`);
  }
  if (width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels) {
    throw new TemplateError(
      'IMAGE_TOO_LARGE',
      `image ${width}x${height} exceeds the limits (${limits.maxWidth}x${limits.maxHeight}, ${limits.maxPixels} pixels)`
    );
  }
}
