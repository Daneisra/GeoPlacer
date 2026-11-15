/**
 * Phase 1B.8: complete scenarios of the single-agent scheduler on the local
 * simulator (B, the 2000 x 2000 model, is a benchmark: bench/scheduler.bench.ts).
 */

import { describe, expect, it } from 'vitest';
import type { Rgb, TemplateId } from '@geoplacer/core';
import { createMemoryTemplateStorage, createTemplateManager } from '@geoplacer/core';
import { rgbaPng } from '../../core/test/helpers/png.js';
import { sequentialIds, testCodec, testHasher } from '../../core/test/helpers/ports.js';
import { A, BLUE, Engine, GREEN, P, RED, image, template, until } from './helpers/engine.js';

describe('scenario A: a 100 x 100 template, one agent, limited energy', () => {
  it('a real TemplateManager (PNG, quantization, revision) and the scheduler finish the whole template', async () => {
    const manager = createTemplateManager({ storage: createMemoryTemplateStorage(), hasher: testHasher, codec: testCodec, ids: sequentialIds('fresque'), clock: { now: () => 1 } });
    const png = rgbaPng(100, 100, (x, y) => ((Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const created = await manager.create({ projectId: P, name: 'Fresque', sourcePng: png, palette: { id: 'p', colors: [{ rgb: RED }, { rgb: GREEN }, { rgb: BLUE }] }, placement: { topLeft: { x: 5, y: 7 } }, coordinateSystem: { yAxis: 'down' } });
    // The scheduler reads the template through the TemplateManager (current revision, verified on load).
    let loads = 0;
    const templates = {
      current: async (ref: { projectId: typeof P; templateId: TemplateId }) => {
        loads++;
        return (await manager.load(ref)).template;
      },
    };
    const e = new Engine(created, { canvasSize: 128, energy: 200, capacity: 200, regenIntervalMs: 1_000, templates, config: { templateId: created.id as TemplateId, maxBatchSize: 100, minBatchSize: 50, maxCycles: 2_000 } });
    const t0 = e.clock.now();
    const started = performance.now();
    await e.scheduler.start();
    const final = await e.scheduler.done();
    const realMs = performance.now() - started;
    expect(final).toMatchObject({ state: 'completed', correct: 10_000, incorrect: 0, unknown: 0, applied: 10_000, openAttempts: 0 });
    expect(e.wrong(created)).toBe(0);
    expect(e.appliedTwice()).toBe(0);
    // 10 000 pixels at 1 per second after the first 200: about 9 800 s of virtual time, no real waiting.
    expect(e.clock.now() - t0).toBeGreaterThan(9_700_000);
    expect(realMs).toBeLessThan(30_000);
    expect(loads).toBe(final.cycles);
  });
});

describe('scenario C: interruption in the middle, then restart', () => {
  it('a crash during a write and a graceful stop: open attempts kept, reconciled at restart, the template finished', async () => {
    const e = new Engine(template(image(20, 10, (x) => (x % 3 === 0 ? GREEN : RED))), { config: { maxBatchSize: 10 } });
    // Crash at the 6th write: it hangs forever (applied, never answered), the process is abandoned.
    e.canvas.injectFaults(...Array.from({ length: 5 }, () => ({ kind: 'none' as const })), { kind: 'hold', appliedBefore: true });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    expect(e.journal.events.filter((x) => x.type === 'finished')).toHaveLength(5);
    const openAtCrash = e.attempts.open().map((a) => a.attemptId);
    expect(openAtCrash).toHaveLength(1);
    // Restart: a new process over the same journal; then a graceful stop in the middle; then a last restart.
    e.canvas.forgetHeld(); // the crashed process is gone: its write never answers
    e.startProcess();
    let closedAfter = 0;
    e.scheduler.subscribe((ev) => {
      if (ev.type === 'attempt') closedAfter++;
    });
    e.canvas.injectFaults({ kind: 'hold', appliedBefore: false });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    // (The crashed attempt is reconciled by a read newer than its recovery: checked at the end.)
    const stopping = e.scheduler.stop();
    e.canvas.releaseHeld();
    expect(await stopping).toMatchObject({ state: 'stopped', openAttempts: 0 });
    expect(closedAfter).toBeGreaterThan(0);
    e.startProcess();
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    expect(e.wrong()).toBe(0);
    expect(e.appliedTwice()).toBe(0);
    const crashed = e.journal.events.find((x) => x.type === 'reconciled' && x.attemptId === openAtCrash[0]);
    expect(crashed).toBeDefined();
    expect((crashed as unknown as { results: { result: string }[] }).results.every((r) => r.result === "observed-correct")).toBe(true);
  });
});

describe('scenario D: an external change of a zone already conform', () => {
  it('the WorkPlanner proposes the zone again and only it is repainted', async () => {
    const e = new Engine(template(image(16, 12, (x, y) => ((x + y) % 4 === 0 ? GREEN : RED))));
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    const appliedBefore = e.canvas.events.filter((x) => x.kind === 'applied').length;
    // Another actor scribbles on a 4 x 3 zone of the finished template.
    let changed = 0;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        const p = { x: 2 + 5 + x, y: 3 + 4 + y };
        if ((x + y) % 2 === 0) e.canvas.erase(p);
        else e.canvas.paint(p, BLUE as Rgb);
        changed++;
      }
    }
    expect(e.wrong()).toBe(changed);
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    expect(e.wrong()).toBe(0);
    expect(e.canvas.events.filter((x) => x.kind === 'applied').length - appliedBefore).toBe(changed);
  });
});

describe('scenario E: uncertain resources (answer lost, then observed)', () => {
  it('the lost write is reconciled, a later observation is taken, and nothing is consumed twice', async () => {
    // No regeneration within the run: the provider energy is exactly the start minus the pixels applied.
    const e = new Engine(template(image(10, 4, () => RED)), { energy: 50, capacity: 50, regenIntervalMs: 1e9, config: { maxBatchSize: 10 } });
    e.canvas.injectFaults({ kind: 'none' }, { kind: 'answer-lost' });
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    const lost = e.journal.events.find((x) => x.type === 'reconciled');
    expect(lost).toBeDefined();
    const applied = e.canvas.events.filter((x) => x.kind === 'applied').length;
    expect(applied).toBe(40);
    const provider = e.canvas.observe(A).energy;
    expect(provider).toBe(50 - 40);
    // The engine's own view (observations + recorded spends) agrees with the provider: no double count.
    const now = e.clock.now();
    expect(e.resources.stateAt(A, now, now).energy).toBe(provider);
    expect(e.resources.recordedSpends(A).some((s) => s.operationId === (lost as { attemptId: string }).attemptId)).toBe(false);
  });
});
