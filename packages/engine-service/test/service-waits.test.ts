/**
 * Phase 1B.9 (review): the paths a user meets first with default-like
 * settings, on the REAL clock: waiting for energy (regeneration), pause and
 * stop during a wait, restart; automatic world checkpoints; the documented
 * recovery of a damaged world; the selection never replaced by a lookup.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineService, EngineServiceError, type EngineEventEnvelope } from '../src/index.js';
import { cleanup, decodeRegion, demoPng, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});

async function open(dir: string, options: Partial<Parameters<typeof EngineService.open>[0]> = {}) {
  const service = await EngineService.open({ dataDir: dir, eventIntervalMs: 20, ...options });
  opened.push(service);
  const events: EngineEventEnvelope[] = [];
  service.subscribe((e) => events.push(e));
  return { service, events };
}

/** Little energy, fast regeneration: the run must wait for energy many times. */
const SCARCE = { simulator: { width: 64, height: 64, costPerPixel: 1, capacity: 8, regenIntervalMs: 15, writeLatencyMs: 2 }, agent: { startEnergy: 4, startCurrency: 0 }, run: { maxBatchSize: 8, minBatchSize: 4 }, resetWorld: true };

async function scarceEngine(dir: string, options: Partial<Parameters<typeof EngineService.open>[0]> = {}) {
  const r = await open(dir, options);
  await r.service.configure(SCARCE);
  const t = await r.service.importTemplate({ name: 'Rare', png: await demoPng(10, 8, (x, y) => ((x + y) % 4 === 0 ? null : (x * y) % 2 === 0 ? 4 : 8)), x: 3, y: 2, strategy: 'top-to-bottom' });
  await r.service.selectTemplate(t.templateId);
  return { ...r, t };
}

async function matches(service: EngineService, templateId: string): Promise<boolean> {
  const img = await service.templateImage(templateId);
  const region = decodeRegion((await service.canvasRegion({ minX: img.x, minY: img.y, width: img.width, height: img.height })).data);
  return decodeRegion(img.data).every((v, i) => v === -1 || region[i] === v);
}

describe('waiting for energy on the real clock', () => {
  it('waits for regeneration (no busy loop), completes, and paints each pixel once', async () => {
    const dir = await tempDir();
    const { service, events, t } = await scarceEngine(dir);
    await service.start();
    const done = await waitFor(service, (s) => s.state === 'completed' || s.state === 'error', 30_000);
    expect(done.state, done.reason ?? '').toBe('completed');
    expect(events.some((e) => e.event.type === 'state' && e.event.to === 'waiting-resources')).toBe(true);
    expect(done.scheduler?.applied).toBe(t.paintablePixels);
    // One wait per batch of at least minBatchSize pixels: the cycles stay few (no busy loop).
    expect(done.scheduler!.cycles).toBeLessThan(4 * Math.ceil(t.paintablePixels / 4) + 10);
    expect(await matches(service, t.templateId)).toBe(true);
  });

  it('pause and stop during a wait take effect at once; a restart resumes and finishes', async () => {
    const dir = await tempDir();
    const first = await scarceEngine(dir);
    await first.service.start();
    await waitFor(first.service, (s) => s.state === 'waiting-resources', 15_000);
    const paused = await first.service.pause();
    expect(paused.status.state).toBe('paused');
    first.service.resume();
    await waitFor(first.service, (s) => s.state === 'waiting-resources', 15_000);
    const t0 = Date.now();
    const stopped = await first.service.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(stopped.status.state).toBe('stopped');
    expect(stopped.status.journal.openAttempts).toBe(0);
    await first.service.close();
    opened.splice(opened.indexOf(first.service), 1);
    const { service } = await open(dir);
    await service.start();
    const done = await waitFor(service, (s) => s.state === 'completed' || s.state === 'error', 30_000);
    expect(done.state).toBe('completed');
    expect(await matches(service, first.t.templateId)).toBe(true);
  });
});

describe('automatic world checkpoints', () => {
  it('checkpoints the simulated world past the threshold, and restores it after a restart', async () => {
    const dir = await tempDir();
    const { service, t } = await scarceEngine(dir, { worldCheckpointRecords: 5 });
    await service.start();
    await waitFor(service, (s) => s.state === 'completed', 30_000);
    const energy = (await service.resourcesView()).energy;
    // close() waits for a checkpoint still in progress (the last cycle may have started one):
    // the generation is read from the files afterwards.
    await service.close();
    opened.splice(opened.indexOf(service), 1);
    const files = (await readdir(path.join(dir, 'world'))).sort();
    const generation = Number(/^world-(\d+)\.ckpt$/.exec(files[1]!)?.[1]);
    expect(generation).toBeGreaterThan(2);
    expect(files).toEqual(['CURRENT', `world-${generation}.ckpt`, `world-${generation}.log`]);
    const again = await open(dir);
    expect(again.service.status().world.generation).toBe(generation);
    expect(await matches(again.service, t.templateId)).toBe(true);
    // Regeneration went on meanwhile: never less energy than before the restart.
    expect((await again.service.resourcesView()).energy).toBeGreaterThanOrEqual(energy);
  });
});

describe('a damaged simulated world: the documented recovery', () => {
  it('is reported, refuses to start, and an explicit reset gives a usable new world (the old one kept aside)', async () => {
    const dir = await tempDir();
    const first = await scarceEngine(dir);
    await first.service.start();
    await waitFor(first.service, (s) => (s.scheduler?.applied ?? 0) > 10, 15_000);
    await first.service.stop();
    await first.service.close();
    opened.splice(opened.indexOf(first.service), 1);
    // Damage a line in the middle of the world log.
    const world = path.join(dir, 'world');
    const log = (await readdir(world)).find((n) => n.endsWith('.log'))!;
    const lines = (await readFile(path.join(world, log), 'utf8')).split('\n');
    expect(lines.length).toBeGreaterThan(3);
    lines[1] = lines[1]!.replace('"seq":2', '"seq":7');
    await writeFile(path.join(world, log), lines.join('\n'));

    const { service } = await open(dir);
    const status = service.status();
    expect(status.world).toMatchObject({ available: false, error: { code: 'WORLD_DAMAGED' } });
    expect(status.commands.start).toBe(false);
    await expect(service.start()).rejects.toMatchObject({ code: 'WORLD_UNAVAILABLE' });
    await expect(service.canvasRegion()).rejects.toBeInstanceOf(EngineServiceError);
    await service.resetWorld('RESET');
    expect(service.status().world.available).toBe(true);
    expect((await readdir(dir)).some((n) => n.startsWith('world-reset-'))).toBe(true);
    await service.start();
    const done = await waitFor(service, (s) => s.state === 'completed' || s.state === 'error', 30_000);
    expect(done.state).toBe('completed');
    expect(await matches(service, first.t.templateId)).toBe(true);
  });
});

describe('the selection', () => {
  it('is never replaced by a lookup of another template or by a refused selection', async () => {
    const dir = await tempDir();
    const { service, t } = await scarceEngine(dir);
    const other = await service.importTemplate({ name: 'Autre', png: await demoPng(4, 4, () => 1), x: 40, y: 40, strategy: 'random' });
    await service.templateInfoOf(other.templateId);
    await service.templateImage(other.templateId);
    expect(service.status().selection?.templateId).toBe(t.templateId);
    await service.start();
    await waitFor(service, (s) => s.state === 'running' || s.state === 'waiting-resources');
    await expect(service.selectTemplate(other.templateId)).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    expect(service.status().selection?.templateId).toBe(t.templateId);
    const region = await service.canvasRegion();
    expect(region.rect).toMatchObject({ minX: 3, minY: 2, width: 10, height: 8 });
    expect(region.truncated).toBe(false);
    await service.stop();
  });
});
