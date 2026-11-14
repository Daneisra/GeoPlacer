/**
 * Phase 1B.5 study: does reading a snapshot row by row beat get() per pixel
 * for the progress computation? Bench only: no contract change unless the
 * gain is clear.
 *
 *   npm run bench:snapshot-read
 *
 * `perPixel` is computeProgress (one snapshot.get per eligible pixel).
 * `byRow` is a prototype of the SAME counting loop (per-color slots,
 * 5 counters per color) where the snapshot gives one row as an Int32Array
 * (here: a subarray of the backing array, the cheapest possible row
 * reader), with the same rules for unknown and invalid values. Only the
 * pixel access differs. Results are compared before timing.
 * Alternated runs, median of 7.
 */

import type { ProgressTemplate, TemplateId, TemplateImage } from '../src/index.js';
import { TRANSPARENT, TRANSPARENT_U32, UNKNOWN, computeProgress, createArraySnapshot } from '../src/index.js';

const COLORS = Array.from({ length: 32 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);

function makeImage(size: number, kind: 'pixel-art' | 'noise'): TemplateImage {
  const pixels = new Uint32Array(size * size);
  let seed = 0x9e3779b9;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      if (kind === 'noise') {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const v = seed >>> 0;
        pixels[iy * size + ix] = (v & 7) === 0 ? TRANSPARENT_U32 : (COLORS[(v >>> 3) & 31] ?? 0);
      } else {
        const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
        pixels[iy * size + ix] = block === 32 ? TRANSPARENT_U32 : (COLORS[block] ?? 0);
      }
    }
  }
  return { width: size, height: size, pixels };
}

function canvasFor(image: TemplateImage, unknownRows: number): Int32Array {
  const { width, pixels } = image;
  const out = new Int32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    if (Math.floor(i / width) >= image.height - unknownRows) out[i] = UNKNOWN;
    else if (p === TRANSPARENT_U32) out[i] = TRANSPARENT;
    else out[i] = i % 2 === 0 ? p : i % 4 === 1 ? (p ^ 0x010101) & 0xffffff : TRANSPARENT;
  }
  return out;
}

/**
 * Prototype: the counting loop of computeProgress (per-color slots through
 * a Map with a last-color cache, 5 counters per color), reading whole rows
 * instead of calling get(). Placement (0, 0), y down, snapshot = image area.
 */
function byRow(image: TemplateImage, canvas: Int32Array): { correct: number; wrongColor: number; missing: number; unknown: number } {
  const { width, height, pixels } = image;
  const slotOf = new Map<number, number>();
  let counters = new Float64Array(16 * 5);
  let capacity = 16;
  let lastColor = TRANSPARENT_U32;
  let slot = -1;
  for (let iy = 0; iy < height; iy++) {
    const row = canvas.subarray(iy * width, iy * width + width); // readRow(y, x0, x1)
    const base = iy * width;
    for (let ix = 0; ix < width; ix++) {
      const expected = pixels[base + ix]!;
      if (expected === TRANSPARENT_U32) continue;
      if (expected !== lastColor) {
        lastColor = expected;
        let found = slotOf.get(expected);
        if (found === undefined) {
          found = slotOf.size;
          slotOf.set(expected, found);
          if (found >= capacity) {
            const grown = new Float64Array(capacity * 2 * 5);
            grown.set(counters);
            counters = grown;
            capacity *= 2;
          }
        }
        slot = found * 5;
      }
      counters[slot]! += 1;
      const seen = row[ix]!;
      if (seen === expected) counters[slot + 1]! += 1;
      else if (seen === UNKNOWN) counters[slot + 4]! += 1;
      else if (seen === TRANSPARENT) counters[slot + 3]! += 1;
      else if (seen >= 0 && seen <= 0xffffff) counters[slot + 2]! += 1;
      else counters[slot + 4]! += 1;
    }
  }
  const sum = (k: number): number => {
    let n = 0;
    for (let i = 0; i < slotOf.size; i++) n += counters[i * 5 + k]!;
    return n;
  };
  return { correct: sum(1), wrongColor: sum(2), missing: sum(3), unknown: sum(4) };
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;

console.log(`Node ${process.version}, ${process.platform}/${process.arch}; alternated runs, median of 7`);
for (const size of [1000, 2000, 4096]) {
  for (const kind of ['pixel-art', 'noise'] as const) {
    for (const unknownShare of [0, 50] as const) {
      const image = makeImage(size, kind);
      const canvas = canvasFor(image, Math.round((size * unknownShare) / 100));
      const snapshot = createArraySnapshot({ rect: { minX: 0, minY: 0, width: size, height: size }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: 0, pixels: canvas });
      const template: ProgressTemplate = { id: 'b' as TemplateId, revision: 1, image, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } };
      const reference = computeProgress(template, snapshot, 1);
      const rows = byRow(image, canvas);
      for (const key of ['correct', 'wrongColor', 'missing', 'unknown'] as const) {
        if (reference[key] !== rows[key]) throw new Error(`${key} differs: ${reference[key]} vs ${rows[key]}`);
      }
      const a: number[] = [];
      const b: number[] = [];
      for (let k = 0; k < 7; k++) {
        let t = performance.now();
        computeProgress(template, snapshot, 1);
        a.push(performance.now() - t);
        t = performance.now();
        byRow(image, canvas);
        b.push(performance.now() - t);
      }
      console.log(JSON.stringify({ size: `${size}x${size}`, kind, unknownShare, perPixelMs: Math.round(median(a)), byRowMs: Math.round(median(b)), speedup: +(median(a) / median(b)).toFixed(2) }));
    }
  }
}
