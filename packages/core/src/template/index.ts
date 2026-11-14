export { StorageConflictError, TemplateError, type TemplateErrorCode } from './errors.js';
export { ID_PATTERN, MAX_NAME_LENGTH, asProjectId, asTemplateId, isValidId, normalizeName } from './ids.js';
export { DEFAULT_TEMPLATE_LIMITS, assertValidLimits, assertWithinLimits, type TemplateLimits } from './limits.js';
export { crc32, readPngHeader, type PngHeader } from './png-header.js';
export { QUANTIZED_MAGIC, countPaintable, quantizedToRgba, rgbaToQuantized, serializeQuantized } from './pixels.js';
export {
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_QUANTIZATION,
  assertAlphaThresholdValue,
  paletteColors,
  quantizeDecoded,
  resolveQuantization,
  supportedDistances,
  type QuantizedSource,
} from './quantization.js';
