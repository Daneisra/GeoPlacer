import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DataDirectoryLockedError } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService, EngineServiceError } from '../src/index.js';
import { cleanup, decodeRegion, demoPng, openFast, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);

const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});

async function engine(dir?: string, options: Parameters<typeof openFast>[1] = {}) {
  const d = dir ?? (await tempDir());
  const r = await openFast(d, options);
  opened.push(r.service);
  return { dir: d, ...r };
}

/** Imports and selects a w x h template of two colors (stripes), at (x, y). */
async function withTemplate(service: EngineService, w = 12, h = 10, x = 5, y = 7, strategy = 'top-to-bottom') {
  const png = await demoPng(w, h, (px, py) => ((px + py) % 3 === 0 ? null : (px + py) % 2 === 0 ? 4 : 8));
  const t = await service.importTemplate({ name: 'Fresque', png, x, y, strategy });
  await service.selectTemplate(t.templateId);
  return t;
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineServiceError);
    expect((error as EngineServiceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** The canvas matches the template on every paintable pixel. */
async function matchesTemplate(service: EngineService, templateId: string): Promise<boolean> {
  const img = await service.templateImage(templateId);
  const region = await service.canvasRegion({ minX: img.x, minY: img.y, width: img.width, height: img.height });
  const want = decodeRegion(img.data);
  const got = decodeRegion(region.data);
  return want.every((v, i) => v === -1 || got[i] === v);
}

describe('EngineService: a complete simulated run (Phase 1B.9)', () => {
  it('runs a template to completion on the durable simulated canvas, with sequenced and grouped events', async () => {
    const { service, events } = await engine();
    const t = await withTemplate(service);
    expect(service.status().commands).toMatchObject({ start: true, pause: false, resume: false, stop: false });
    const started = await service.start();
    expect(started.changed).toBe(true);
    const done = await waitFor(service, (s) => s.state === 'completed');
    expect(done.scheduler?.progressPercent).toBe(100);
    expect(done.scheduler?.applied).toBe(t.paintablePixels);
    expect(done.commands).toMatchObject({ start: true, pause: false, stop: false });
    expect(await matchesTemplate(service, t.templateId)).toBe(true);
    // Energy: spent once per painted pixel (no regeneration in the fast settings).
    const resources = await service.resourcesView();
    expect(resources.energy).toBe(1000 - t.paintablePixels);
    // Events: increasing sequence numbers; canvas changes grouped, never one message per pixel.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const canvasEvents = events.filter((e) => e.event.type === 'canvas');
    const pixelsSent = canvasEvents.reduce((n, e) => n + (e.event.type === 'canvas' ? e.event.pixels.length / 2 : 0), 0);
    expect(pixelsSent).toBeGreaterThanOrEqual(t.paintablePixels);
    expect(canvasEvents.length).toBeLessThan(t.paintablePixels / 2);
    expect(events.some((e) => e.event.type === 'state' && e.event.to === 'completed')).toBe(true);
  });

  it('a snapshot carries the sequence number it includes: later canvas events apply on top of it', async () => {
    const { service, events } = await engine();
    await withTemplate(service, 20, 20, 0, 0);
    await service.start();
    await waitFor(service, (s) => (s.scheduler?.applied ?? 0) > 50);
    const snap = await service.canvasRegion({ minX: 0, minY: 0, width: 64, height: 64 });
    await waitFor(service, (s) => s.state === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const view = decodeRegion(snap.data);
    for (const e of events) if (e.seq > snap.seq && e.event.type === 'canvas') for (let k = 0; k < e.event.pixels.length; k += 2) view[e.event.pixels[k]!] = e.event.pixels[k + 1]!;
    const final = decodeRegion((await service.canvasRegion({ minX: 0, minY: 0, width: 64, height: 64 })).data);
    expect([...view]).toEqual([...final]);
  });
});

describe('EngineService: no network (Phase 1B.10)', () => {
  it('a whole simulation, a backup and the diagnostics open no outgoing connection', async () => {
    const net = await import('node:net');
    const original = net.Socket.prototype.connect;
    const attempts: unknown[] = [];
    net.Socket.prototype.connect = function (this: unknown, ...args: unknown[]) {
      attempts.push(args[0]);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      const { service } = await engine();
      await withTemplate(service);
      await service.start();
      await waitFor(service, (s) => s.state === 'completed');
      await service.backup();
      await service.journalDiagnosis();
      await service.resourcesView();
    } finally {
      net.Socket.prototype.connect = original;
    }
    expect(attempts).toEqual([]);
  });
});

describe('EngineService: commands, concurrent and incompatible requests', () => {
  it('start, pause, resume and stop: idempotent where it makes sense, explicit refusals otherwise', async () => {
    const { service } = await engine();
    await expectCode(service.start(), 'NO_TEMPLATE_SELECTED');
    await expectCode(service.pause(), 'NOT_RUNNING');
    await expectCode(() => service.resume(), 'NOT_PAUSED'); // a resume without pause
    expect((await service.stop()).changed).toBe(false);
    await service.configure({ simulator: { writeLatencyMs: 30 } });
    await withTemplate(service, 30, 30, 0, 0);
    const [a, b] = await Promise.all([service.start(), service.start()]); // two starts at once
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect((await service.start()).changed).toBe(false);
    expect(service.resume().changed).toBe(false); // running: nothing to resume
    expect((await service.pause()).changed).toBe(true);
    expect((await service.pause()).changed).toBe(false);
    expect(service.status().commands).toMatchObject({ start: false, pause: false, resume: true, stop: true });
    await expectCode(service.start(), 'PAUSED_USE_RESUME');
    expect(service.resume().changed).toBe(true);
    const [s1, s2] = await Promise.all([service.stop(), service.stop()]); // two stops share one result
    expect(s1).toBe(s2);
    expect(s1.status.state).toBe('stopped');
    expect(s1.status.journal.openAttempts).toBe(0);
    // The answer of a stop offers the commands of the stopped state (found by the browser acceptance).
    expect(s1.status.commands).toMatchObject({ start: true, pause: false, resume: false, stop: false });
    expect((await service.stop()).changed).toBe(false);
  });

  it('a stop during a write waits for its answer; with abort, the started attempt is reconciled, never abandoned', async () => {
    const { service } = await engine();
    await service.configure({ simulator: { writeLatencyMs: 400 } });
    const t = await withTemplate(service, 20, 20, 0, 0);
    await service.start();
    await waitFor(service, (s) => s.journal.openAttempts > 0 && (s.scheduler?.uncertainAttempts.length ?? 0) > 0);
    const stopped = await service.stop();
    expect(stopped.status.journal.openAttempts).toBe(0);
    expect(stopped.status.scheduler?.uncertainAttempts).toEqual([]);
    await service.start();
    await waitFor(service, (s) => (s.scheduler?.uncertainAttempts.length ?? 0) > 0);
    const aborted = await service.stop({ abort: true });
    // The aborted write is reconciled from a canvas read (or reported open, then reconciled at the next start).
    expect(aborted.status.state).toBe('stopped');
    await service.configure({ simulator: { writeLatencyMs: 1 } });
    await service.start();
    await waitFor(service, (s) => s.state === 'completed');
    expect(await matchesTemplate(service, t.templateId)).toBe(true);
    expect((await service.resourcesView()).energy).toBe(1000 - t.paintablePixels);
  });

  it('a template change while running is refused; a move (new revision) is followed without painting twice', async () => {
    const { service } = await engine();
    await service.configure({ simulator: { writeLatencyMs: 20 } });
    const t = await withTemplate(service, 16, 16, 0, 0);
    const other = await service.importTemplate({ name: 'Autre', png: await demoPng(4, 4, () => 1), x: 0, y: 0, strategy: 'random' });
    await service.start();
    await waitFor(service, (s) => (s.scheduler?.applied ?? 0) > 20);
    await expectCode(service.selectTemplate(other.templateId), 'ENGINE_BUSY');
    await expectCode(service.configure({ run: { maxBatchSize: 5 } }), 'ENGINE_BUSY');
    const moved = await service.moveTemplate(t.templateId, 30, 30);
    expect(moved.revision).toBe(2);
    await waitFor(service, (s) => s.state === 'completed' && s.scheduler?.revision === 2);
    expect(await matchesTemplate(service, t.templateId)).toBe(true);
    await expectCode(service.moveTemplate(t.templateId, 60, 60), 'TEMPLATE_OUTSIDE_CANVAS');
  });

  it('one compaction at a time; diagnosis is full when stopped, live while running', async () => {
    const { service } = await engine();
    const t = await withTemplate(service);
    await service.start();
    await waitFor(service, (s) => s.state === 'completed');
    const results = await Promise.allSettled([service.compact(), service.compact()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as EngineServiceError).code).toBe('COMPACTION_IN_PROGRESS');
    const full = await service.journalDiagnosis();
    expect(full.mode).toBe('full');
    expect((full.diagnosis as { verdict: string }).verdict).toBe('healthy');
    await service.configure({ simulator: { writeLatencyMs: 200 } });
    await service.moveTemplate(t.templateId, 40, 40);
    await service.start();
    expect((await service.journalDiagnosis()).mode).toBe('live');
    await service.stop();
  });
});

describe('EngineService: settings, world reset, resources and upgrades', () => {
  it('a new canvas size needs an explicit reset; the old world is kept aside', async () => {
    const { service, dir } = await engine();
    await withTemplate(service);
    await expectCode(service.configure({ simulator: { width: 128 } }), 'WORLD_RESET_REQUIRED');
    await expectCode(service.resetWorld('yes'), 'CONFIRMATION_REQUIRED');
    const before = service.settings.simulator.rulesVersion;
    await service.configure({ simulator: { width: 128 }, resetWorld: true });
    expect(service.settings.simulator.width).toBe(128);
    expect(service.settings.simulator.rulesVersion).toBe(before + 1);
    expect((await readdir(dir)).filter((n) => n.startsWith('world-reset-')).length).toBeGreaterThanOrEqual(1);
    expect(service.status().world.available).toBe(true);
  });

  it('shows the simulated resources and proposals; an upgrade needs a confirmation, is refused while writing or when stale, and changes only the local world', async () => {
    const { service } = await engine();
    const t = await withTemplate(service);
    const view = await service.resourcesView();
    expect(view.simulated).toBe(true);
    expect(view.energy).toBe(1000);
    expect(view.currency).toBe(5000);
    expect(view.lockedColors.length).toBe(8);
    expect(view.proposals.length).toBeGreaterThan(0);
    const pack = view.proposals.find((p) => p.kind === 'energy-pack' && p.possible)!;
    await expectCode(service.applyUpgrade(pack.id, false), 'CONFIRMATION_REQUIRED');
    await expectCode(service.applyUpgrade('unknown', true), 'STALE_PROPOSAL');
    const applied = await service.applyUpgrade(pack.id, true);
    expect(applied.resources.currency).toBe(5000 - (pack.cost ?? 0));
    expect(applied.resources.energy).toBeGreaterThan(1000);
    await expectCode(service.applyUpgrade(pack.id, true), 'STALE_PROPOSAL'); // already applied: read again
    // Stale after another change of the agent (a spend).
    const fresh = await service.resourcesView();
    await service.start();
    await waitFor(service, (s) => s.state === 'completed');
    await expectCode(service.applyUpgrade(fresh.proposals.find((p) => p.possible)!.id, true), 'STALE_PROPOSAL');
    expect(await matchesTemplate(service, t.templateId)).toBe(true);
  });

  it('refuses an upgrade while the simulation writes', async () => {
    const { service } = await engine();
    await service.configure({ simulator: { writeLatencyMs: 100 } });
    await withTemplate(service, 20, 20, 0, 0);
    const view = await service.resourcesView();
    await service.start();
    await waitFor(service, (s) => s.state === 'running');
    await expectCode(service.applyUpgrade(view.proposals[0]!.id, true), 'ENGINE_BUSY');
    await service.stop();
  });
});

describe('EngineService: one instance per data directory, restart', () => {
  it('refuses a second engine on the same directory, without touching it', async () => {
    const { dir } = await engine();
    await expect(EngineService.open({ dataDir: dir })).rejects.toBeInstanceOf(DataDirectoryLockedError);
  });

  it('after a clean restart, the world, the template and the selection are restored', async () => {
    const { service, dir } = await engine();
    const t = await withTemplate(service);
    await service.start();
    await waitFor(service, (s) => s.state === 'completed');
    const energy = (await service.resourcesView()).energy;
    await service.close();
    opened.splice(opened.indexOf(service), 1);
    const again = await EngineService.open({ dataDir: dir });
    opened.push(again);
    expect(again.status().selection?.templateId).toBe(t.templateId);
    expect(await matchesTemplate(again, t.templateId)).toBe(true);
    expect((await again.resourcesView()).energy).toBe(energy);
    await again.start();
    const done = await waitFor(again, (s) => s.state === 'completed');
    expect(done.scheduler?.applied).toBe(0); // nothing painted twice
  });

  it('keeps every color of the demo palette distinct (test data sanity)', () => {
    expect(new Set(DEMO_COLORS).size).toBe(DEMO_COLORS.length);
  });
});
