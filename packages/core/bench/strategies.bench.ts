/**
 * Phase 1B.3 benchmark: the 8 drawing strategies on 2000 x 2000 and
 * 4096 x 4096 images.
 *
 *   npm run bench:strategies                              -> every scenario
 *   node --expose-gc --import tsx strategies.bench.ts <size> <kind> <strategy>   -> one
 *
 * Each scenario runs in a fresh process (cold JIT, clean heap):
 * - first batch: cursor creation + the first FIRST_BATCH indices (what the
 *   work planner waits for before it can paint);
 * - full order: draining the rest of the cursor (chunks of 65 536, not kept);
 * - extra memory: peak of (JS heap + ArrayBuffers) above the baseline taken
 *   after the image is built, sampled at every chunk. The image itself
 *   (4 bytes per pixel) and a stored full order (4 bytes per eligible
 *   pixel, if a caller keeps one) are not included;
 * - warm full order: a second complete run in the same process.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DrawingStrategyId, StrategyConfig, TemplateImage } from '../src/index.js';
import { DRAWING_STRATEGIES, TRANSPARENT_U32 } from '../src/index.js';

const FIRST_BATCH = 1000;
const CHUNK = 65_536;
const SIZES = [2000, 4096];
const KINDS = ['pixel-art', 'noise'] as const;
type Kind = (typeof KINDS)[number];
const IDS = Object.keys(DRAWING_STRATEGIES) as DrawingStrategyId[];

/** 32 colors, like the template benchmark. */
const COLORS = Array.from({ length: 32 }, (_, i) => (((i * 97) % 256) << 16) | (((i * 53 + 40) % 256) << 8) | ((i * 29 + 90) % 256));

function makeImage(size: number, kind: Kind): TemplateImage {
  const pixels = new Uint32Array(size * size);
  let seed = 0x9e3779b9;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let value: number;
      if (kind === 'noise') {
        // Random colors, 1 pixel in 8 transparent: worst case for runs and outlines.
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const v = seed >>> 0;
        value = (v & 7) === 0 ? TRANSPARENT_U32 : (COLORS[(v >>> 3) & 31] ?? 0);
      } else {
        // 16 x 16 blocks of palette colors, 1 block in 33 transparent.
        const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
        value = block === 32 ? TRANSPARENT_U32 : (COLORS[block] ?? 0);
      }
      pixels[iy * size + ix] = value;
    }
  }
  return { width: size, height: size, pixels };
}

const gc = (globalThis as { gc?: () => void }).gc;
const used = (): number => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

function runOne(size: number, kind: Kind, id: DrawingStrategyId): void {
  const image = makeImage(size, kind);
  const strategy = DRAWING_STRATEGIES[id];
  const config: StrategyConfig = id === 'random' ? { id, seed: 42 } : { id };
  const chunk = new Uint32Array(CHUNK);
  const first = new Uint32Array(FIRST_BATCH);
  gc?.();
  const base = used();
  let peak = 0;
  const sample = (): void => {
    peak = Math.max(peak, used() - base);
  };

  const t0 = performance.now();
  const cursor = strategy.cursor(image, config);
  let total = cursor.next(first);
  const firstMs = performance.now() - t0;
  sample();
  for (let n = cursor.next(chunk); n > 0; n = cursor.next(chunk)) {
    total += n;
    sample();
  }
  const fullMs = performance.now() - t0;

  const t1 = performance.now();
  const again = strategy.cursor(image, config);
  let total2 = again.next(first);
  for (let n = again.next(chunk); n > 0; n = again.next(chunk)) total2 += n;
  const warmMs = performance.now() - t1;
  if (total2 !== total) throw new Error('non-deterministic length');

  console.log(
    JSON.stringify({
      size: `${size}x${size}`,
      kind,
      strategy: id,
      pixels: total,
      firstBatchMs: +firstMs.toFixed(1),
      fullMs: Math.round(fullMs),
      warmFullMs: Math.round(warmMs),
      extraMb: +(peak / 1e6).toFixed(1),
    })
  );
}

const [sizeArg, kindArg, idArg] = process.argv.slice(2);
if (sizeArg !== undefined && (KINDS as readonly string[]).includes(kindArg ?? '') && IDS.includes(idArg as DrawingStrategyId)) {
  runOne(Number(sizeArg), kindArg as Kind, idArg as DrawingStrategyId);
} else {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}; first batch = ${FIRST_BATCH} pixels; one process per scenario`);
  const self = fileURLToPath(import.meta.url);
  for (const size of SIZES) {
    for (const kind of KINDS) {
      for (const id of IDS) {
        const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', self, String(size), kind, id], { stdio: 'inherit' });
        if (result.status !== 0) process.exitCode = 1;
      }
    }
  }
}
