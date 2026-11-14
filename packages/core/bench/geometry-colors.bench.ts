/**
 * Phase 1B.1 benchmarks: projection, OKLab and quantization on large images.
 * Run: npm run bench:core   (node --expose-gc --import tsx ...)
 *
 * Each case reports the first run (cold: includes JIT warm-up) and the median
 * of the following runs (warm). Memory is heap + ArrayBuffers after GC.
 */

import type { ColorDistance, Rgb } from '../src/index.js';
import {
  canvasXOf,
  canvasYOf,
  createPaletteMatcher,
  imageToCanvas,
  oklabDistance,
  placementTransform,
  quantizeWithMatcher,
  rgb,
  rgbToOklabInto,
} from '../src/index.js';

const WIDTH = 2000;
const HEIGHT = 2000;
const PIXELS = WIDTH * HEIGHT;
const WARM_RUNS = 3;

const gc = (globalThis as { gc?: () => void }).gc;
/** JS heap only: typed-array buffers are released lazily and counted exactly below instead. */
const heap = (): number => {
  gc?.();
  return process.memoryUsage().heapUsed;
};
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

/** Exact size of the typed arrays a result holds (pixels buffer of a quantization, or the array itself). */
function typedBytes(result: unknown): number {
  if (ArrayBuffer.isView(result)) return result.byteLength;
  const pixels = (result as { image?: { pixels?: unknown } } | null)?.image?.pixels;
  return ArrayBuffer.isView(pixels) ? pixels.byteLength : 0;
}

interface Measure {
  readonly coldMs: number;
  readonly warmMs: number;
  /** Heap retained by the result plus the exact size of its typed arrays. */
  readonly memoryDelta: number;
}

function measure(fn: () => unknown): Measure {
  const before = heap();
  let t = performance.now();
  let keep: unknown = fn();
  const coldMs = performance.now() - t;
  const memoryDelta = Math.max(0, heap() - before) + typedBytes(keep);
  const warm: number[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    keep = undefined;
    t = performance.now();
    keep = fn();
    warm.push(performance.now() - t);
  }
  void keep;
  warm.sort((a, b) => a - b);
  return { coldMs, warmMs: warm[Math.floor(warm.length / 2)] ?? Number.NaN, memoryDelta };
}

function report(name: string, m: Measure, extra = ''): void {
  console.log(
    `${name.padEnd(58)} cold ${m.coldMs.toFixed(0).padStart(6)} ms | warm ${m.warmMs.toFixed(0).padStart(6)} ms | retained ${mb(m.memoryDelta).padStart(9)}${extra ? ` | ${extra}` : ''}`
  );
}

/** Deterministic pseudo-random generator (LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s;
  };
}

/** 64-color palette: 4 levels per channel. */
const PALETTE: Rgb[] = [];
for (const r of [0, 85, 170, 255]) for (const g of [0, 85, 170, 255]) for (const b of [0, 85, 170, 255]) PALETTE.push(rgb(r, g, b));

console.log(`Node ${process.version}, ${WIDTH}x${HEIGHT} = ${PIXELS.toLocaleString('en-US')} pixels, palette ${PALETTE.length} colors, gc ${gc ? 'on' : 'OFF'}`);
console.log('');

// ── 1. Projection ──────────────────────────────────────────────────────────
const placement = { topLeft: { x: 100_000, y: 50_000 } };
const system = { yAxis: 'up' as const };

report(
  'projection: imageToCanvas (object per pixel, checked)',
  measure(() => {
    const points = new Array<{ x: number; y: number }>(PIXELS);
    let i = 0;
    for (let iy = 0; iy < HEIGHT; iy++) for (let ix = 0; ix < WIDTH; ix++) points[i++] = imageToCanvas({ ix, iy }, placement, system);
    return points;
  })
);

report(
  'projection: PlacementTransform (numeric, no allocation)',
  measure(() => {
    const t = placementTransform(placement, system);
    let checksum = 0;
    for (let iy = 0; iy < HEIGHT; iy++) {
      const y = canvasYOf(t, iy);
      for (let ix = 0; ix < WIDTH; ix++) checksum += canvasXOf(t, ix) ^ y;
    }
    return checksum;
  })
);

// ── 2. OKLab ───────────────────────────────────────────────────────────────
report(
  'oklab: rgbToOklabInto, all 16,777,216 colors',
  measure(() => {
    const out = new Float64Array(3);
    let sum = 0;
    for (let v = 0; v <= 0xffffff; v++) {
      rgbToOklabInto(v as Rgb, out);
      sum += out[0] ?? 0;
    }
    return sum;
  })
);

const lookups = 250_000;
// Same OKLab metric without euclideanSpace: forces the generic path.
const genericOklab: ColorDistance = { id: 'oklab-generic', distance: (a, b) => oklabDistance.distance(a, b) };
report(
  `nearest: ${lookups.toLocaleString('en-US')} random colors, generic path (distance() x 64)`,
  measure(() => {
    const matcher = createPaletteMatcher(PALETTE, genericOklab, 0);
    const next = lcg(1);
    let sum = 0;
    for (let i = 0; i < lookups; i++) sum += matcher.nearestIndex((next() & 0xffffff) as Rgb);
    return sum;
  })
);
report(
  `nearest: same colors, Euclidean fast path (OKLab space)`,
  measure(() => {
    const matcher = createPaletteMatcher(PALETTE, oklabDistance, 0);
    const next = lcg(1);
    let sum = 0;
    for (let i = 0; i < lookups; i++) sum += matcher.nearestIndex((next() & 0xffffff) as Rgb);
    return sum;
  })
);

// ── 3. Quantization ────────────────────────────────────────────────────────
function pixelArtImage(): Uint8ClampedArray {
  // 32 distinct colors in 50x50 blocks, all opaque except a transparent border.
  const buffer = new Uint8ClampedArray(PIXELS * 4);
  const next = lcg(7);
  const colors = Array.from({ length: 32 }, () => next() & 0xffffff);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = (y * WIDTH + x) * 4;
      const c = colors[((Math.floor(x / 50) + Math.floor(y / 50)) & 31)] ?? 0;
      buffer[p] = (c >>> 16) & 0xff;
      buffer[p + 1] = (c >>> 8) & 0xff;
      buffer[p + 2] = c & 0xff;
      buffer[p + 3] = x < 10 ? 0 : 255;
    }
  }
  return buffer;
}

function noiseImage(): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(PIXELS * 4);
  const next = lcg(11);
  for (let i = 0; i < PIXELS; i++) {
    const c = next();
    buffer[i * 4] = c & 0xff;
    buffer[i * 4 + 1] = (c >>> 8) & 0xff;
    buffer[i * 4 + 2] = (c >>> 16) & 0xff;
    buffer[i * 4 + 3] = 255;
  }
  return buffer;
}

const art = pixelArtImage();
const noise = noiseImage();
const options = { alphaThreshold: 128 };

let lastStats = '';
report(
  'quantize 2000x2000 pixel art (32 source colors) -> 64 colors',
  measure(() => {
    const r = quantizeWithMatcher(art, WIDTH, HEIGHT, createPaletteMatcher(PALETTE, oklabDistance), options);
    lastStats = `transparent ${r.stats.transparent}, exact ${r.stats.exact}, approximated ${r.stats.approximated}`;
    return r;
  }),
  lastStats
);

report(
  'quantize 2000x2000 pixel art, memo disabled',
  measure(() => quantizeWithMatcher(art, WIDTH, HEIGHT, createPaletteMatcher(PALETTE, oklabDistance, 0), options))
);
report(
  'quantize 2000x2000 noise (~4M source colors) -> 64 colors',
  measure(() => quantizeWithMatcher(noise, WIDTH, HEIGHT, createPaletteMatcher(PALETTE, oklabDistance), options))
);
report(
  'quantize 2000x2000 noise, memo disabled',
  measure(() => quantizeWithMatcher(noise, WIDTH, HEIGHT, createPaletteMatcher(PALETTE, oklabDistance, 0), options))
);

// ── 4. Representation cost ─────────────────────────────────────────────────
report(
  'representation: Uint32Array of 4M pixels',
  measure(() => new Uint32Array(PIXELS).fill(0x123456))
);
report(
  'representation: 4M objects {ix, iy, color}',
  measure(() => {
    const objects = new Array<{ ix: number; iy: number; color: number }>(PIXELS);
    for (let i = 0; i < PIXELS; i++) objects[i] = { ix: i % WIDTH, iy: (i / WIDTH) | 0, color: 0x123456 };
    return objects;
  })
);
