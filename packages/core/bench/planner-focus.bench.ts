/**
 * Phase 1B.7: targeted measure of nextBatch for color-by-color and
 * outline-first (the two strategies above 200 ms on a noisy 2000² image in
 * Phase 1B.6), with every other strategy as control.
 *
 *   node --expose-gc --import tsx packages/core/bench/planner-focus.bench.ts [size] [kind] [rounds]
 *   GEOPLACER_CORE_SRC=<path to another src/index.ts>   compare another version (A/B)
 *
 * Prepare (keys, once per revision) and nextBatch are measured apart:
 * median, p95 and max over `rounds` runs after a warm-up; allocations =
 * heap + ArrayBuffers above the baseline during one nextBatch (gc first).
 */

import { pathToFileURL } from 'node:url';
import type * as Core from '../src/index.js';

const source = process.env['GEOPLACER_CORE_SRC'];
const core = (await import(source === undefined ? '../src/index.js' : pathToFileURL(source).href)) as typeof Core;
const { TRANSPARENT, TRANSPARENT_U32, createArraySnapshot, nextBatch, prepareTemplateSync, stateFromObservation } = core;

const [sizeArg = '2000', kind = 'noise', roundsArg = '25'] = process.argv.slice(2);
const size = Number(sizeArg);
const rounds = Number(roundsArg);
const COLORS = Array.from({ length: 32 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);

function makeImage(): Core.TemplateImage {
  const pixels = new Uint32Array(size * size);
  let seed = 0x9e3779b9;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let value: number;
      if (kind === 'noise') {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const v = seed >>> 0;
        value = (v & 7) === 0 ? TRANSPARENT_U32 : COLORS[(v >>> 3) & 31]!;
      } else {
        const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
        value = block === 32 ? TRANSPARENT_U32 : COLORS[block]!;
      }
      pixels[iy * size + ix] = value;
    }
  }
  return { width: size, height: size, pixels };
}

const image = makeImage();
const out = new Int32Array(image.pixels.length).fill(TRANSPARENT);
const snapshot = createArraySnapshot({ rect: { minX: 0, minY: 0, width: size, height: size }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: 0, pixels: out });
// SYNTHETIC rules (benchmark only).
const rules: Core.ResourceRules = { schemaVersion: 1, id: 'bench', version: 1, energy: { costPerPixel: 1, baseCapacity: 10_000, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' }, palette: { initialColors: COLORS as Core.Rgb[], unlockable: [] }, upgrades: { maxEnergy: [], regenSpeed: [] }, currency: {} };
const agent = 'agent-1' as Core.AgentId;
const resources = stateFromObservation(rules, { type: 'resource-observation', agent, observedAt: 0, energy: 10_000, currency: 0, unlockedColors: COLORS as Core.Rgb[], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
const request: Core.PlanRequest = { agent, snapshot, resources, rules, maxBatch: 1000, inFlight: new Set(), committedEnergy: 0, unknownPixels: 'skip', freshness: { simulated: { maxAgeMs: 60_000 } }, maxResourceAgeMs: 60_000, now: 0 };

const gc = (globalThis as { gc?: () => void }).gc;
const used = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const stats = (v: number[]): { median: number; p95: number; max: number } => {
  const s = [...v].sort((a, b) => a - b);
  return { median: +s[s.length >> 1]!.toFixed(1), p95: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!.toFixed(1), max: +s.at(-1)!.toFixed(1) };
};

const template = (id: Core.DrawingStrategyId): Core.Template => ({
  id: 'bench' as Core.TemplateId,
  projectId: 'p' as Core.ProjectId,
  name: 'bench',
  revision: 1,
  image,
  placement: { topLeft: { x: 0, y: 0 } },
  coordinateSystem: { yAxis: 'down' },
  palette: { id: 'p', colors: COLORS.map((rgb) => ({ rgb: rgb as Core.Rgb })) },
  alphaThreshold: 128,
  quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
  priority: 0,
  status: 'active',
  strategy: { id, ...(id === 'random' ? { seed: 7 } : {}) } as Core.StrategyConfig,
  sourceImageHash: 'a'.repeat(64),
  quantizedImageHash: 'b'.repeat(64),
  createdAt: 0,
  updatedAt: 0,
  warnings: [],
});

// ───── Phase 1B.6 keys of the two strategies (reference, unchanged), for an in-process A/B ─────
function previousKey(id: Core.DrawingStrategyId): ((i: number) => number) | null {
  const { width: W, height: H, pixels } = image;
  const N = W * H;
  if (id === 'outline-first') {
    return (i) => {
      const iy = Math.floor(i / W);
      const ix = i - iy * W;
      const p = pixels[i];
      const outline = ix === 0 || iy === 0 || ix === W - 1 || iy === H - 1 || pixels[i - 1] !== p || pixels[i + 1] !== p || pixels[i - W] !== p || pixels[i + W] !== p;
      return (outline ? 0 : N) + i;
    };
  }
  if (id === 'color-by-color') {
    const { colors } = core.colorRanking(image, { id });
    const rankOf = new Map<number, number>(colors.map((c, r) => [c, r]));
    let lastColor = TRANSPARENT_U32;
    let lastRank = 0;
    return (i) => {
      const c = pixels[i]!;
      if (c !== lastColor) {
        lastColor = c;
        lastRank = rankOf.get(c) ?? 0;
      }
      return lastRank * N + i;
    };
  }
  return null;
}

if (process.env['GEOPLACER_AB'] === '1') {
  // A (1B.6 keys) and B (current keys) alternate in the same process, same nextBatch.
  for (const id of ['color-by-color', 'outline-first'] as Core.DrawingStrategyId[]) {
    const current = prepareTemplateSync(template(id));
    const keys = (current as unknown as { keys: { strategy: string; version: number; bytes: number } }).keys;
    const previous = { ...current, keys: { ...keys, key: previousKey(id)! } } as unknown as Core.PreparedTemplate;
    const a = nextBatch(previous, request).writes.map((w) => w.taskId).join();
    const b = nextBatch(current, request).writes.map((w) => w.taskId).join();
    if (a !== b) throw new Error(`${id}: different batches`);
    const ta: number[] = [];
    const tb: number[] = [];
    for (let r = 0; r < rounds; r++) {
      for (const [prepared, sink] of (r % 2 === 0 ? [[previous, ta], [current, tb]] : [[current, tb], [previous, ta]]) as [Core.PreparedTemplate, number[]][]) {
        const s = performance.now();
        nextBatch(prepared, request);
        sink.push(performance.now() - s);
      }
    }
    console.log(JSON.stringify({ size, kind, strategy: id, ab: true, previous: stats(ta), current: stats(tb), sameBatch: true }));
  }
  process.exit(0);
}

for (const id of ['color-by-color', 'outline-first', 'top-to-bottom', 'center-out'] as Core.DrawingStrategyId[]) {
  const t = template(id);
  const prepareTimes: number[] = [];
  let prepared = prepareTemplateSync(t);
  for (let r = 0; r < Math.min(rounds, 10); r++) {
    const s = performance.now();
    prepared = prepareTemplateSync(t);
    prepareTimes.push(performance.now() - s);
  }
  nextBatch(prepared, request); // warm-up
  const times: number[] = [];
  let writes: readonly Core.PixelWrite[] = [];
  for (let r = 0; r < rounds; r++) {
    const s = performance.now();
    writes = nextBatch(prepared, request).writes;
    times.push(performance.now() - s);
  }
  gc?.();
  const base = used();
  nextBatch(prepared, request);
  const alloc = Math.max(0, used() - base);
  console.log(
    JSON.stringify({
      size,
      kind,
      strategy: id,
      prepare: stats(prepareTimes),
      nextBatch: stats(times),
      allocKb: Math.round(alloc / 1024),
      keyKb: Math.round(prepared.keyBytes / 1024),
      firstWrites: writes.slice(0, 3).map((w) => `${w.point.x},${w.point.y}`).join(' '),
    }),
  );
}
