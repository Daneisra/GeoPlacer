/**
 * Phase 1B.4: color-by-color before / after the typed-array color table.
 *
 *   npm run bench:color-by-color
 *
 * `previous` is a verbatim copy of the Phase 1B.3 algorithm (Map lookups,
 * three passes). Both run in the same process, alternately (ABAB…), so that
 * machine load affects them equally; the median of ROUNDS runs is reported.
 * Before timing, the orders are compared on the full-size images: whole
 * image, a region, and an explicit colorOrder. Memory: peak of JS heap +
 * ArrayBuffers above the baseline, excluding the image and the returned
 * order (4 bytes per eligible pixel, the same for both).
 */

import type { ImageRect, StrategyConfig, TemplateImage } from '../src/index.js';
import { TRANSPARENT_U32, colorByColor } from '../src/index.js';

const ROUNDS = 7;
const COLORS = Array.from({ length: 32 }, (_, i) => (((i * 97) % 256) << 16) | (((i * 53 + 40) % 256) << 8) | ((i * 29 + 90) % 256));

function makeImage(size: number, kind: 'uniform' | 'pixel-art' | 'noise'): TemplateImage {
  const pixels = new Uint32Array(size * size);
  let seed = 0x9e3779b9;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let value: number;
      if (kind === 'uniform') value = COLORS[3] ?? 0;
      else if (kind === 'noise') {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const v = seed >>> 0;
        value = (v & 7) === 0 ? TRANSPARENT_U32 : (COLORS[(v >>> 3) & 31] ?? 0);
      } else {
        const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
        value = block === 32 ? TRANSPARENT_U32 : (COLORS[block] ?? 0);
      }
      pixels[iy * size + ix] = value;
    }
  }
  return { width: size, height: size, pixels };
}

// ───────────── Phase 1B.3 implementation (reference, unchanged) ─────────────

function previous(image: TemplateImage, config: StrategyConfig, r: ImageRect): Uint32Array {
  const explicit = config.colorOrder ?? [];
  const counts = new Map<number, number>();
  const { pixels, width } = image;
  let last = TRANSPARENT_U32;
  let run = 0;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    if (p === last) {
      run++;
      continue;
    }
    if (last !== TRANSPARENT_U32) counts.set(last, (counts.get(last) ?? 0) + run);
    last = p;
    run = 1;
  }
  if (last !== TRANSPARENT_U32) counts.set(last, (counts.get(last) ?? 0) + run);
  const listed = explicit.filter((c) => counts.has(c));
  const listedSet = new Set<number>(listed);
  const rest = [...counts.keys()].filter((c) => !listedSet.has(c)).sort((a, b) => counts.get(a)! - counts.get(b)! || a - b);
  const colors = [...listed, ...rest];
  const rank = new Map<number, number>(colors.map((c, k) => [c, k]));
  const start = new Float64Array(colors.length + 1);
  const x1 = r.ix + r.width;
  const y1 = r.iy + r.height;
  last = TRANSPARENT_U32;
  let lastRank = -1;
  for (let iy = r.iy; iy < y1; iy++) {
    for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
      const p = pixels[i]!;
      if (p === TRANSPARENT_U32) continue;
      if (p !== last) {
        last = p;
        lastRank = rank.get(p)!;
      }
      start[lastRank + 1]! += 1;
    }
  }
  for (let k = 1; k <= colors.length; k++) start[k]! += start[k - 1]!;
  const order = new Uint32Array(start[colors.length]!);
  last = TRANSPARENT_U32;
  for (let iy = r.iy; iy < y1; iy++) {
    for (let i = iy * width + r.ix, end = iy * width + x1; i < end; i++) {
      const p = pixels[i]!;
      if (p === TRANSPARENT_U32) continue;
      if (p !== last) {
        last = p;
        lastRank = rank.get(p)!;
      }
      order[start[lastRank]!++] = i;
    }
  }
  return order;
}

const current = (image: TemplateImage, config: StrategyConfig, r: ImageRect): Uint32Array => colorByColor.order(image, config, r);

/** Timed path of the new version: the cursor builds the full order, then yields the first batch (no extra copy). */
function currentCursor(image: TemplateImage, config: StrategyConfig, r: ImageRect): number {
  const cursor = colorByColor.cursor(image, config, r);
  return cursor.next(new Uint32Array(1000));
}
const eligible = (image: TemplateImage): number => image.pixels.reduce((n, p) => (p === TRANSPARENT_U32 ? n : n + 1), 0);

function same(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const gc = (globalThis as { gc?: () => void }).gc;
const used = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;

/** Time to the first batch; extra memory above the order itself (4 bytes per eligible pixel, held by both versions). */
function measure(fn: () => unknown, orderBytes: number): { ms: number; extraMb: number } {
  gc?.();
  const base = used();
  const t = performance.now();
  const result = fn();
  const ms = performance.now() - t;
  const extra = used() - base - orderBytes;
  void result;
  return { ms, extraMb: Math.max(0, extra) / 1e6 };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

console.log(`Node ${process.version}, ${process.platform}/${process.arch}; median of ${ROUNDS} alternated runs`);
for (const size of [2000, 4096]) {
  for (const kind of ['uniform', 'pixel-art', 'noise'] as const) {
    const image = makeImage(size, kind);
    const whole = { ix: 0, iy: 0, width: size, height: size };
    const region = { ix: 100, iy: 37, width: size - 300, height: size - 500 };
    const checks: Array<[string, StrategyConfig, ImageRect]> = [
      ['whole', { id: 'color-by-color' }, whole],
      ['region', { id: 'color-by-color' }, region],
      ['colorOrder', { id: 'color-by-color', colorOrder: [COLORS[7], COLORS[3], 0x123456] as never }, whole],
    ];
    for (const [label, config, r] of checks) {
      if (!same(previous(image, config, r), current(image, config, r))) throw new Error(`order differs: ${size} ${kind} ${label}`);
    }
    const before: number[] = [];
    const after: number[] = [];
    let memBefore = 0;
    let memAfter = 0;
    for (let k = 0; k < ROUNDS; k++) {
      const bytes = eligible(image) * 4;
      const a = measure(() => previous(image, { id: 'color-by-color' }, whole), bytes);
      const b = measure(() => currentCursor(image, { id: 'color-by-color' }, whole), bytes);
      before.push(a.ms);
      after.push(b.ms);
      memBefore = Math.max(memBefore, a.extraMb);
      memAfter = Math.max(memAfter, b.extraMb);
    }
    console.log(
      JSON.stringify({
        size: `${size}x${size}`,
        kind,
        sameOrder: true,
        beforeMs: Math.round(median(before)),
        afterMs: Math.round(median(after)),
        speedup: +(median(before) / median(after)).toFixed(2),
        extraMbBefore: +memBefore.toFixed(1),
        extraMbAfter: +memAfter.toFixed(1),
      })
    );
  }
}
