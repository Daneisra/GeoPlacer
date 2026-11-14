/**
 * PNG codec backed by pngjs 7 (pure JavaScript, MIT, no native code).
 * Decoding accepts every standard PNG (grey, RGB, palette + tRNS,
 * grey/RGB + alpha, 1-16 bits, interlaced) and returns 8-bit RGBA
 * (16-bit samples are rescaled by pngjs). Encoding writes 8-bit RGBA.
 * The caller (core) checks the header and the size limits BEFORE decoding.
 */

import pngjs from 'pngjs';
import type { DecodedImage, PngCodec } from '@geoplacer/core';

const { PNG } = pngjs;

export const pngjsCodec: PngCodec = {
  id: 'pngjs-7',

  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { checkCRC: true });
    return { width: png.width, height: png.height, rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  },

  async encode(image: DecodedImage): Promise<Uint8Array> {
    const png = new PNG({ width: image.width, height: image.height, colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8 });
    png.data = Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength);
    const out = PNG.sync.write(png, { colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8 });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};
