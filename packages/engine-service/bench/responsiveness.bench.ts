/**
 * Phase 1B.9 bench: is the server still responsive while the engine works on
 * a large template? Measured BEFORE any optimisation.
 *
 * EngineService on a 2048 x 2048 durable simulated canvas, a template of
 * SIDE x SIDE pixels (default 2000), abundant energy, no write latency:
 * - opening (world created: 16 MiB checkpoint), template import;
 * - first batch; pixels per second; cycles;
 * - event loop delay during the run (what an HTTP request or a WebSocket
 *   message waits for): p50, p99, max;
 * - latency of status(), of a pause (waits for the operation in progress),
 *   of a canvas read of the template area;
 * - events emitted per second and canvas bytes;
 * - world checkpoint time, peak RSS.
 * Phase 1B.10: progress mode (full | incremental), cycle median and p95,
 * real HTTP latency (a local server answering the status during the run),
 * largest gap between two status events (WebSocket fluidity).
 * Phase 1C.0: event loop blocks measured by a 2 ms heartbeat (max block at startup, i.e. during the
 * first cycle, and in the steady state after it), cycle p99, first cycle duration, optional external
 * edits (`edits`: 25 pixels erased every 2 s while the engine runs), machine load during the run
 * (all processors, from os.cpus) and this process's CPU share, so that runs on a busy machine are
 * recognisable.
 * Environment: BENCH_COOPERATIVE=0 runs the service without yields (the new code, not the old one);
 * BENCH_SLICE=<pixels> sets the slice size (default DEFAULT_SLICE_PIXELS). To compare with the code
 * before Phase 1C.0: `git worktree add --detach <dir> 6bee19c`, `npm ci --ignore-scripts` and
 * `npm run build:packages` there, copy this file into it, run both alternately on a calm machine.
 * usage: node --expose-gc --import tsx bench/responsiveness.bench.ts [side] [seconds] [full|incremental] [edits]
 */

import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService, type EngineEventEnvelope } from '../src/index.js';

const SIDE = Number(process.argv[2] ?? 2000);
const SECONDS = Number(process.argv[3] ?? 20);
const MODE = (process.argv[4] ?? 'full') as 'full' | 'incremental';
const EDITS = process.argv[5] === 'edits';
const machineTimes = () =>
  os.cpus().reduce(
    (a, c) => {
      const t = c.times;
      a.busy += t.user + t.nice + t.sys + t.irq;
      a.total += t.user + t.nice + t.sys + t.irq + t.idle;
      return a;
    },
    { busy: 0, total: 0 }
  );
const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
};
const ms = (t: number) => Math.round(t * 10) / 10;
let peakRss = 0;
const sampleRss = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
const rssTimer = setInterval(sampleRss, 100);

const dir = await mkdtemp(path.join(tmpdir(), 'gp-bench-'));
const out: Record<string, unknown> = { side: SIDE, seconds: SECONDS, mode: MODE, edits: EDITS, cooperative: process.env.BENCH_COOPERATIVE === '0' ? false : (process.env.BENCH_SLICE ?? 'default'), node: process.version };
const cycleAt: number[] = [];
let service: EngineService | null = null;
try {
  let t = performance.now();
  service = await EngineService.open({ dataDir: dir, progressMode: MODE, onCycle: () => cycleAt.push(performance.now()), ...(process.env.BENCH_COOPERATIVE === '0' ? { cooperative: false as const } : process.env.BENCH_SLICE !== undefined ? { cooperative: { slicePixels: Number(process.env.BENCH_SLICE) } } : {}) });
  const side = SIDE > 2048 ? 4096 : 2048;
  await service.configure({
    simulator: { width: side, height: side, costPerPixel: 1, capacity: 1_000_000, regenIntervalMs: 3_600_000, writeLatencyMs: 0 },
    agent: { startEnergy: 1_000_000, startCurrency: 0 },
    run: { maxBatchSize: 1000, minBatchSize: 1 },
    resetWorld: true,
  });
  out.openAndResetMs = ms(performance.now() - t);

  const rgba = new Uint8Array(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const c = DEMO_COLORS[((x >> 5) + (y >> 5)) % 16]!;
      rgba.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 255], (y * SIDE + x) * 4);
    }
  }
  const png = await pngjsCodec.encode({ width: SIDE, height: SIDE, rgba });
  t = performance.now();
  const tpl = await service.importTemplate({ name: 'Banc', png, x: 0, y: 0, strategy: 'top-to-bottom' });
  await service.selectTemplate(tpl.templateId);
  out.importAndSelectMs = ms(performance.now() - t);

  // A local HTTP server answering the engine status: the latency a dashboard request sees.
  const svc = service;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(svc.status()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  // Phase 1C.0: the client runs in a WORKER THREAD (its own event loop), like a browser in another
  // process: a request sent while the engine blocks the server's loop waits for the block to end.
  // Open loop: one request every 100 ms whatever the previous answers (at most 5 in flight).
  // Before 1C.0 the client shared the server's loop and only measured between blocks.
  const client = new Worker(
    `const http = require('node:http');
     const { parentPort, workerData } = require('node:worker_threads');
     const agent = new http.Agent({ keepAlive: true, maxSockets: 5 });
     const times = [];
     let inFlight = 0;
     const timer = setInterval(() => {
       if (inFlight >= 5) return;
       inFlight++;
       const t0 = performance.now();
       http.get({ host: '127.0.0.1', port: workerData.port, path: '/', agent }, (res) => {
         res.resume();
         res.on('end', () => { times.push(performance.now() - t0); inFlight--; });
       }).on('error', () => inFlight--);
     }, 100);
     parentPort.on('message', () => {
       clearInterval(timer);
       const wait = () => (inFlight === 0 ? (parentPort.postMessage(times), agent.destroy()) : setTimeout(wait, 20));
       wait();
     });`,
    { eval: true, workerData: { port } }
  );
  const httpLoop = new Promise<number[]>((resolve) => client.once('message', (times: number[]) => resolve(times)));
  let httpTimes: number[] = [];
  const statusEventAt: number[] = [];
  let events = 0;
  let canvasPixels = 0;
  let canvasBytes = 0;
  let firstAttemptAt: number | null = null;
  service.subscribe((e: EngineEventEnvelope) => {
    events++;
    if (e.event.type === 'canvas') {
      canvasPixels += e.event.pixels.length / 2;
      canvasBytes += JSON.stringify(e).length;
    }
    if (e.event.type === 'attempts' && firstAttemptAt === null) firstAttemptAt = performance.now();
    if (e.event.type === 'status') statusEventAt.push(performance.now());
  });

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  // Event loop blocks (> 20 ms) with their time, from a 2 ms heartbeat.
  const blocks: { start: number; end: number }[] = [];
  let lastBeat = performance.now();
  let beating = true;
  const beat = () => {
    const now = performance.now();
    if (now - lastBeat > 20) blocks.push({ start: lastBeat, end: now });
    lastBeat = now;
    if (beating) setTimeout(beat, 2);
  };
  setTimeout(beat, 2);
  const machine0 = machineTimes();
  const cpu0 = process.cpuUsage();
  let edits = 0;
  let editedPixels = 0;
  const editTimer = EDITS
    ? setInterval(() => {
        void svc.simulateExternalEdit(25).then(
          (r) => {
            edits++;
            editedPixels += r.changed;
          },
          () => undefined
        );
      }, 2000)
    : null;
  const started = performance.now();
  await service.start();
  const statusTimes: number[] = [];
  const statusTimer = setInterval(() => {
    const s = performance.now();
    service.status();
    statusTimes.push(performance.now() - s);
  }, 250);
  // Until the time is up or the template is complete.
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until && service.status().state !== 'completed') await new Promise((r) => setTimeout(r, 100));
  clearInterval(statusTimer);
  if (editTimer !== null) clearInterval(editTimer);
  beating = false;
  const machine1 = machineTimes();
  const cpu1 = process.cpuUsage(cpu0);
  client.postMessage('stop');
  httpTimes = await httpLoop;
  await client.terminate();
  server.close();
  out.endState = service.status().state;

  t = performance.now();
  if (service.status().commands.pause) {
    await service.pause();
    out.pauseMs = ms(performance.now() - t);
  }
  t = performance.now();
  const region = await service.canvasRegion();
  out.canvasRegionMs = ms(performance.now() - t);
  out.canvasRegionJsonMiB = ms(JSON.stringify(region).length / 1024 / 1024);
  lag.disable();

  const st = service.status();
  const elapsed = (performance.now() - started) / 1000;
  out.firstBatchMs = firstAttemptAt === null ? null : ms(firstAttemptAt - started);
  out.applied = st.scheduler?.applied;
  out.pixelsPerSecond = Math.round((st.scheduler?.applied ?? 0) / elapsed);
  out.cycles = st.scheduler?.cycles;
  out.msPerCycle = st.scheduler?.cycles ? ms((elapsed * 1000) / st.scheduler.cycles) : null;
  const cycles = cycleAt.slice(1).map((t, i) => t - cycleAt[i]!);
  out.cycleMs = { median: quantile(cycles, 0.5), p95: quantile(cycles, 0.95), p99: quantile(cycles, 0.99), max: quantile(cycles, 1), count: cycles.length };
  out.firstCycleMs = cycleAt.length > 0 ? ms(cycleAt[0]! - started) : null;
  const steadyFrom = cycleAt[0] ?? Infinity;
  const blockMs = (list: { start: number; end: number }[]) => list.map((b) => b.end - b.start);
  const startup = blockMs(blocks.filter((b) => b.end <= steadyFrom));
  const steady = blockMs(blocks.filter((b) => b.end > steadyFrom));
  out.blocksMs = {
    startupMax: startup.length === 0 ? 0 : ms(Math.max(...startup)),
    steadyMax: steady.length === 0 ? 0 : ms(Math.max(...steady)),
    steadyP95: quantile(steady, 0.95),
    steadyOver100: steady.filter((b) => b > 100).length,
    steadyOver300: steady.filter((b) => b > 300).length,
  };
  const wallMs = performance.now() - started;
  out.load = {
    machineBusyPercent: Math.round(((machine1.busy - machine0.busy) / Math.max(1, machine1.total - machine0.total)) * 100),
    processCpuPercentOfOneCore: Math.round(((cpu1.user + cpu1.system) / 1000 / wallMs) * 100),
    cores: os.cpus().length,
  };
  if (EDITS) out.externalEdits = { edits, editedPixels };
  out.httpMs = { median: quantile(httpTimes, 0.5), p95: quantile(httpTimes, 0.95), max: quantile(httpTimes, 1), requests: httpTimes.length };
  const gaps = statusEventAt.slice(1).map((t, i) => t - statusEventAt[i]!);
  out.statusEventGapMs = { median: quantile(gaps, 0.5), max: quantile(gaps, 1) };
  out.eventLoopDelayMs = { p50: ms(lag.percentile(50) / 1e6), p99: ms(lag.percentile(99) / 1e6), max: ms(lag.max / 1e6) };
  out.statusMs = { max: ms(Math.max(...statusTimes)), mean: ms(statusTimes.reduce((a, b) => a + b, 0) / statusTimes.length) };
  out.eventsPerSecond = Math.round(events / elapsed);
  out.canvasEventPixels = canvasPixels;
  out.canvasEventKiBPerSecond = Math.round(canvasBytes / 1024 / elapsed);
  t = performance.now();
  await service.compact();
  out.compactWithWorldCheckpointMs = ms(performance.now() - t);
  await service.stop();
  sampleRss();
  out.peakRssMiB = Math.round(peakRss / 1024 / 1024);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await service?.close();
  clearInterval(rssTimer);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
