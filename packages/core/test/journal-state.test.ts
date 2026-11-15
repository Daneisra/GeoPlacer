import { describe, expect, it } from 'vitest';
import type { AgentId, AttemptJournal, AttemptManager, CompactionReport, JournalEvent, JournalState, PixelWrite, ProjectId, TaskId, TemplateId } from '../src/index.js';
import { AttemptError, JournalStateBuilder, createAttemptManager, createMemoryHistory, createMemoryJournal, createResourceManager, replayJournal } from '../src/index.js';
import { RED, SIMULATED_RULES as R } from './helpers/resources.js';
import { SimCanvas } from './helpers/sim-canvas.js';
import { testRandom } from './helpers/strategy.js';

const PROJECT = 'projet' as ProjectId;
const TEMPLATE = 'modele' as TemplateId;
const AGENTS = ['agent-1', 'agent-2'] as AgentId[];

/** A memory journal that also records every appended event (the reference "full journal"). */
function recordingJournal(): { journal: ReturnType<typeof createMemoryJournal>; all: { event: JournalEvent; seq: number }[] } {
  const journal = createMemoryJournal();
  const all: { event: JournalEvent; seq: number }[] = [];
  const append = journal.append.bind(journal);
  journal.append = async (event: JournalEvent) => {
    const seq = await append(event);
    all.push({ event: JSON.parse(JSON.stringify(event)) as JournalEvent, seq });
    return seq;
  };
  return { journal, all };
}


/** Loads a journal into a builder without a manager (no recovery side effects). */
async function stateOf(journal: AttemptJournal): Promise<JournalState> {
  let builder = new JournalStateBuilder();
  await journal.load({ checkpoint: (s) => (builder = JournalStateBuilder.from(s)), event: (e, seq) => void builder.apply(e, seq) });
  return builder.toState();
}

interface Run {
  manager: AttemptManager;
  readonly journal: ReturnType<typeof createMemoryJournal>;
  readonly all: { event: JournalEvent; seq: number }[];
  readonly compactions: CompactionReport[];
  now: number;
}

/**
 * Drives a manager through random operations on a local simulated canvas;
 * `compactEvery` > 0 compacts at random steps (same random draws either way,
 * so two runs with the same seed produce the same events).
 */
async function drive(seed: number, steps: number, compact: boolean, crashes: boolean): Promise<Run> {
  const next = testRandom(seed);
  const random = (): number => next(1_000_000) / 1_000_000;
  const { journal, all } = recordingJournal();
  const resources = createResourceManager(R);
  const sim = new SimCanvas({ minX: 0, minY: 0, width: 6, height: 4 }, true);
  let ids = 0;
  const make = (): AttemptManager => createAttemptManager({ journal, history: createMemoryHistory(), resources, newAttemptId: () => `a-${++ids}` as never });
  const run: Run = { manager: make(), journal, all, compactions: [], now: 1_000_000 };
  const tick = (): number => ++run.now;
  await run.manager.recover(tick());
  const observe = (agent: AgentId): void => {
    sim.energy.set(agent, 8);
    sim.unlocked.set(agent, [RED]);
    resources.observe(sim.observe(agent, tick()));
  };
  for (const a of AGENTS) observe(a);
  for (let step = 0; step < steps; step++) {
    const r = random();
    const doCompact = random() < 0.08;
    const doCrash = random() < 0.04;
    const open = run.manager.open();
    try {
      if (r < 0.35) {
        const agent = AGENTS[Math.floor(random() * 2)]!;
        const x = Math.floor(random() * 6);
        const y = Math.floor(random() * 4);
        const writes: PixelWrite[] = [{ taskId: `t-${x},${y}-${step}` as TaskId, point: { x, y }, color: RED }];
        observe(agent);
        await run.manager.lease({ agent, projectId: PROJECT, templateId: TEMPLATE, revision: 1, writes, now: tick(), ttlMs: 40 });
      } else if (r < 0.55 && open.some((a) => a.state === 'leased')) {
        const a = open.find((x) => x.state === 'leased')!;
        await run.manager.start(a.attemptId, tick());
      } else if (r < 0.75 && open.some((a) => a.state === 'started')) {
        const a = open.find((x) => x.state === 'started')!;
        const result = await sim.applyPixels(a.agent, a.writes, { attemptId: a.attemptId });
        if (random() < 0.5) await run.manager.finish(a.attemptId, result.outcomes, tick());
        else await run.manager.fail(a.attemptId, 'simulated', result.outcomes.slice(0, 0), tick());
      } else if (r < 0.85) {
        for (const a of await run.manager.expire(tick() + 30)) if (a.state === 'needs-reconciliation') await run.manager.reconcile(a.attemptId, sim.snapshot(run.now + 100), tick() + 100);
        run.now += 200;
      } else if (r < 0.9 && open.some((a) => a.state === 'leased')) {
        await run.manager.cancel(open.find((x) => x.state === 'leased')!.attemptId, 'user', tick());
      }
    } catch (error) {
      if (!(error instanceof AttemptError)) throw error;
    }
    if (compact && doCompact) run.compactions.push(await run.manager.compact(tick()));
    else if (doCompact) tick();
    if (crashes && doCrash) {
      run.manager = make();
      const report = await run.manager.recover(tick());
      for (const id of report.toReconcile) await run.manager.reconcile(id, sim.snapshot(run.now + 100), tick() + 100);
      run.now += 200;
      for (const a of AGENTS) observe(a);
    } else if (doCrash) {
      tick();
      tick();
    }
  }
  return run;
}

describe('rebuild from a checkpoint = rebuild from the full journal', () => {
  it('A (full journal) and B (checkpoint + later events) give the same logical state, over many compaction cycles', async () => {
    let cycles = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const run = await drive(seed, 150, true, true);
      cycles += run.compactions.length;
      const a = replayJournal(null, run.all);
      const b = await stateOf(run.journal);
      expect(a.inconsistent).toBe(0);
      expect(b).toEqual(a.state);
      expect(b).toEqual(run.manager.state());
    }
    expect(cycles).toBeGreaterThan(50);
  });

  it('a manager recovered from the compacted journal behaves like one recovered from the full journal', async () => {
    for (let seed = 30; seed < 45; seed++) {
      const compacted = await drive(seed, 120, true, false);
      const full = await drive(seed, 120, false, false);
      expect(full.all).toEqual(compacted.all); // same events either way
      expect(compacted.compactions.length).toBeGreaterThan(0);
      const recoverOn = async (journal: AttemptJournal) => {
        const m = createAttemptManager({ journal, history: createMemoryHistory(), resources: createResourceManager(R), newAttemptId: () => 'x' as never });
        const report = await m.recover(5_000_000);
        return {
          report: { released: report.released, toReconcile: report.toReconcile, damaged: report.damaged, inconsistentEvents: report.inconsistentEvents },
          state: m.state(),
          inFlight: [...m.inFlight()].sort(),
          committed: AGENTS.map((a) => m.committedEnergy(a)),
          uncertain: AGENTS.map((a) => m.resourcesUncertainSince(a)),
        };
      };
      const x = await recoverOn(compacted.journal);
      const y = await recoverOn(full.journal);
      expect({ ...x, state: { ...x.state, lastSeq: 0 } }).toEqual({ ...y, state: { ...y.state, lastSeq: 0 } });
      expect(x.state.lastSeq).toBe(y.state.lastSeq);
    }
  });

  it('compaction keeps leased, started and needs-reconciliation attempts open and their guarantees after a restart', async () => {
    const { journal } = recordingJournal();
    const resources = createResourceManager(R);
    const m = createAttemptManager({ journal, history: createMemoryHistory(), resources, newAttemptId: (() => { let n = 0; return () => `k-${++n}` as never; })() });
    await m.recover(1);
    resources.observe({ type: 'resource-observation', agent: AGENTS[0]!, observedAt: 2, energy: 10, currency: 0, unlockedColors: [RED], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
    const w = (x: number): PixelWrite[] => [{ taskId: `t${x}` as TaskId, point: { x, y: 0 }, color: RED }];
    const leased = await m.lease({ agent: AGENTS[0]!, projectId: PROJECT, templateId: TEMPLATE, revision: 1, writes: w(0), now: 3, ttlMs: 1000 });
    const started = await m.lease({ agent: AGENTS[0]!, projectId: PROJECT, templateId: TEMPLATE, revision: 1, writes: w(1), now: 4, ttlMs: 1000 });
    await m.start(started.attemptId, 5);
    const uncertain = await m.lease({ agent: AGENTS[0]!, projectId: PROJECT, templateId: TEMPLATE, revision: 1, writes: w(2), now: 6, ttlMs: 2 });
    await m.start(uncertain.attemptId, 7);
    await m.expire(9);
    const report = await m.compact(10);
    expect(report).toMatchObject({ openAttempts: 3, generation: 1 });
    expect(journal.events).toEqual([]);
    const restarted = createAttemptManager({ journal, history: createMemoryHistory(), resources: createResourceManager(R), newAttemptId: () => 'z' as never });
    const recovered = await restarted.recover(20);
    expect(recovered).toMatchObject({ fromCheckpoint: true, released: [leased.attemptId], toReconcile: [started.attemptId, uncertain.attemptId], damaged: false });
    expect([...restarted.inFlight()].sort()).toEqual(['1,0', '2,0']);
  });
});

describe('closed summaries, retention and uncertainty', () => {
  it('purged summaries keep their uncertainty: a stale observation is still refused after a restart', async () => {
    const run = await drive(99, 200, false, false);
    const before = run.manager.state();
    expect(before.closed.length).toBeGreaterThan(5);
    await run.manager.compact(run.now + 1, { maxClosedSummaries: 0 });
    const after = run.manager.state();
    expect(after.closed).toEqual([]);
    expect(after.purgedClosed).toBe(before.closed.length);
    expect(after.lastSpendAt).toEqual(before.lastSpendAt);
    const restarted = createAttemptManager({ journal: run.journal, history: createMemoryHistory(), resources: createResourceManager(R), newAttemptId: () => 'n' as never });
    await restarted.recover(run.now + 10);
    for (const { agent, at } of before.lastSpendAt) expect(restarted.resourcesUncertainSince(agent)).toBeGreaterThanOrEqual(at);
    expect(restarted.get(before.closed[0]!.attemptId)).toBeUndefined();
  });

  it('closed attempts are summaries (no pixels kept), open ones complete', async () => {
    const run = await drive(5, 100, false, false);
    for (const c of run.manager.state().closed) {
      expect(run.manager.get(c.attemptId)).toEqual(c);
      expect('writes' in c).toBe(false);
    }
    for (const o of run.manager.open()) expect(run.manager.get(o.attemptId)).toEqual(o);
  });
});

// Damage and coverage after damage (Phase 1B.8): see damage-coverage.test.ts.
