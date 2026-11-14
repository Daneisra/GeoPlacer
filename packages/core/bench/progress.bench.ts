/**
 * Phase 1B.4 benchmark: ProgressCalculator on 1000², 2000² and 4096².
 *
 *   npm run bench:progress                         -> every scenario, one process per size
 *   node --expose-gc --import tsx progress.bench.ts <size>
 *
 * Canvas: an in-memory array snapshot where half of the eligible pixels are
 * correct and the rest alternate wrong color / empty. Unknown share: the
 * snapshot covers all rows (0 %), the top half (50 %), or none of them
 * (100 %). Per-color cost: noise images with 1, 32 and 256 colors.
 * Reported: median of 5 runs after one warm-up; extra memory = peak of JS
 * heap + ArrayBuffers above the baseline (image and snapshot excluded).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentId, CanvasSnapshot, ProgressTemplate, ResourceRules, Rgb, TemplateId, TemplateImage } from '../src/index.js';
import { TRANSPARENT, TRANSPARENT_U32, UNKNOWN, computeProgress, createArraySnapshot, estimateEta, stateFromObservation } from '../src/index.js';

type Kind = 'uniform' | 'pixel-art' | 'noise';

function palette(colors: number): number[] {
  return Array.from({ length: colors }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);
}

function makeImage(size: number, kind: Kind, colors: number): TemplateImage {
  const p = palette(colors);
  const pixels = new Uint32Array(size * size);
  let seed = 0x9e3779b9;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let value: number;
      if (kind === 'uniform') value = p[0] ?? 0;
      else if (kind === 'noise') {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const v = seed >>> 0;
        value = (v & 7) === 0 ? TRANSPARENT_U32 : (p[(v >>> 3) % colors] ?? 0);
      } else {
        const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
        value = block === 32 ? TRANSPARENT_U32 : (p[block % colors] ?? 0);
      }
      pixels[iy * size + ix] = value;
    }
  }
  return { width: size, height: size, pixels };
}

/** Half correct, then alternately wrong / empty; rows from `observedRows` on are not observed. */
function makeSnapshot(image: TemplateImage, observedRows: number): CanvasSnapshot {
  const { width, height, pixels } = image;
  const out = new Int32Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    const row = Math.floor(i / width);
    if (row >= observedRows) out[i] = UNKNOWN;
    else if (p === TRANSPARENT_U32) out[i] = TRANSPARENT;
    else out[i] = i % 2 === 0 ? p : i % 4 === 1 ? (p ^ 0x010101) & 0xffffff : TRANSPARENT;
  }
  return createArraySnapshot({ rect: { minX: 0, minY: 0, width, height }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: 0, pixels: out });
}

const gc = (globalThis as { gc?: () => void }).gc;
const used = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function run(size: number, kind: Kind, colors: number, unknownShare: 0 | 50 | 100): void {
  const image = makeImage(size, kind, colors);
  const template: ProgressTemplate = { id: 'bench' as TemplateId, revision: 1, image, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } };
  const snapshot = makeSnapshot(image, Math.round((size * (100 - unknownShare)) / 100));
  computeProgress(template, snapshot, 1); // warm-up
  const times: number[] = [];
  let peak = 0;
  let result = computeProgress(template, snapshot, 1);
  for (let k = 0; k < 5; k++) {
    gc?.();
    const base = used();
    const t = performance.now();
    result = computeProgress(template, snapshot, 1);
    times.push(performance.now() - t);
    peak = Math.max(peak, used() - base);
  }
  console.log(
    JSON.stringify({
      size: `${size}x${size}`,
      kind,
      colors,
      unknownShare,
      eligible: result.total,
      unknown: result.unknown,
      ms: Math.round(median(times)),
      nsPerEligiblePixel: result.total === 0 ? null : +((median(times) * 1e6) / result.total).toFixed(1),
      extraKb: Math.round(Math.max(0, peak) / 1024),
    })
  );
}

/** ETA on the progress of a 32-color noise image: 3 agents with different palettes and resources, one pause. */
function eta(size: number): void {
  const image = makeImage(size, 'noise', 32);
  const template: ProgressTemplate = { id: 'bench' as TemplateId, revision: 1, image, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } };
  const progress = computeProgress(template, makeSnapshot(image, size), 1);
  const colors = palette(32) as Rgb[];
  // SYNTHETIC rules for the benchmark (not a real service): agents differ by upgrade levels and palettes.
  const rules: ResourceRules = {
    schemaVersion: 1,
    id: 'bench-simulated',
    version: 1,
    energy: { costPerPixel: 1, baseCapacity: 100, regenAmount: 1, regenIntervalMs: 30_000, aboveCapacity: 'keep' },
    palette: { initialColors: colors, unlockable: [] },
    upgrades: { maxEnergy: [{ cost: 0, capacityBonus: 50 }, { cost: 0, capacityBonus: 50 }], regenSpeed: [{ cost: 0, regenIntervalMs: 25_000 }, { cost: 0, regenIntervalMs: 20_000 }] },
    currency: {},
  };
  const agents = [0, 1, 2].map((k) => ({
    id: `agent-${k}` as AgentId,
    state: stateFromObservation(rules, {
      type: 'resource-observation',
      agent: `agent-${k}` as AgentId,
      observedAt: 0,
      energy: 10 * k,
      currency: 0,
      unlockedColors: colors.filter((_, i) => i % (k + 1) === 0),
      upgrades: { maxEnergy: k, regenSpeed: k, energyPacks: 0 },
      availability: { status: 'available' },
    }),
  }));
  const parameters = { rules, msPerPixel: 500, minCoveragePercent: 90, pauses: [{ start: 3_600_000, end: 7_200_000 }] };
  estimateEta(progress, agents, parameters, 1);
  const times: number[] = [];
  let result = estimateEta(progress, agents, parameters, 1);
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    result = estimateEta(progress, agents, parameters, 1);
    times.push(performance.now() - t);
  }
  console.log(JSON.stringify({ size: `${size}x${size}`, eta: true, workPixels: result.workPixels, durationMs: result.durationMs, computeMs: +median(times).toFixed(2) }));
}

const [sizeArg] = process.argv.slice(2);
if (sizeArg !== undefined) {
  const size = Number(sizeArg);
  for (const kind of ['uniform', 'pixel-art', 'noise'] as const) run(size, kind, 32, 0);
  for (const unknownShare of [50, 100] as const) run(size, 'pixel-art', 32, unknownShare);
  for (const colors of [1, 256]) run(size, 'noise', colors, 0);
  eta(size);
} else {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}; median of 5 runs, one process per size`);
  const self = fileURLToPath(import.meta.url);
  for (const size of [1000, 2000, 4096]) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', self, String(size)], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
  }
}
