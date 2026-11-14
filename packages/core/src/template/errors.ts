/**
 * Template errors, with stable codes.
 */

export type TemplateErrorCode =
  /** Project or template id outside the allowed charset/length. */
  | 'INVALID_ID'
  /** Empty, too long or control-character name. */
  | 'INVALID_NAME'
  /** Not a PNG, unsupported header, or corrupt IHDR chunk. */
  | 'INVALID_PNG'
  /** Width, height or pixel count above the configured limits. */
  | 'IMAGE_TOO_LARGE'
  /** The decoder returned something inconsistent with the PNG header. */
  | 'DECODE_MISMATCH'
  /** A stored quantized image is not in the canonical form. */
  | 'CORRUPT_IMAGE'
  /** Unknown quantization algorithm, distance or version. */
  | 'UNSUPPORTED_QUANTIZATION'
  /** Invalid alpha threshold, palette or settings value. */
  | 'INVALID_INPUT'
  /** The manifest JSON is unreadable or violates the schema. */
  | 'INVALID_MANIFEST'
  /** The manifest declares a schema version this code cannot read. */
  | 'UNSUPPORTED_SCHEMA'
  | 'NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  /** A blob is missing or its SHA-256 does not match the manifest. */
  | 'INTEGRITY_ERROR'
  /** The template has been deleted (tombstone). */
  | 'DELETED'
  /** Deletion requested without the exact template name. */
  | 'CONFIRMATION_REQUIRED'
  /** Another writer changed the manifest (generation mismatch), or a number is already reserved. */
  | 'CONFLICT'
  /** Reserved numbering, but reservations are missing: repair needs explicit consent. */
  | 'RESERVATIONS_MISSING';

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;

  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
  }
}

/** Thrown by TemplateStorage.writeManifest implementations on a generation mismatch. */
export class StorageConflictError extends Error {
  readonly expected: number | null;
  readonly actual: number | null;

  constructor(expected: number | null, actual: number | null) {
    super(`manifest generation conflict: expected ${String(expected)}, found ${String(actual)}`);
    this.name = 'StorageConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}
