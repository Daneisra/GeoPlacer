/**
 * Phase 1B.6 benchmark: WorkPlanner on 1000², 2000² and 4096².
 *
 *   npm run bench:planner                         -> every scenario, one process per size
 *   node --expose-gc --import tsx planner.bench.ts <size>
 *
 * Image: pixel art, 32 colors, ~3 % transparent. For each strategy:
 * - prepareMs: order keys built once per revision (random: PCG32 order and
 *   its rank table, generated; then read back from an in-memory cache with
 *   a real SHA-256 check);
 * - firstBatchMs: nextBatch of 1,000 pixels on an empty canvas (everything
 *   to do), i.e. the time to the first batch once the template is prepared;
 * - nearDoneMs: the same on a canvas 99.9 % correct (0.1 % scattered wrong);
 * - unknown50Ms / unknown50IncludeMs: half of the rows not observed, with
 *   the 'skip' and 'include' policies.
 * Reported: median of 5 runs after one warm-up; extra memory = peak of JS
 * heap + ArrayBuffers above the baseline during nextBatch (image, snapshot
 * and prepared keys excluded), keyBytes = memory held by the keys.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentId, CanvasSnapshot, Hasher, OrderCacheKey, OrderCacheStore, PlanRequest, PreparedTemplate, ProjectId, ResourceRules, Rgb, StrategyConfig, Template, TemplateId, TemplateImage } from '../src/index.js';
import { DRAWING_STRATEGIES, TRANSPARENT, TRANSPARENT_U32, UNKNOWN, createArraySnapshot, nextBatch, prepareTemplate, prepareTemplateSync, stateFromObservation } from '../src/index.js';

const COLORS = Array.from({ length: 32 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);

function makeImage(size: number): TemplateImage {
  const pixels = new Uint32Array(size * size);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
      pixels[iy * size + ix] = block === 32 ? TRANSPARENT_U32 : COLORS[block]!;
    }
  }
  return { width: size, height: size, pixels };
}

function template(image: TemplateImage, strategy: StrategyConfig): Template {
  return {
    id: 'bench' as TemplateId,
    projectId: 'projet' as ProjectId,
    name: 'bench',
    revision: 1,
    image,
    placement: { topLeft: { x: 0, y: 0 } },
    coordinateSystem: { yAxis: 'down' },
    palette: { id: 'p', colors: COLORS.map((rgb) => ({ rgb: rgb as Rgb })) },
    alphaThreshold: 128,
    quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
    priority: 0,
    status: 'active',
    strategy,
    sourceImageHash: 'a'.repeat(64),
    quantizedImageHash: 'b'.repeat(64),
    createdAt: 0,
    updatedAt: 0,
    warnings: [],
  };
}

/** wrongEvery: 1 = everything to do (empty canvas), n = one pixel in n wrong; observedRows: rows after are UNKNOWN. */
function snapshot(image: TemplateImage, wrongEvery: number, observedRows: number): CanvasSnapshot {
  const { width, pixels } = image;
  const out = new Int32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    if (Math.floor(i / width) >= observedRows) out[i] = UNKNOWN;
    else if (p === TRANSPARENT_U32) out[i] = TRANSPARENT;
    else out[i] = wrongEvery === 1 || (i * 2654435761) % wrongEvery === 0 ? TRANSPARENT : p;
  }
  return createArraySnapshot({ rect: { minX: 0, minY: 0, width, height: image.height }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: 0, pixels: out });
}

// SYNTHETIC rules (benchmark only, not a real service): energy for a 1,000-pixel batch.
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'bench-simulated',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 10_000, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: COLORS as Rgb[], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [] },
  currency: {},
};
const agent = 'agent-1' as AgentId;
const resources = stateFromObservation(rules, { type: 'resource-observation', agent, observedAt: 0, energy: 10_000, currency: 0, unlockedColors: COLORS as Rgb[], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });

function request(s: CanvasSnapshot, unknownPixels: 'skip' | 'include'): PlanRequest {
  return { agent, snapshot: s, resources, rules, maxBatch: 1000, inFlight: new Set(), committedEnergy: 0, unknownPixels, freshness: { simulated: { maxAgeMs: 60_000 } }, maxResourceAgeMs: 60_000, now: 0 };
}

const gc = (globalThis as { gc?: () => void }).gc;
const used = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function time(fn: () => void): { ms: number; extraKb: number } {
  fn(); // warm-up
  const times: number[] = [];
  let peak = 0;
  for (let k = 0; k < 5; k++) {
    gc?.();
    const base = used();
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
    peak = Math.max(peak, used() - base);
  }
  return { ms: +median(times).toFixed(1), extraKb: Math.round(Math.max(0, peak) / 1024) };
}

const hasher: Hasher = { sha256Hex: async (bytes) => createHash('sha256').update(bytes).digest('hex') };

async function run(size: number): Promise<void> {
  const image = makeImage(size);
  const empty = snapshot(image, 1, size);
  const nearDone = snapshot(image, 1000, size);
  const halfUnknown = snapshot(image, 1, size / 2);
  for (const id of Object.keys(DRAWING_STRATEGIES) as (keyof typeof DRAWING_STRATEGIES)[]) {
    const t = template(image, { id, ...(id === 'random' ? { seed: 7 } : {}) } as StrategyConfig);
    let prepared: PreparedTemplate = prepareTemplateSync(t);
    const prepare = time(() => void (prepared = prepareTemplateSync(t)));
    let cachedMs: number | null = null;
    if (id === 'random') {
      // A cache hit (in memory here, files in adapters-node): read + SHA-256 + permutation check.
      const entries = new Map<string, Uint8Array>();
      const store: OrderCacheStore = { read: async (k: OrderCacheKey) => entries.get(JSON.stringify(k)) ?? null, write: async (k, b) => void entries.set(JSON.stringify(k), b.slice()) };
      await prepareTemplate(t, { hasher, orderCache: store });
      const times: number[] = [];
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        const p = await prepareTemplate(t, { hasher, orderCache: store });
        times.push(performance.now() - t0);
        if (p.keySource !== 'cache') throw new Error(`expected a cache hit, got ${p.keySource}`);
      }
      cachedMs = +median(times).toFixed(1);
    }
    let writes = 0;
    const first = time(() => void (writes = nextBatch(prepared, request(empty, 'skip')).writes.length));
    if (writes !== 1000) throw new Error(`first batch of ${writes}`);
    const near = time(() => void nextBatch(prepared, request(nearDone, 'skip')));
    const unknownSkip = time(() => void nextBatch(prepared, request(halfUnknown, 'skip')));
    const unknownInclude = time(() => void nextBatch(prepared, request(halfUnknown, 'include')));
    console.log(
      JSON.stringify({
        size: `${size}x${size}`,
        strategy: id,
        prepareMs: prepare.ms,
        ...(cachedMs === null ? {} : { prepareFromCacheMs: cachedMs }),
        keyKb: Math.round(prepared.keyBytes / 1024),
        firstBatchMs: first.ms,
        firstBatchExtraKb: first.extraKb,
        firstBatchTotalMs: +(prepare.ms + first.ms).toFixed(1),
        nearDoneMs: near.ms,
        unknown50Ms: unknownSkip.ms,
        unknown50IncludeMs: unknownInclude.ms,
      }),
    );
  }
}

const [sizeArg] = process.argv.slice(2);
if (sizeArg !== undefined) await run(Number(sizeArg));
else {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}; median of 5 runs, one process per size`);
  const self = fileURLToPath(import.meta.url);
  for (const size of [1000, 2000, 4096]) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', self, String(size)], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
  }
}
