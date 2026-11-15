/**
 * Phase 1B.8, scenario B: the single-agent scheduler on a 2000 x 2000
 * template (local simulated canvas, virtual clock).
 *
 *   npm run bench:scheduler
 *
 * The 4 million pixels cannot be painted within a benchmark: a fixed number
 * of cycles is measured.
 * - B1, ample energy, batches of 1 000: time to the first batch (recovery,
 *   preparation, canvas read, progress, plan, lease, write, close), real
 *   time per cycle (median, p95, max), canvas read and progress computation
 *   alone, memory;
 * - B2, limited energy (1 000, 1 per second): virtual waiting time per
 *   batch and number of sleeps (no busy loop).
 * The resource rules are synthetic.
 */

import type { AgentId, ProjectId, ResourceRules, Rgb, Template, TemplateId } from '@geoplacer/core';
import { TRANSPARENT_U32, computeProgress, createAttemptManager, createMemoryHistory, createMemoryJournal, createResourceManager, createScheduler } from '@geoplacer/core';
import { SimulatedCanvasProvider, createManualClock } from '../src/index.js';

const SIZE = 2000;
const COLORS = Array.from({ length: 8 }, (_, i) => (((i * 97) % 256) << 16) | (((i * 53 + 40) % 256) << 8) | ((i * 29 + 90) % 256)) as Rgb[];
const agent = 'agent-1' as AgentId;
const stats = (v: number[]): { median: number; p95: number; max: number } => {
  const s = [...v].sort((a, b) => a - b);
  return { median: +s[s.length >> 1]!.toFixed(1), p95: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!.toFixed(1), max: +s.at(-1)!.toFixed(1) };
};
const mib = (n: number): number => +(n / 1048576).toFixed(1);

function rules(capacity: number, regenIntervalMs: number): ResourceRules {
  return {
    schemaVersion: 1,
    id: 'bench-scheduler',
    version: 1,
    energy: { costPerPixel: 1, baseCapacity: capacity, capacityLimit: capacity, regenAmount: 1, regenIntervalMs, aboveCapacity: 'keep' },
    palette: { initialColors: COLORS, unlockable: [] },
    upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
    currency: { maxSpendPerOperation: 1 },
  };
}

function template(): Template {
  const pixels = new Uint32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const block = ((x >> 4) * 31 + (y >> 4) * 17) % 9;
      pixels[y * SIZE + x] = block === 8 ? TRANSPARENT_U32 : COLORS[block]!;
    }
  }
  return {
    id: 'grand' as TemplateId,
    projectId: 'bench' as ProjectId,
    name: 'grand',
    revision: 1,
    image: { width: SIZE, height: SIZE, pixels },
    placement: { topLeft: { x: 0, y: 0 } },
    coordinateSystem: { yAxis: 'down' },
    palette: { id: 'p', colors: COLORS.map((rgb) => ({ rgb })) },
    alphaThreshold: 128,
    quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
    priority: 0,
    status: 'active',
    strategy: { id: 'top-to-bottom' },
    sourceImageHash: 'a'.repeat(64),
    quantizedImageHash: 'b'.repeat(64),
    createdAt: 0,
    updatedAt: 0,
    warnings: [],
  };
}

async function run(name: string, capacity: number, regenIntervalMs: number, minBatch: number, cycles: number): Promise<void> {
  const tpl = template();
  const sleeps: number[] = [];
  const clock = createManualClock(1_000_000);
  const sleep = clock.sleep.bind(clock);
  Object.assign(clock, {
    sleep: async (ms: number, signal?: Parameters<typeof sleep>[1]) => {
      sleeps.push(ms);
      return sleep(ms, signal);
    },
  });
  const r = rules(capacity, regenIntervalMs);
  const canvas = new SimulatedCanvasProvider({ bounds: { minX: 0, minY: 0, width: SIZE, height: SIZE }, coordinateSystem: { yAxis: 'down' }, rules: r, clock, writeLatencyMs: 50 });
  canvas.addAgent({ agent, energy: capacity, unlockedColors: COLORS });
  // Time spent reading the canvas, measured around the provider.
  const readTimes: number[] = [];
  const read = canvas.reader.readRegion.bind(canvas.reader);
  (canvas.reader as { readRegion: typeof read }).readRegion = async (rect, signal) => {
    const t = performance.now();
    const snap = await read(rect, signal);
    readTimes.push(performance.now() - t);
    return snap;
  };
  const resources = createResourceManager(r);
  let ids = 0;
  const attempts = createAttemptManager({ journal: createMemoryJournal(), history: createMemoryHistory(), resources, newAttemptId: () => `a-${++ids}` as never, autoCompaction: { enabled: true, maxActiveEvents: 2_000 } });
  const scheduler = createScheduler(
    { projectId: tpl.projectId, templateId: tpl.id, agents: [agent], maxActiveAgents: 1, maxBatchSize: 1000, minBatchSize: minBatch, leaseTtlMs: 600_000, unknownPixels: 'skip', freshness: { simulated: { maxAgeMs: 3_600_000 } }, maxResourceAgeMs: 3_600_000, eta: { msPerPixel: 0, minCoveragePercent: 90 }, reconcileRetryMs: 1_000, maxWaitMs: 3_600_000, maxRecentErrors: 20, maxCycles: null },
    { clock, canvas, templates: { current: async () => tpl }, resourceSource: canvas.resourceSource(), resources, attempts },
  );
  (globalThis as { gc?: () => void }).gc?.();
  const baseRss = process.memoryUsage().rss;
  const cycleTimes: number[] = [];
  let firstBatchMs: number | null = null;
  const t0 = performance.now();
  const v0 = clock.now();
  for (let k = 0; k < cycles; k++) {
    const t = performance.now();
    const status = await scheduler.step();
    cycleTimes.push(performance.now() - t);
    if (firstBatchMs === null && status.attemptsClosed > 0) firstBatchMs = performance.now() - t0;
  }
  const status = scheduler.status();
  // Progress alone, on a read of the template area.
  const snapshot = await read({ minX: 0, minY: 0, width: SIZE, height: SIZE });
  const progressTimes: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    computeProgress(tpl, snapshot, clock.now());
    progressTimes.push(performance.now() - t);
  }
  const waits = sleeps.filter((ms) => ms >= 1_000);
  console.log(
    JSON.stringify({
      scenario: name,
      cycles,
      firstBatchMs: firstBatchMs === null ? null : Math.round(firstBatchMs),
      cycleMs: stats(cycleTimes.slice(1)),
      canvasReadMs: stats(readTimes),
      progressMs: stats(progressTimes),
      applied: status.applied,
      pixelsPerRealSecond: Math.round(status.applied / ((performance.now() - t0) / 1000)),
      virtualSeconds: Math.round((clock.now() - v0) / 1000),
      waits: waits.length,
      virtualWaitPerBatchS: status.attemptsClosed === 0 ? null : Math.round(waits.reduce((a, b) => a + b, 0) / 1000 / Math.max(1, status.attemptsClosed)),
      state: status.state,
      rssDeltaMib: mib(process.memoryUsage().rss - baseRss),
      peakRssMib: mib(process.resourceUsage().maxRSS * 1024),
      compactions: attempts.compactionStatus().automatic,
    }),
  );
}

console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
await run('B1 ample energy (batches of 1 000)', 1_000_000, 1_000, 1, 15);
await run('B2 limited energy (1 000, 1 per second)', 1_000, 1_000, 1_000, 10);
