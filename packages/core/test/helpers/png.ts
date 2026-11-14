/**
 * Test helper: writes real PNG files of any colour type and bit depth
 * (no filtering, one zlib stream), so fixtures are generated in code
 * (*.png files are ignored by Git).
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/index.js';

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  readonly bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Unfiltered scanline bytes (without the filter byte) for row y. */
  readonly row: (y: number) => Uint8Array;
  /** PLTE entries for colour type 3. */
  readonly palette?: ReadonlyArray<readonly [number, number, number]>;
  /** tRNS alpha values for colour type 3. */
  readonly paletteAlpha?: readonly number[];
  readonly interlace?: 0 | 1;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function writePng(spec: PngSpec): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, spec.width);
  view.setUint32(4, spec.height);
  ihdr[8] = spec.bitDepth;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlace ?? 0;

  const rows: Uint8Array[] = [];
  for (let y = 0; y < spec.height; y++) {
    const data = spec.row(y);
    const line = new Uint8Array(1 + data.length); // filter byte 0
    line.set(data, 1);
    rows.push(line);
  }
  const raw = new Uint8Array(rows.reduce((n, r) => n + r.length, 0));
  let offset = 0;
  for (const r of rows) {
    raw.set(r, offset);
    offset += r.length;
  }

  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (spec.palette) parts.push(chunk('PLTE', new Uint8Array(spec.palette.flat())));
  if (spec.paletteAlpha) parts.push(chunk('tRNS', new Uint8Array(spec.paletteAlpha)));
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0)));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** RGBA 8-bit PNG from a pixel function returning [r, g, b, a]. */
export function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  return writePng({
    width,
    height,
    colorType: 6,
    bitDepth: 8,
    row: (y) => {
      const line = new Uint8Array(width * 4);
      for (let x = 0; x < width; x++) line.set(pixel(x, y), x * 4);
      return line;
    },
  });
}
