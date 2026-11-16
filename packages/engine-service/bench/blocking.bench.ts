/**
 * Phase 1C.0 diagnosis: WHAT blocks the event loop while the engine runs on a large template?
 *
 * Same setup as responsiveness.bench.ts (EngineService, durable simulated canvas, abundant energy,
 * no write latency). In the same process:
 * - a 2 ms heartbeat records every event loop block longer than BLOCK_MS (start, end);
 * - the V8 CPU profiler (inspector, 250 µs sampling) attributes the samples of each block to a
 *   phase, by walking the stack from the leaf to the first known function;
 * - a PerformanceObserver records the garbage collections (kind, duration);
 * - memory (heap, array buffers) is sampled every 50 ms;
 * - per cycle (onCycle): wall time, time blocked, time waiting (wall - blocked).
 * Prints, per block size class, the phases that fill the blocks, the kind of cycle (rebuild,
 * verification, plain incremental) and the GC time inside, plus the worst blocks one by one.
 *
 * usage: node --expose-gc --import tsx bench/blocking.bench.ts [side] [seconds] [full|incremental]
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService } from '../src/index.js';

const SIDE = Number(process.argv[2] ?? 4096);
const SECONDS = Number(process.argv[3] ?? 30);
const MODE = (process.argv[4] ?? 'incremental') as 'full' | 'incremental';
const BLOCK_MS = 50;
const round = (t: number) => Math.round(t * 10) / 10;

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** Phase of a stack frame, or null: the first match from the leaf up wins. */
function phaseOf(frame: ProfileNode['callFrame']): string | null {
  const f = frame.functionName;
  const u = frame.url.replace(/\\/g, '/');
  if (f === '(garbage collector)') return 'gc';
  if (f === '(idle)' || f === '(program)') return null;
  if (u.includes('/progress/incremental')) {
    if (f === 'rebuild') return 'progress: rebuild (state)';
    if (f === 'update' || f === 'readEligible') return 'progress: incremental update';
    if (f === 'sameResult') return 'progress: verification compare';
    return null;
  }
  // classify.ts is shared (full computation, incremental update, planner): attributed to its caller.
  if (u.includes('/progress/classify')) return null;
  if (u.includes('/progress/progress')) return 'progress: full computation';
  if (u.includes('/progress/eta')) return 'eta';
  if (u.includes('/work/') || u.includes('/strategy/')) return 'planner';
  if (u.includes('/attempts/') || u.includes('/journal')) return 'attempts and journal';
  if (u.includes('simulator/') && (f.includes('readRegion') || f.includes('snapshot') || f.includes('Snapshot') || f === 'copyRegion')) return 'canvas read (simulator)';
  if (u.includes('world-store')) return 'world store';
  if (u.includes('simulator/')) return 'simulator (other)';
  if (u.includes('/events') || f === 'status' || f === 'publish' || f === 'flush') return 'events and status';
  if (u.includes('/scheduler/')) return 'scheduler (own)';
  if (u.includes('engine-service/src/service')) return 'service (own)';
  return null;
}

const dir = await mkdtemp(path.join(tmpdir(), 'gp-block-'));
const out: Record<string, unknown> = { side: SIDE, seconds: SECONDS, mode: MODE, node: process.version };
let service: EngineService | null = null;
const cycleAt: number[] = [];
const session = new Session();
session.connect();
try {
  service = await EngineService.open({ dataDir: dir, progressMode: MODE, onCycle: () => cycleAt.push(performance.now()) });
  const side = SIDE > 2048 ? 4096 : 2048;
  await service.configure({
    simulator: { width: side, height: side, costPerPixel: 1, capacity: 1_000_000, regenIntervalMs: 3_600_000, writeLatencyMs: 0 },
    agent: { startEnergy: 1_000_000, startCurrency: 0 },
    run: { maxBatchSize: 1000, minBatchSize: 1 },
    resetWorld: true,
  });
  const rgba = new Uint8Array(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const c = DEMO_COLORS[((x >> 5) + (y >> 5)) % 16]!;
      rgba.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 255], (y * SIDE + x) * 4);
    }
  }
  const png = await pngjsCodec.encode({ width: SIDE, height: SIDE, rgba });
  const tpl = await service.importTemplate({ name: 'Banc', png, x: 0, y: 0, strategy: 'top-to-bottom' });
  await service.selectTemplate(tpl.templateId);
  (globalThis as { gc?: () => void }).gc?.();

  // Instruments.
  const blocks: { start: number; end: number }[] = [];
  let last = performance.now();
  let beating = true;
  const beat = () => {
    const now = performance.now();
    if (now - last > BLOCK_MS) blocks.push({ start: last, end: now });
    last = now;
    if (beating) setTimeout(beat, 2);
  };
  const gcs: { start: number; duration: number; kind: number }[] = [];
  const gcObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push({ start: e.startTime, duration: e.duration, kind: ((e as unknown as { detail?: { kind?: number } }).detail?.kind) ?? 0 });
  });
  gcObserver.observe({ entryTypes: ['gc'] });
  let peakHeap = 0;
  let peakBuffers = 0;
  const memTimer = setInterval(() => {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
  }, 50);
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 250 });
  await session.post('Profiler.start');
  const profileT0 = performance.now();
  setTimeout(beat, 2);

  const started = performance.now();
  await service.start();
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until && service.status().state !== 'completed') await new Promise((r) => setTimeout(r, 100));
  if (service.status().commands.pause) await service.pause();
  const elapsed = performance.now() - started;
  beating = false;
  const { profile } = (await session.post('Profiler.stop')) as { profile: CpuProfile };
  gcObserver.disconnect();
  clearInterval(memTimer);

  // Sample times on the performance.now() axis (the profile starts when Profiler.start answered).
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const phaseCache = new Map<number, string>();
  const phaseOfNode = (id: number): string => {
    const cached = phaseCache.get(id);
    if (cached !== undefined) return cached;
    let cur: number | undefined = id;
    let found = 'other (node, libraries)';
    while (cur !== undefined) {
      const p = phaseOf(byId.get(cur)!.callFrame);
      if (p !== null) {
        found = p;
        break;
      }
      cur = parent.get(cur);
    }
    const leaf = byId.get(id)!.callFrame.functionName;
    if (leaf === '(idle)' || leaf === '(program)') found = leaf;
    phaseCache.set(id, found);
    return found;
  };
  const samples: { t: number; phase: string; dt: number }[] = [];
  let t = profileT0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i]! / 1000;
    t += dt;
    samples.push({ t, phase: phaseOfNode(profile.samples[i]!), dt: (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]!) / 1000 });
  }

  // Phases inside each block, GC inside each block, kind of cycle.
  const classOf = (ms: number) => (ms >= 1000 ? '>= 1000 ms' : ms >= 300 ? '300-999 ms' : ms >= 100 ? '100-299 ms' : '50-99 ms');
  const perClass = new Map<string, { count: number; ms: number; phases: Map<string, number>; gcMs: number; kinds: Map<string, number> }>();
  const detailed: unknown[] = [];
  let si = 0;
  for (const b of blocks) {
    const phases = new Map<string, number>();
    while (si < samples.length && samples[si]!.t < b.start) si++;
    let j = si;
    while (j < samples.length && samples[j]!.t <= b.end) {
      const s = samples[j]!;
      phases.set(s.phase, (phases.get(s.phase) ?? 0) + s.dt);
      j++;
    }
    const gcMs = gcs.filter((g) => g.start >= b.start && g.start <= b.end).reduce((a, g) => a + g.duration, 0);
    const kind = phases.has('progress: rebuild (state)') ? 'rebuild' : phases.has('progress: full computation') ? (MODE === 'full' ? 'full mode' : 'verification') : 'plain';
    const dur = b.end - b.start;
    const cls = classOf(dur);
    const c = perClass.get(cls) ?? { count: 0, ms: 0, phases: new Map(), gcMs: 0, kinds: new Map() };
    c.count++;
    c.ms += dur;
    c.gcMs += gcMs;
    c.kinds.set(kind, (c.kinds.get(kind) ?? 0) + 1);
    for (const [p, v] of phases) c.phases.set(p, (c.phases.get(p) ?? 0) + v);
    perClass.set(cls, c);
    detailed.push({ ms: round(dur), kind, gcMs: round(gcMs), phases: Object.fromEntries([...phases].sort((a, b) => b[1] - a[1]).map(([p, v]) => [p, round(v)])) });
  }
  const pct = (m: Map<string, number>, total: number) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).map(([p, v]) => [p, `${round(v)} ms (${Math.round((v / total) * 100)} %)`]));
  out.blocks = Object.fromEntries(
    [...perClass].map(([cls, c]) => [cls, { count: c.count, totalMs: round(c.ms), gcMs: round(c.gcMs), kinds: Object.fromEntries(c.kinds), phases: pct(c.phases, c.ms) }])
  );
  out.worstBlocks = (detailed as { ms: number }[]).sort((a, b) => b.ms - a.ms).slice(0, 6);
  // Whole run: CPU per phase (idle excluded).
  const total = new Map<string, number>();
  for (const s of samples) if (s.phase !== '(idle)') total.set(s.phase, (total.get(s.phase) ?? 0) + s.dt);
  const busy = [...total.values()].reduce((a, b) => a + b, 0);
  out.cpuWholeRun = { busyMs: round(busy), elapsedMs: round(elapsed), phases: pct(total, busy) };
  // Self time per function (top 20), with its phase.
  const self = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]!)!;
    const f = n.callFrame.functionName;
    if (f === '(idle)') continue;
    const key = `${f || '(anonymous)'} ${n.callFrame.url.replace(/\\/g, '/').split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1} [${phaseOfNode(n.id)}]`;
    self.set(key, (self.get(key) ?? 0) + samples[i]!.dt);
  }
  out.topSelf = Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => [k, round(v)]));
  // Cycles: wall, blocked (sum of blocks inside), waiting.
  const cycles = cycleAt.slice(1).map((end, i) => {
    const start = cycleAt[i]!;
    const blocked = blocks.reduce((a, b) => a + Math.max(0, Math.min(b.end, end) - Math.max(b.start, start)), 0);
    return { wall: end - start, blocked };
  });
  const q = (v: number[], p: number) => (v.length === 0 ? null : round([...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))]!));
  out.cycles = {
    count: cycles.length,
    wallMs: { median: q(cycles.map((c) => c.wall), 0.5), p95: q(cycles.map((c) => c.wall), 0.95), max: q(cycles.map((c) => c.wall), 1) },
    blockedShare: round((cycles.reduce((a, c) => a + c.blocked, 0) / Math.max(1, cycles.reduce((a, c) => a + c.wall, 0))) * 100) + ' %',
  };
  const gcKinds: Record<number, string> = { 1: 'minor (scavenge)', 2: 'major (mark-compact)', 4: 'incremental', 8: 'weak callbacks' };
  const gcBy = new Map<string, { count: number; ms: number; maxMs: number }>();
  for (const g of gcs) {
    const k = gcKinds[g.kind] ?? `kind ${g.kind}`;
    const e = gcBy.get(k) ?? { count: 0, ms: 0, maxMs: 0 };
    e.count++;
    e.ms += g.duration;
    e.maxMs = Math.max(e.maxMs, g.duration);
    gcBy.set(k, e);
  }
  out.gc = Object.fromEntries([...gcBy].map(([k, e]) => [k, { count: e.count, totalMs: round(e.ms), maxMs: round(e.maxMs) }]));
  out.memoryPeakMiB = { heapUsed: Math.round(peakHeap / 1048576), arrayBuffers: Math.round(peakBuffers / 1048576), rss: Math.round(process.memoryUsage().rss / 1048576) };
  out.applied = service.status().scheduler?.applied;
  console.log(JSON.stringify(out, null, 2));
} finally {
  session.disconnect();
  await service?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
