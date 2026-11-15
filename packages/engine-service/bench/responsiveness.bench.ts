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
 * usage: node --expose-gc --import tsx bench/responsiveness.bench.ts [side] [seconds]
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService, type EngineEventEnvelope } from '../src/index.js';

const SIDE = Number(process.argv[2] ?? 2000);
const SECONDS = Number(process.argv[3] ?? 20);
const ms = (t: number) => Math.round(t * 10) / 10;
let peakRss = 0;
const sampleRss = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
const rssTimer = setInterval(sampleRss, 100);

const dir = await mkdtemp(path.join(tmpdir(), 'gp-bench-'));
const out: Record<string, unknown> = { side: SIDE, seconds: SECONDS, node: process.version };
let service: EngineService | null = null;
try {
  let t = performance.now();
  service = await EngineService.open({ dataDir: dir });
  await service.configure({
    simulator: { width: 2048, height: 2048, costPerPixel: 1, capacity: 1_000_000, regenIntervalMs: 3_600_000, writeLatencyMs: 0 },
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
  });

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
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
