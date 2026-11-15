/**
 * Phase 1B.7: the simulated canvas provider plugged into the WorkPlanner
 * and the AttemptManager. Every scenario is deterministic (virtual clock,
 * queued faults); the journal is the in-memory one, shared across
 * "restarts" (a new manager over the same journal stands for a new process).
 */

import { describe, expect, it } from 'vitest';
import type { AgentId, Attempt, AttemptManager, JournalEvent, PlanResult, PreparedTemplate, ProjectId, ResourceManager, ResourceRules, Rgb, Template, TemplateId } from '@geoplacer/core';
import { AttemptError, TRANSPARENT_U32, createAttemptManager, createMemoryHistory, createMemoryJournal, createResourceManager, nextBatch, prepareTemplateSync } from '@geoplacer/core';
import { SimulatedCanvasError, SimulatedCanvasProvider, createManualClock, type ManualClock } from '../src/index.js';

const RED = 0xff0000 as Rgb;
const GREEN = 0x00ff00 as Rgb;
const BLUE = 0x0000ff as Rgb;
const A = 'agent-1' as AgentId;

// SYNTHETIC rules (tests only, not a real service).
const RULES: ResourceRules = {
  schemaVersion: 1,
  id: 'test-simulator',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 50, capacityLimit: 50, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED, GREEN], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};

/** A 4 x 2 template at (10, 20): red row, green row (one blue pixel the agent cannot paint). */
function template(yAxis: 'up' | 'down' = 'down'): Template {
  const pixels = new Uint32Array([RED, RED, RED, RED, GREEN, GREEN, BLUE, TRANSPARENT_U32]);
  return {
    id: 'fresque' as TemplateId,
    projectId: 'projet' as ProjectId,
    name: 'fresque',
    revision: 1,
    image: { width: 4, height: 2, pixels },
    placement: { topLeft: { x: 10, y: 20 } },
    coordinateSystem: { yAxis },
    palette: { id: 'p', colors: [RED, GREEN, BLUE].map((rgb) => ({ rgb })) },
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

class Engine {
  readonly clock: ManualClock = createManualClock(1_000_000);
  readonly canvas: SimulatedCanvasProvider;
  readonly journal = createMemoryJournal();
  readonly history = createMemoryHistory();
  resources!: ResourceManager;
  manager!: AttemptManager;
  readonly prepared: PreparedTemplate;
  private ids = 0;

  constructor(yAxis: 'up' | 'down' = 'down', energy = 20) {
    this.canvas = new SimulatedCanvasProvider({ bounds: { minX: 0, minY: 0, width: 32, height: 32 }, coordinateSystem: { yAxis }, rules: RULES, clock: this.clock });
    this.canvas.addAgent({ agent: A, energy, unlockedColors: [RED, GREEN] });
    this.prepared = prepareTemplateSync(template(yAxis));
    this.start();
  }

  /** A (new) process: fresh ResourceManager, manager over the same journal. */
  start(): void {
    this.resources = createResourceManager(RULES);
    this.manager = createAttemptManager({ journal: this.journal, history: this.history, resources: this.resources, newAttemptId: () => `att-${++this.ids}` as never });
  }

  tick(ms = 1): number {
    return this.clock.advance(ms);
  }

  observe(): void {
    this.tick();
    this.resources.observe(this.canvas.observe(A));
  }

  async plan(maxBatch = 100): Promise<PlanResult> {
    this.tick();
    const now = this.clock.now();
    return nextBatch(this.prepared, {
      agent: A,
      snapshot: await this.canvas.snapshot(),
      resources: this.resources.stateAt(A, now, now),
      rules: RULES,
      maxBatch,
      inFlight: this.manager.inFlight(),
      committedEnergy: this.manager.committedEnergy(A),
      unknownPixels: 'skip',
      freshness: { simulated: { maxAgeMs: 60_000 } },
      maxResourceAgeMs: 60_000,
      resourcesUncertainSince: this.manager.resourcesUncertainSince(A),
      now,
    });
  }

  /** Plans, leases and starts (journaled before the write); returns the started attempt. */
  async startBatch(maxBatch = 100): Promise<Attempt> {
    const plan = await this.plan(maxBatch);
    expect(plan.status).toBe('ok');
    const leased = await this.manager.lease({ agent: A, projectId: 'projet' as ProjectId, templateId: 'fresque' as TemplateId, revision: 1, writes: plan.writes, now: this.tick(), ttlMs: 60_000 });
    return this.manager.start(leased.attemptId, this.tick());
  }

  /** Writes a started attempt and closes it from the answer (with the reported resources), or returns the error. */
  async write(attempt: Attempt): Promise<Attempt | SimulatedCanvasError> {
    try {
      const result = await this.canvas.writer.applyPixels(A, attempt.writes, { attemptId: attempt.attemptId });
      this.tick();
      const anyRejected = result.outcomes.some((o) => o.status === 'rejected');
      return anyRejected
        ? await this.manager.fail(attempt.attemptId, 'rejected by the canvas', result.outcomes, this.clock.now(), result.resources)
        : await this.manager.finish(attempt.attemptId, result.outcomes, this.clock.now(), result.resources);
    } catch (error) {
      if (error instanceof SimulatedCanvasError) return error;
      throw error;
    }
  }

  async reconcile(attempt: Attempt): Promise<Attempt> {
    this.tick();
    const snapshot = await this.canvas.snapshot();
    return this.manager.reconcile(attempt.attemptId, snapshot, this.tick());
  }

  energySeen(): number {
    const now = this.clock.now();
    return this.resources.stateAt(A, now, now).energy;
  }
}

const results = (a: Attempt): string[] => a.results.map((r) => r.result);

describe('reconciliation with the simulated canvas', () => {
  it('1. fully successful attempt: applied, spent once (observation reported with the answer), nothing left to do', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    const started = await e.startBatch();
    expect(started.writes).toHaveLength(6); // the blue pixel is not offered (color not unlocked)
    const closed = (await e.write(started)) as Attempt;
    expect(closed.state).toBe('finished');
    expect(results(closed)).toEqual(Array(6).fill('applied'));
    expect(e.energySeen()).toBe(e.canvas.observe(A).energy);
    expect(e.resources.recordedSpends(A)).toEqual([]); // the reported observation replaced the spend
    const plan = await e.plan();
    expect(plan).toMatchObject({ status: 'nothing-to-do', unavailableColors: [{ color: BLUE, pixels: 1 }] });
  });

  it('2. partially successful attempt: not enough energy for every pixel; the rest is planned again', async () => {
    const e = new Engine('down', 3);
    await e.manager.recover(e.tick());
    e.observe();
    const plan = await e.plan();
    expect(plan.budget).toBe(3);
    expect(plan.writes).toHaveLength(3);
    // The engine's view was right; another actor consumed nothing. Force a partial success: ask for more than the canvas allows.
    e.canvas.addAgent({ agent: A, energy: 1, unlockedColors: [RED, GREEN] });
    const leased = await e.manager.lease({ agent: A, projectId: 'projet' as ProjectId, templateId: 'fresque' as TemplateId, revision: 1, writes: plan.writes, now: e.tick(), ttlMs: 60_000 });
    const closed = (await e.write(await e.manager.start(leased.attemptId, e.tick()))) as Attempt;
    expect(closed.state).toBe('failed');
    expect(results(closed)).toEqual(['applied', 'rejected', 'rejected']);
    expect(e.energySeen()).toBe(0);
    e.tick(5_000);
    e.observe();
    const again = await e.plan();
    expect(again.writes.map((w) => w.point)).toEqual([{ x: 11, y: 20 }, { x: 12, y: 20 }, { x: 13, y: 20 }, { x: 10, y: 21 }, { x: 11, y: 21 }]);
  });

  it('3. failed attempt: every pixel rejected (rate limited), nothing spent, all planned again', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    e.canvas.injectFaults({ kind: 'reject', reason: 'rate-limited' });
    const closed = (await e.write(await e.startBatch())) as Attempt;
    expect(closed.state).toBe('failed');
    expect(e.canvas.events).toEqual([]);
    expect(e.energySeen()).toBe(20);
    expect((await e.plan()).writes).toHaveLength(6);
  });

  it('4. interrupted before the application: reconciled as observed-incorrect, never "applied"; planned again by a new attempt', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    e.canvas.injectFaults({ kind: 'fail-before' });
    const started = await e.startBatch();
    expect(await e.write(started)).toMatchObject({ fault: 'fail-before' });
    const reconciled = await e.reconcile(started);
    expect(results(reconciled)).toEqual(Array(6).fill('observed-incorrect'));
    expect((await e.plan()).refusals.map((r) => r.code)).toEqual(['RESOURCES_UNCERTAIN']);
    e.observe();
    const next = await e.startBatch();
    expect(next.attemptId).not.toBe(started.attemptId);
    expect(results((await e.write(next)) as Attempt)).toEqual(Array(6).fill('applied'));
  });

  it('5. interrupted during the application: the pixels that landed are observed-correct, the others planned again', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    e.canvas.injectFaults({ kind: 'partial', applied: 2 });
    const started = await e.startBatch();
    expect(await e.write(started)).toMatchObject({ fault: 'partial' });
    const reconciled = await e.reconcile(started);
    expect(results(reconciled)).toEqual(['observed-correct', 'observed-correct', 'observed-incorrect', 'observed-incorrect', 'observed-incorrect', 'observed-incorrect']);
    e.observe();
    expect(e.energySeen()).toBe(18); // the provider's observation, not a guess
    const again = await e.plan();
    expect(again.writes).toHaveLength(4);
    for (const p of [{ x: 10, y: 20 }, { x: 11, y: 20 }]) expect(e.canvas.appliedCount(p)).toBe(1);
  });

  it('6. applied but answer lost: reconciled observed-correct, not written again, energy never counted twice', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    e.canvas.injectFaults({ kind: 'answer-lost' });
    const started = await e.startBatch();
    expect(await e.write(started)).toMatchObject({ fault: 'answer-lost' });
    const reconciled = await e.reconcile(started);
    expect(results(reconciled)).toEqual(Array(6).fill('observed-correct'));
    expect(e.resources.recordedSpends(A)).toEqual([]);
    e.observe();
    expect(e.energySeen()).toBe(14);
    expect((await e.plan()).status).toBe('nothing-to-do');
    expect(e.canvas.events.filter((x) => x.kind === 'applied')).toHaveLength(6);
  });

  it('7. a pixel changed by another actor after its placement is planned again', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    await e.write(await e.startBatch());
    e.canvas.paint({ x: 12, y: 20 }, BLUE);
    e.canvas.erase({ x: 11, y: 21 });
    e.observe();
    const plan = await e.plan();
    expect(plan.writes.map((w) => [w.point, w.taskId])).toEqual([
      [{ x: 12, y: 20 }, 'projet/fresque@1:12,20:#ff0000'],
      [{ x: 11, y: 21 }, 'projet/fresque@1:11,21:#00ff00'],
    ]);
  });

  it('8. restart before the reconciliation: the started attempt is reconciled by the new process, never resent', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    const started = await e.startBatch();
    await e.canvas.writer.applyPixels(A, started.writes, { attemptId: started.attemptId }); // landed, then the process dies
    const callsBefore = e.canvas.writeCalls;
    e.start();
    const report = await e.manager.recover(e.tick());
    expect(report).toMatchObject({ released: [], toReconcile: [started.attemptId], damaged: false });
    const reconciled = await e.reconcile(e.manager.get(started.attemptId) as Attempt);
    expect(results(reconciled)).toEqual(Array(6).fill('observed-correct'));
    expect(e.canvas.writeCalls).toBe(callsBefore);
    e.observe();
    expect((await e.plan()).status).toBe('nothing-to-do');
  });

  it('9. restart during the reconciliation: before it is journaled it is still to reconcile; after, it is closed', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    const started = await e.startBatch();
    e.canvas.injectFaults({ kind: 'partial', applied: 3 });
    await e.write(started);
    // (a) The canvas was read, then the process died before "reconciled" was journaled.
    const append = e.journal.append.bind(e.journal);
    e.journal.append = async (event: JournalEvent) => {
      if (event.type === 'reconciled') throw new Error('process killed');
      return append(event);
    };
    await expect(e.reconcile(started)).rejects.toThrow('process killed');
    e.journal.append = append;
    e.start();
    expect(await e.manager.recover(e.tick())).toMatchObject({ toReconcile: [started.attemptId] });
    // (b) Journaled, then the process died before the history entry: closed after the restart.
    const historyAppend = e.history.append.bind(e.history);
    e.history.append = async () => {
      throw new Error('process killed');
    };
    await expect(e.reconcile(e.manager.get(started.attemptId) as Attempt)).rejects.toThrow('process killed');
    e.history.append = historyAppend;
    e.start();
    const report = await e.manager.recover(e.tick());
    expect(report.toReconcile).toEqual([]);
    expect(e.manager.get(started.attemptId)).toMatchObject({ state: 'finished', reconciled: true });
  });

  it('10. energy uncertain: unknown outcomes block planning and leasing until the provider is observed again', async () => {
    const e = new Engine();
    await e.manager.recover(e.tick());
    e.observe();
    e.canvas.injectFaults({ kind: 'unknown-outcomes' });
    const closed = (await e.write(await e.startBatch(2))) as Attempt;
    expect(results(closed)).toEqual(['unknown', 'unknown']);
    expect(e.manager.resourcesUncertainSince(A)).not.toBeNull();
    // The reported observation came with the answer, but the outcomes are unknown: still uncertain.
    expect((await e.plan()).refusals.map((r) => r.code)).toEqual(['RESOURCES_UNCERTAIN']);
    await expect(e.manager.lease({ agent: A, projectId: 'projet' as ProjectId, templateId: 'fresque' as TemplateId, revision: 1, writes: [{ taskId: 'x' as never, point: { x: 0, y: 0 }, color: RED }], now: e.tick(), ttlMs: 10 })).rejects.toBeInstanceOf(AttemptError);
    e.observe();
    expect(e.energySeen()).toBe(18);
    expect((await e.plan()).status).toBe('ok');
  });

  it('works in a y-up canvas the same way (explicit coordinate system)', async () => {
    const e = new Engine('up');
    await e.manager.recover(e.tick());
    e.observe();
    const started = await e.startBatch();
    expect(started.writes.slice(0, 2).map((w) => w.point)).toEqual([{ x: 10, y: 20 }, { x: 11, y: 20 }]);
    expect(started.writes[4]!.point).toEqual({ x: 10, y: 19 }); // second image row is below in y-up
    await e.write(started);
    expect((await e.plan()).status).toBe('nothing-to-do');
  });

  it('is deterministic: the same script gives the same journal and canvas', async () => {
    const run = async (): Promise<string> => {
      const e = new Engine();
      await e.manager.recover(e.tick());
      e.observe();
      e.canvas.injectFaults({ kind: 'partial', applied: 1 }, { kind: 'answer-lost' });
      const a = await e.startBatch(3);
      await e.write(a);
      await e.reconcile(a);
      e.observe();
      const b = await e.startBatch(3);
      await e.write(b);
      await e.reconcile(b);
      return JSON.stringify({ journal: e.journal.events, canvas: e.canvas.events });
    };
    expect(await run()).toBe(await run());
  });
});
