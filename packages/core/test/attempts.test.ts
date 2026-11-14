import { describe, expect, it } from 'vitest';
import type {
  AgentId,
  Attempt,
  AttemptJournal,
  AttemptManager,
  JournalEvent,
  PixelWrite,
  PreparedTemplate,
  ProjectId,
  ResourceManager,
  StrategyConfig,
  TaskId,
  Template,
  TemplateId,
  TemplateImage,
} from '../src/index.js';
import {
  AttemptError,
  createAttemptManager,
  createMemoryHistory,
  createMemoryJournal,
  createResourceManager,
  decodeJournal,
  encodeJournalLine,
  nextBatch,
  prepareTemplateSync,
  transition,
} from '../src/index.js';
import { BLUE, GREEN, RED, SIMULATED_RULES as R } from './helpers/resources.js';
import { SimCanvas, SimulatedWriteError, type WriteFault } from './helpers/sim-canvas.js';
import { image, testRandom } from './helpers/strategy.js';

const T0 = 1_000_000;
const A1 = 'agent-1' as AgentId;
const A2 = 'agent-2' as AgentId;
const PROJECT = 'projet' as ProjectId;

function template(img: TemplateImage, id = 'modele', revision = 1, strategy: StrategyConfig = { id: 'top-to-bottom' }): Template {
  return {
    id: id as TemplateId,
    projectId: PROJECT,
    name: id,
    revision,
    image: img,
    placement: { topLeft: { x: 0, y: 0 } },
    coordinateSystem: { yAxis: 'down' },
    palette: { id: 'p', colors: [RED, GREEN, BLUE].map((rgb) => ({ rgb })) },
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

const solid = (w: number, h: number, color = RED): TemplateImage => image(w, h, () => color);

/** A test world: one local simulated canvas, one ResourceManager, one manager over a journal. */
class World {
  now = T0;
  readonly sim: SimCanvas;
  readonly resources: ResourceManager = createResourceManager(R);
  readonly journal: AttemptJournal & { readonly events: JournalEvent[] };
  readonly history = createMemoryHistory();
  manager: AttemptManager;
  private ids = 0;

  constructor(width: number, height: number, options: { idempotent?: boolean; journal?: AttemptJournal & { readonly events: JournalEvent[] } } = {}) {
    this.sim = new SimCanvas({ minX: 0, minY: 0, width, height }, options.idempotent ?? true);
    this.journal = options.journal ?? createMemoryJournal();
    this.manager = this.newManager();
  }

  newManager(): AttemptManager {
    return createAttemptManager({ journal: this.journal, history: this.history, resources: this.resources, newAttemptId: () => `att-${++this.ids}` as never });
  }

  tick(ms = 1): number {
    this.now += ms;
    return this.now;
  }

  /** The agent's provider reports its resources (an observation, at a new time). */
  observe(agent: AgentId, energy = 10, colors = [RED, GREEN, BLUE]): void {
    this.sim.energy.set(agent, energy);
    this.sim.unlocked.set(agent, colors);
    this.resources.observe(this.sim.observe(agent, this.tick()));
  }

  plan(prepared: PreparedTemplate, agent: AgentId, maxBatch = 1000) {
    const now = this.tick();
    return nextBatch(prepared, {
      agent,
      snapshot: this.sim.snapshot(now),
      resources: this.resources.stateAt(agent, now, now),
      rules: R,
      maxBatch,
      inFlight: this.manager.inFlight(),
      committedEnergy: this.manager.committedEnergy(agent),
      unknownPixels: 'skip',
      freshness: { simulated: { maxAgeMs: 60_000 } },
      resourcesUncertainSince: this.manager.resourcesUncertainSince(agent),
      now,
    });
  }

  lease(t: Template, agent: AgentId, writes: readonly PixelWrite[], ttlMs = 10_000): Promise<Attempt> {
    return this.manager.lease({ agent, projectId: t.projectId, templateId: t.id, revision: t.revision, writes, now: this.tick(), ttlMs });
  }

  /**
   * One full cycle for an agent: plan, lease, start (journaled before the
   * write), write, finish; an unknown result is reconciled from a fresh read.
   */
  async cycle(prepared: PreparedTemplate, agent: AgentId, maxBatch = 1000): Promise<Attempt | null> {
    const plan = this.plan(prepared, agent, maxBatch);
    if (plan.status !== 'ok') return null;
    const leased = await this.lease(prepared.template, agent, plan.writes);
    await this.manager.start(leased.attemptId, this.tick());
    try {
      const result = await this.sim.applyPixels(agent, leased.writes, { attemptId: leased.attemptId });
      return await this.manager.finish(leased.attemptId, result.outcomes, this.tick());
    } catch (error) {
      if (!(error instanceof SimulatedWriteError)) throw error;
      return this.manager.reconcile(leased.attemptId, this.sim.snapshot(this.tick()), this.tick());
    }
  }
}

const writesOf = (points: readonly [number, number][], color = RED, prefix = 'projet/modele@1'): PixelWrite[] =>
  points.map(([x, y]) => ({ taskId: `${prefix}:${x},${y}:#${color.toString(16).padStart(6, '0')}` as TaskId, point: { x, y }, color }));

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof AttemptError ? error.code : String(error);
  }
}

describe('AttemptManager: life cycle', () => {
  const t = template(solid(3, 2));

  it('success: lease, start, finish; the energy of applied pixels is spent once under the attempt id', async () => {
    const w = new World(3, 2);
    await w.manager.recover(w.now);
    w.observe(A1);
    w.sim.set(1, 0, RED);
    const done = await w.cycle(prepareTemplateSync(t), A1);
    expect(done).toMatchObject({ state: 'finished', energyCost: 5 });
    expect(done!.results.map((r) => r.result)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    expect(w.resources.recordedSpends(A1)).toEqual([{ operationId: done!.attemptId, energy: 5, at: done!.closedAt }]);
    expect(w.manager.inFlight().size).toBe(0);
    expect(w.manager.committedEnergy(A1)).toBe(0);
    expect(w.history.entries).toEqual([expect.objectContaining({ attemptId: done!.attemptId, state: 'finished', applied: 5, revision: 1 })]);
    expect(w.journal.events.map((e) => e.type)).toEqual(['leased', 'started', 'finished']);
    // Template fully correct now: nothing to do.
    expect(w.plan(prepareTemplateSync(t), A1).status).toBe('nothing-to-do');
  });

  it('failure: only applied pixels are spent; rejected ones stay to do', async () => {
    const w = new World(3, 2);
    await w.manager.recover(w.now);
    w.observe(A1, 10, [RED]);
    const leased = await w.lease(t, A1, writesOf([[0, 0], [1, 0], [2, 0]]));
    await w.manager.start(leased.attemptId, w.tick());
    const failed = await w.manager.fail(leased.attemptId, 'rate limited', [{ taskId: leased.writes[0]!.taskId, status: 'applied' }, { taskId: leased.writes[1]!.taskId, status: 'rejected', reason: 'rate-limited' }], w.tick());
    expect(failed).toMatchObject({ state: 'failed', reason: 'rate limited' });
    expect(w.resources.recordedSpends(A1).map((s) => s.energy)).toEqual([1]);
    // The third pixel has no outcome: its spending is unknown.
    expect(w.manager.resourcesUncertainSince(A1)).toBe(failed.closedAt);
    expect(w.history.entries.at(-1)).toMatchObject({ state: 'failed', applied: 1, rejected: 1 });
  });

  it('cancellation: only an attempt never started; a started one cannot be cancelled', async () => {
    const w = new World(3, 2);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    expect(await w.manager.cancel(a.attemptId, 'user', w.tick())).toMatchObject({ state: 'cancelled', reason: 'user' });
    const b = await w.lease(t, A1, writesOf([[0, 0]]));
    await w.manager.start(b.attemptId, w.tick());
    expect(await code(w.manager.cancel(b.attemptId, 'user', w.tick()))).toBe('INVALID_TRANSITION');
    expect(await code(w.manager.finish(a.attemptId, [], w.tick()))).toBe('INVALID_INPUT');
    expect(w.resources.recordedSpends(A1)).toEqual([]);
  });

  it('refuses to act before the journal was replayed', async () => {
    const w = new World(3, 2);
    w.observe(A1);
    expect(await code(w.lease(t, A1, writesOf([[0, 0]])))).toBe('NOT_RECOVERED');
  });

  it('validates the outcomes against the attempt tasks', async () => {
    const w = new World(3, 2);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0], [1, 0]]));
    await w.manager.start(a.attemptId, w.tick());
    const [first, second] = a.writes;
    expect(await code(w.manager.finish(a.attemptId, [{ taskId: first!.taskId, status: 'applied' }], w.tick()))).toBe('INVALID_INPUT');
    expect(await code(w.manager.finish(a.attemptId, [{ taskId: 'x' as TaskId, status: 'applied' }, { taskId: second!.taskId, status: 'applied' }], w.tick()))).toBe('INVALID_INPUT');
    expect(await code(w.manager.finish(a.attemptId, [{ taskId: first!.taskId, status: 'applied' }, { taskId: first!.taskId, status: 'applied' }], w.tick()))).toBe('INVALID_INPUT');
    expect(w.manager.get(a.attemptId)?.state).toBe('started');
  });
});

describe('AttemptManager: leases', () => {
  const t = template(solid(4, 1));
  const other = template(solid(4, 1, GREEN), 'autre', 3);

  it('already reserved: a batch with one point in flight is refused entirely (any template, revision or agent)', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    w.observe(A2);
    await w.lease(t, A1, writesOf([[0, 0], [1, 0]]));
    const before = w.journal.events.length;
    expect(await code(w.lease(other, A2, [...writesOf([[2, 0]], GREEN, 'projet/autre@3'), ...writesOf([[1, 0]], GREEN, 'projet/autre@3')]))).toBe('OVERLAP');
    expect(w.journal.events.length).toBe(before);
    expect(await code(w.lease(other, A2, writesOf([[2, 0], [3, 0]], GREEN, 'projet/autre@3')))).toBe('resolved');
    expect([...w.manager.inFlight()].sort()).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('refuses a batch with a point or a task twice', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    expect(await code(w.lease(t, A1, writesOf([[0, 0], [0, 0]])))).toBe('INVALID_INPUT');
    const [a, b] = writesOf([[0, 0], [1, 0]]);
    expect(await code(w.lease(t, A1, [a!, { ...b!, taskId: a!.taskId }]))).toBe('INVALID_INPUT');
    expect(await code(w.lease(t, A1, []))).toBe('INVALID_INPUT');
  });

  it('insufficient energy: the energy of open attempts is committed', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1, 3);
    await w.lease(t, A1, writesOf([[0, 0], [1, 0]]));
    expect(w.manager.committedEnergy(A1)).toBe(2);
    expect(await code(w.lease(t, A1, writesOf([[2, 0], [3, 0]])))).toBe('INSUFFICIENT_ENERGY');
    expect(await code(w.lease(t, A1, writesOf([[2, 0]])))).toBe('resolved');
    // The planner sees the same budget: nothing affordable.
    expect(w.plan(prepareTemplateSync(t), A1)).toMatchObject({ status: 'waiting', budget: 0 });
  });

  it('unavailable color and unavailable agent are refused', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1, 10, [GREEN]);
    expect(await code(w.lease(t, A1, writesOf([[0, 0]])))).toBe('COLOR_LOCKED');
    expect(w.plan(prepareTemplateSync(t), A1)).toMatchObject({ status: 'nothing-to-do', unavailableColors: [{ color: RED, pixels: 4 }] });
    w.resources.observe({ ...w.sim.observe(A1, w.tick()), unlockedColors: [RED], availability: { status: 'unavailable', until: null } });
    expect(await code(w.lease(t, A1, writesOf([[0, 0]])))).toBe('AGENT_UNAVAILABLE');
  });

  it('concurrent duplication: of two simultaneous overlapping leases exactly one wins', async () => {
    for (let round = 0; round < 20; round++) {
      const w = new World(4, 1);
      await w.manager.recover(w.now);
      w.observe(A1);
      w.observe(A2);
      const now = w.tick();
      const results = await Promise.allSettled([
        w.manager.lease({ agent: A1, projectId: PROJECT, templateId: t.id, revision: 1, writes: writesOf([[0, 0], [1, 0]]), now, ttlMs: 1000 }),
        w.manager.lease({ agent: A2, projectId: PROJECT, templateId: t.id, revision: 1, writes: writesOf([[1, 0], [2, 0]]), now, ttlMs: 1000 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(w.journal.events.filter((e) => e.type === 'leased')).toHaveLength(1);
    }
  });

  it('expired lease: never started after expiry; expire() cancels leased, sends started to reconciliation', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]), 100);
    const b = await w.lease(t, A1, writesOf([[1, 0]]), 100);
    await w.manager.start(b.attemptId, w.tick());
    w.tick(200);
    expect(await code(w.manager.start(a.attemptId, w.now))).toBe('LEASE_EXPIRED');
    const changed = await w.manager.expire(w.now);
    expect(changed.map((c) => [c.attemptId, c.state])).toEqual([
      [a.attemptId, 'cancelled'],
      [b.attemptId, 'needs-reconciliation'],
    ]);
    // Still in flight until reconciled: never offered again blindly.
    expect([...w.manager.inFlight()]).toEqual(['1,0']);
    expect(w.manager.resourcesUncertainSince(A1)).toBe(w.now);
  });

  it('revision change: never-started attempts of older revisions are cancelled, started ones reconciled', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    const b = await w.lease(t, A1, writesOf([[1, 0]]));
    const c = await w.lease(other, A1, writesOf([[2, 0]], GREEN, 'projet/autre@3'));
    await w.manager.start(b.attemptId, w.tick());
    const changed = await w.manager.revisionChanged(PROJECT, t.id, 2, w.tick());
    expect(changed.map((x) => [x.attemptId, x.state])).toEqual([
      [a.attemptId, 'cancelled'],
      [b.attemptId, 'needs-reconciliation'],
    ]);
    expect(w.manager.get(c.attemptId)?.state).toBe('leased');
    // The planner of revision 2 does not offer the point still uncertain.
    const plan = w.plan(prepareTemplateSync(template(solid(4, 1), 'modele', 2)), A1);
    expect(plan.refusals.map((r) => r.code)).toEqual(['RESOURCES_UNCERTAIN']);
  });
});

describe('AttemptManager: uncertain results', () => {
  const t = template(solid(3, 1));

  it('an unknown outcome makes the resources uncertain until a newer observation', async () => {
    const w = new World(3, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0], [1, 0]]));
    await w.manager.start(a.attemptId, w.tick());
    const closed = await w.manager.finish(a.attemptId, [{ taskId: a.writes[0]!.taskId, status: 'applied' }, { taskId: a.writes[1]!.taskId, status: 'unknown' }], w.tick());
    expect(w.manager.resourcesUncertainSince(A1)).toBe(closed.closedAt);
    expect(await code(w.lease(t, A1, writesOf([[2, 0]])))).toBe('RESOURCES_UNCERTAIN');
    expect(w.plan(prepareTemplateSync(t), A1).refusals.map((r) => r.code)).toEqual(['RESOURCES_UNCERTAIN']);
    w.observe(A1);
    expect(await code(w.lease(t, A1, writesOf([[2, 0]])))).toBe('resolved');
  });

  it('a lost answer is reconciled from a fresh read: observed results, never "applied", spend not assumed', async () => {
    const w = new World(3, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    w.sim.faults.push('answer-lost');
    const done = await w.cycle(prepareTemplateSync(t), A1);
    expect(done).toMatchObject({ state: 'finished' });
    expect(done!.results.map((r) => r.result)).toEqual(['observed-correct', 'observed-correct', 'observed-correct']);
    expect(w.resources.recordedSpends(A1)).toEqual([]);
    expect(w.history.entries.at(-1)).toMatchObject({ state: 'reconciled', observedCorrect: 3, applied: 0 });
    expect(w.plan(prepareTemplateSync(t), A1).refusals.map((r) => r.code)).toEqual(['RESOURCES_UNCERTAIN']);
  });

  it('a write that failed before applying is reconciled as observed-incorrect and planned again by a NEW attempt', async () => {
    const w = new World(3, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    w.sim.faults.push('before-apply');
    const first = await w.cycle(prepareTemplateSync(t), A1);
    expect(first!.results.map((r) => r.result)).toEqual(['observed-incorrect', 'observed-incorrect', 'observed-incorrect']);
    w.observe(A1);
    const second = await w.cycle(prepareTemplateSync(t), A1);
    expect(second!.attemptId).not.toBe(first!.attemptId);
    // Same deterministic task ids, new attempt id.
    expect(second!.writes.map((x) => x.taskId)).toEqual(first!.writes.map((x) => x.taskId));
    expect(second!.results.every((r) => r.result === 'applied')).toBe(true);
    expect([...w.sim.appliedAt.values()]).toEqual([1, 1, 1]);
  });

  it('reconciliation needs a read taken after the start; unknown pixels stay observed-unknown', async () => {
    const w = new World(3, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const leased = await w.lease(t, A1, writesOf([[0, 0], [5, 0]]));
    const a = await w.manager.start(leased.attemptId, w.tick());
    expect(await code(w.manager.reconcile(a.attemptId, w.sim.snapshot(a.startedAt!), w.tick()))).toBe('STALE_SNAPSHOT');
    const r = await w.manager.reconcile(a.attemptId, w.sim.snapshot(w.tick()), w.tick());
    expect(r.results.map((x) => x.result)).toEqual(['observed-incorrect', 'observed-unknown']);
    expect(await code(w.manager.reconcile(a.attemptId, w.sim.snapshot(w.tick()), w.tick()))).toBe('INVALID_TRANSITION');
  });

  it('a pixel incorrect again after processing is planned again', async () => {
    const w = new World(3, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const prepared = prepareTemplateSync(t);
    await w.cycle(prepared, A1);
    expect(w.plan(prepared, A1).status).toBe('nothing-to-do');
    w.sim.set(1, 0, GREEN);
    w.observe(A1);
    const again = await w.cycle(prepared, A1);
    expect(again!.writes.map((x) => x.point)).toEqual([{ x: 1, y: 0 }]);
  });
});

describe('AttemptManager: recovery', () => {
  const t = template(solid(4, 1));

  it('restart after interruption: never-started leases are released, started ones reconciled, the rest replanned', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const leased = await w.lease(t, A1, writesOf([[0, 0]]));
    const started = await w.lease(t, A1, writesOf([[1, 0]]));
    await w.manager.start(started.attemptId, w.tick());
    await w.sim.applyPixels(A1, started.writes, { attemptId: started.attemptId }); // applied, then "crash"
    const done = await w.lease(t, A1, writesOf([[2, 0]]));
    await w.manager.start(done.attemptId, w.tick());
    await w.manager.finish(done.attemptId, (await w.sim.applyPixels(A1, done.writes, { attemptId: done.attemptId })).outcomes, w.tick());

    // Restart: a new manager over the same journal, a ResourceManager that knows nothing.
    w.manager = w.newManager();
    const report = await w.manager.recover(w.tick());
    expect(report).toEqual({ released: [leased.attemptId], toReconcile: [started.attemptId], discardedTailBytes: 0, corruptLines: [], inconsistentEvents: 0 });
    expect(w.manager.get(leased.attemptId)?.state).toBe('cancelled');
    expect(w.manager.get(done.attemptId)?.state).toBe('finished');
    expect([...w.manager.inFlight()]).toEqual(['1,0']);
    const reconciled = await w.manager.reconcile(started.attemptId, w.sim.snapshot(w.tick()), w.tick());
    expect(reconciled.results).toEqual([{ taskId: started.writes[0]!.taskId, result: 'observed-correct' }]);
    // Only the needed work is planned again: (0,0) and (3,0).
    w.observe(A1);
    const plan = w.plan(prepareTemplateSync(t), A1);
    expect(plan.writes.map((x) => x.point.x)).toEqual([0, 3]);
    expect([...w.sim.appliedAt.entries()].sort()).toEqual([['1,0', 1], ['2,0', 1]]);
  });

  it('recovery is idempotent: a second restart finds nothing more to release', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    const b = await w.lease(t, A1, writesOf([[1, 0]]));
    await w.manager.start(b.attemptId, w.tick());
    w.manager = w.newManager();
    const first = await w.manager.recover(w.tick());
    w.manager = w.newManager();
    const second = await w.manager.recover(w.tick());
    expect(first).toMatchObject({ released: [a.attemptId], toReconcile: [b.attemptId] });
    expect(second).toMatchObject({ released: [], toReconcile: [b.attemptId] });
    expect(w.journal.events.filter((e) => e.type === 'needs-reconciliation')).toHaveLength(1);
  });

  it('corrupt journal: damage before the end is reported and every open attempt goes to reconciliation', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    const b = await w.lease(t, A1, writesOf([[1, 0]]));
    await w.manager.start(b.attemptId, w.tick());
    const text = w.journal.events.map(encodeJournalLine).join('');
    const bytes = new TextEncoder().encode(text);
    bytes[text.indexOf('"started"') + 3]! ^= 0x01; // damage the "started" line
    const decoded = decodeJournal(bytes);
    expect(decoded.corruptLines).toEqual([3]);
    const journal = { events: [] as JournalEvent[], load: async () => decoded, append: async (e: JournalEvent) => void journal.events.push(e) };
    const manager = createAttemptManager({ journal, history: createMemoryHistory(), resources: createResourceManager(R), newAttemptId: () => 'x' as never });
    const report = await manager.recover(w.tick());
    // "started" was lost: b looks leased, but it may have been sent; nothing is released.
    expect(report).toMatchObject({ released: [], toReconcile: [a.attemptId, b.attemptId], corruptLines: [3] });
    expect(manager.resourcesUncertainSince(A1)).not.toBeNull();
  });

  it('a torn last line is ignored and is not damage', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    const full = w.journal.events.map(encodeJournalLine).join('') + encodeJournalLine({ type: 'started', attemptId: a.attemptId, at: w.tick() }).slice(0, 20);
    const decoded = decodeJournal(new TextEncoder().encode(full));
    expect(decoded).toMatchObject({ discardedTailBytes: 20, corruptLines: [] });
    const manager = createAttemptManager({ journal: { load: async () => decoded, append: async () => undefined }, history: createMemoryHistory(), resources: createResourceManager(R), newAttemptId: () => 'x' as never });
    // The torn "started" was never durable, so the write was never sent (start is journaled before it).
    expect(await manager.recover(w.tick())).toMatchObject({ released: [a.attemptId], toReconcile: [] });
  });

  it('inconsistent events (valid lines, invalid transitions) are counted and treated as damage', async () => {
    const w = new World(4, 1);
    await w.manager.recover(w.now);
    w.observe(A1);
    const a = await w.lease(t, A1, writesOf([[0, 0]]));
    w.journal.events.push({ type: 'finished', attemptId: 'inconnu' as never, at: w.tick(), outcomes: [] });
    w.manager = w.newManager();
    expect(await w.manager.recover(w.tick())).toMatchObject({ released: [], toReconcile: [a.attemptId], inconsistentEvents: 1 });
  });

  it('fault injection: a journal append that fails leaves the attempt in its previous state', async () => {
    const steps = ['leased', 'started', 'finished'] as const;
    for (const failing of steps) {
      const w = new World(4, 1);
      const inner = createMemoryJournal();
      let armed = false;
      const journal = Object.assign(inner, {
        append: async (e: JournalEvent) => {
          if (armed && e.type === failing) throw new Error('disk full');
          inner.events.push(JSON.parse(JSON.stringify(e)) as JournalEvent);
        },
      });
      w.manager = createAttemptManager({ journal, history: w.history, resources: w.resources, newAttemptId: () => `f-${failing}` as never });
      await w.manager.recover(w.now);
      w.observe(A1);
      armed = true;
      const writes = writesOf([[0, 0]]);
      const leased = await w.lease(t, A1, writes).catch(() => null);
      if (failing === 'leased') {
        expect(leased).toBeNull();
        expect(w.manager.inFlight().size).toBe(0);
        continue;
      }
      const started = await w.manager.start(leased!.attemptId, w.tick()).catch(() => null);
      if (failing === 'started') {
        // Not journaled as started: the caller must not write; the lease is still held.
        expect(started).toBeNull();
        expect(w.manager.get(leased!.attemptId)?.state).toBe('leased');
        continue;
      }
      const result = await w.sim.applyPixels(A1, writes, { attemptId: leased!.attemptId });
      expect(await w.manager.finish(leased!.attemptId, result.outcomes, w.tick()).catch(() => null)).toBeNull();
      expect(w.manager.get(leased!.attemptId)?.state).toBe('started');
      expect(w.resources.recordedSpends(A1)).toEqual([]);
      // After a restart the attempt is reconciled, not resent.
      w.manager = createAttemptManager({ journal: inner, history: w.history, resources: w.resources, newAttemptId: () => 'g' as never });
      expect(await w.manager.recover(w.tick())).toMatchObject({ toReconcile: [leased!.attemptId] });
    }
  });
});

describe('state machine', () => {
  const base: Attempt = {
    attemptId: 'a' as never,
    agent: A1,
    projectId: PROJECT,
    templateId: 'm' as TemplateId,
    revision: 1,
    writes: writesOf([[0, 0]]),
    energyCost: 1,
    state: 'leased',
    leasedAt: 0,
    expiresAt: 10,
    startedAt: null,
    closedAt: null,
    results: [],
    reason: null,
  };
  const event = (type: JournalEvent['type']): JournalEvent =>
    type === 'leased'
      ? { type, attempt: base }
      : type === 'finished' || type === 'failed'
        ? ({ type, attemptId: base.attemptId, at: 1, outcomes: [], reason: 'r' } as JournalEvent)
        : type === 'reconciled'
          ? { type, attemptId: base.attemptId, at: 1, results: [] }
          : ({ type, attemptId: base.attemptId, at: 1, reason: 'r' } as JournalEvent);

  it('only the documented transitions are allowed; closed states are final', () => {
    const allowed: Record<string, readonly string[]> = {
      leased: ['started', 'failed', 'cancelled', 'needs-reconciliation'],
      started: ['finished', 'failed', 'needs-reconciliation', 'reconciled'],
      'needs-reconciliation': ['reconciled'],
      finished: [],
      failed: [],
      cancelled: [],
    };
    const types = ['started', 'finished', 'failed', 'cancelled', 'needs-reconciliation', 'reconciled'] as const;
    for (const [state, ok] of Object.entries(allowed)) {
      for (const type of types) {
        const next = transition({ ...base, state: state as Attempt['state'] }, event(type));
        expect({ state, type, ok: typeof next !== 'string' }).toEqual({ state, type, ok: ok.includes(type) });
      }
    }
    expect(typeof transition(base, event('leased'))).toBe('string');
    expect(typeof transition(undefined, event('started'))).toBe('string');
  });
});

describe('several simulated agents sharing one project (properties)', () => {
  it('never two open attempts on a point, no pixel applied twice, eligible work conserved, the canvas converges', async () => {
    const next = testRandom(0x1b6);
    const random = (): number => next(1_000_000) / 1_000_000;
    for (let run = 0; run < 25; run++) {
      const width = 3 + Math.floor(random() * 6);
      const height = 2 + Math.floor(random() * 5);
      const colors = [RED, GREEN, BLUE];
      const t = template(image(width, height, () => (random() < 0.15 ? null : colors[Math.floor(random() * 3)]!)), 'modele', 1, { id: random() < 0.5 ? 'random' : 'center-out', ...(random() < 0.5 ? {} : { seed: 7 }) } as StrategyConfig);
      const prepared = prepareTemplateSync(t);
      const w = new World(width, height, { idempotent: random() < 0.5 });
      // Some pixels already correct, some wrong.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (random() < 0.3) w.sim.set(x, y, colors[Math.floor(random() * 3)]!);
      await w.manager.recover(w.now);
      const agents = [A1, A2, 'agent-3' as AgentId];
      for (const a of agents) w.observe(a, 3);
      const initiallyWrong = countWrong(t, w.sim);
      for (let step = 0; step < 400 && countWrong(t, w.sim) > 0; step++) {
        const agent = agents[Math.floor(random() * agents.length)]!;
        if (random() < 0.08) w.sim.faults.push((random() < 0.5 ? 'before-apply' : 'answer-lost') as WriteFault);
        if (random() < 0.05) {
          // Crash: a new manager replays the journal; uncertain attempts are reconciled.
          w.manager = w.newManager();
          const report = await w.manager.recover(w.tick());
          for (const id of report.toReconcile) await w.manager.reconcile(id, w.sim.snapshot(w.tick()), w.tick());
        }
        // Interleave: lease for one agent while another one's attempt is open.
        const plan = w.plan(prepared, agent, 1 + Math.floor(random() * 4));
        if (plan.status === 'refused' || plan.status === 'waiting') {
          w.observe(agent, 3);
          continue;
        }
        if (plan.status !== 'ok') continue;
        const open = w.manager.inFlight();
        expect(plan.writes.some((x) => open.has(`${x.point.x},${x.point.y}`))).toBe(false);
        const leased = await w.lease(t, agent, plan.writes);
        await w.manager.start(leased.attemptId, w.tick());
        try {
          const result = await w.sim.applyPixels(agent, leased.writes, { attemptId: leased.attemptId });
          await w.manager.finish(leased.attemptId, result.outcomes, w.tick());
        } catch (error) {
          if (!(error instanceof SimulatedWriteError)) throw error;
          await w.manager.reconcile(leased.attemptId, w.sim.snapshot(w.tick()), w.tick());
        }
        // Points of open attempts are pairwise distinct.
        const points = w.manager.open().flatMap((a) => a.writes.map((x) => `${x.point.x},${x.point.y}`));
        expect(new Set(points).size).toBe(points.length);
      }
      expect({ run, wrong: countWrong(t, w.sim) }).toEqual({ run, wrong: 0 });
      // Each pixel was applied at most once (nobody repaints it here) and only eligible ones.
      expect([...w.sim.appliedAt.values()].every((n) => n === 1)).toBe(true);
      expect(w.sim.appliedAt.size).toBe(initiallyWrong);
      // Spends recorded once per attempt id, for applied pixels only.
      for (const a of agents) {
        const ids = w.resources.recordedSpends(a).map((s) => s.operationId);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});

function countWrong(t: Template, sim: SimCanvas): number {
  let wrong = 0;
  for (let iy = 0; iy < t.image.height; iy++) {
    for (let ix = 0; ix < t.image.width; ix++) {
      const e = t.image.pixels[iy * t.image.width + ix]!;
      if (e !== 0xffffffff && sim.at(ix, iy) !== e) wrong++;
    }
  }
  return wrong;
}
