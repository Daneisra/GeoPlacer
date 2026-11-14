/**
 * Color and palette errors, with stable codes.
 */

export type ColorErrorCode =
  /** A channel is not an integer in [0, 255]. */
  | 'INVALID_CHANNEL'
  /** A value is not a 24-bit RGB integer in [0, 0xFFFFFF]. */
  | 'INVALID_RGB'
  /** A hex string is not #RGB or #RRGGBB. */
  | 'INVALID_HEX'
  /** No color to match against. */
  | 'EMPTY_PALETTE'
  /** An RGBA buffer does not match its declared size. */
  | 'INVALID_IMAGE'
  /** The alpha threshold is not an integer in [0, 256]. */
  | 'INVALID_ALPHA_THRESHOLD'
  /** OKLab coordinates are not finite numbers. */
  | 'INVALID_OKLAB';

export class ColorError extends Error {
  readonly code: ColorErrorCode;

  constructor(code: ColorErrorCode, message: string) {
    super(message);
    this.name = 'ColorError';
    this.code = code;
  }
}
