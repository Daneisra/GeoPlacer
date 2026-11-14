/**
 * Geometry errors: every rejection carries a stable code, never a silent fix.
 */

export type GeometryErrorCode =
  /** A coordinate or size is not a safe integer (NaN, Infinity, fraction, beyond 2^53). */
  | 'NOT_AN_INTEGER'
  /** A computed coordinate would leave the safe-integer range. */
  | 'OUT_OF_RANGE'
  /** A width or height is below 1. */
  | 'INVALID_SIZE'
  /** The coordinate system declares an unsupported y direction. */
  | 'UNKNOWN_COORDINATE_SYSTEM'
  /** Two coordinate systems cannot be related without guessing. */
  | 'AMBIGUOUS_TRANSFORM'
  /** The placed template does not intersect the canvas bounds. */
  | 'PLACEMENT_OUTSIDE_BOUNDS'
  /** The placed template crosses the canvas bounds and partial placements are not allowed. */
  | 'PLACEMENT_PARTIALLY_OUTSIDE';

export class GeometryError extends Error {
  readonly code: GeometryErrorCode;

  constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = 'GeometryError';
    this.code = code;
  }
}
