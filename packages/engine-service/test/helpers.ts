import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService, type EngineEventEnvelope, type EngineServiceOptions, type EngineStatus } from '../src/index.js';

const dirs: string[] = [];

export async function tempDir(prefix = 'gp-engine-'): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
}

/** A PNG of `w` x `h` pixels, colors of the demo palette (index from `color`), null = transparent. */
export async function demoPng(w: number, h: number, color: (x: number, y: number) => number | null): Promise<Uint8Array> {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = color(x, y);
      const o = (y * w + x) * 4;
      if (k === null) continue;
      const c = DEMO_COLORS[k]!;
      rgba[o] = (c >> 16) & 0xff;
      rgba[o + 1] = (c >> 8) & 0xff;
      rgba[o + 2] = c & 0xff;
      rgba[o + 3] = 255;
    }
  }
  return pngjsCodec.encode({ width: w, height: h, rgba });
}

/** Fast synthetic settings for the tests (small canvas, short latency). */
export const FAST = { simulator: { width: 64, height: 64, costPerPixel: 1, capacity: 1000, regenIntervalMs: 3_600_000, writeLatencyMs: 1 }, agent: { startEnergy: 1000, startCurrency: 5000 }, run: { maxBatchSize: 20, minBatchSize: 1 } };

/** Opens a service with the fast settings applied (a fresh directory is reset to them). */
export async function openFast(dir: string, options: Partial<EngineServiceOptions> = {}): Promise<{ service: EngineService; events: EngineEventEnvelope[] }> {
  const service = await EngineService.open({ dataDir: dir, eventIntervalMs: 20, ...options });
  const events: EngineEventEnvelope[] = [];
  service.subscribe((e) => events.push(e));
  const s = service.settings.simulator;
  if (s.width !== FAST.simulator.width || s.writeLatencyMs !== FAST.simulator.writeLatencyMs) {
    await service.configure({ simulator: FAST.simulator, agent: FAST.agent, run: FAST.run, resetWorld: true });
  }
  return { service, events };
}

/** Polls the status (real time, bounded): the engine runs on real timers. */
export async function waitFor(service: EngineService, predicate: (s: EngineStatus) => boolean, timeoutMs = 20_000): Promise<EngineStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = service.status();
    if (predicate(s)) return s;
    if (Date.now() > until) throw new Error(`timed out waiting; state ${s.state} (${s.reason ?? ''})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Decodes a canvas region (base64, little-endian int32). */
export function decodeRegion(data: string): Int32Array {
  const bytes = Buffer.from(data, 'base64');
  const out = new Int32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt32LE(i * 4);
  return out;
}
