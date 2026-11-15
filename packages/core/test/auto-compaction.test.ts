/**
 * Phase 1B.8: automatic compaction of the attempt journal (policy,
 * refusals, failures) and its concurrency with journal writes.
 */

import { describe, expect, it } from 'vitest';
import type { AgentId, AttemptJournal, AttemptManager, AutoCompactionPolicy, JournalEvent, PixelWrite, ProjectId, TaskId, TemplateId } from '../src/index.js';
import { AttemptError, createAttemptManager, createMemoryHistory, createMemoryJournal, createResourceManager, replayJournal } from '../src/index.js';
import { RED, SIMULATED_RULES as R, observation } from './helpers/resources.js';

const A = 'agent-1' as AgentId;
const P = 'projet' as ProjectId;
const T = 'modele' as TemplateId;

interface Rig {
  journal: ReturnType<typeof createMemoryJournal>;
  manager: AttemptManager;
  all: { event: JournalEvent; seq: number }[];
  /** Appends seen while a compaction was running (must stay empty). */
  overlaps: string[];
  compactions: number;
  now: number;
}

/** A memory journal that records every event and detects an append or compaction overlapping a compaction. */
async function rig(policy: AutoCompactionPolicy | undefined, options: { freeBytes?: number | null; failCompaction?: 'throw' | 'unloaded' } = {}): Promise<Rig> {
  const journal = createMemoryJournal(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes });
  const r: Rig = { journal, manager: null as unknown as AttemptManager, all: [], overlaps: [], compactions: 0, now: 1_000 };
  let compacting = false;
  let unloaded = false;
  const wrapped: AttemptJournal = {
    load: (v) => journal.load(v),
    stats: async () => {
      if (unloaded) throw Object.assign(new Error('not loaded'), { code: 'NOT_LOADED' });
      return journal.stats();
    },
    append: async (e) => {
      if (compacting) r.overlaps.push(`append ${e.type} during a compaction`);
      if (unloaded) throw Object.assign(new Error('not loaded'), { code: 'NOT_LOADED' });
      const seq = await journal.append(e);
      r.all.push({ event: JSON.parse(JSON.stringify(e)) as JournalEvent, seq });
      return seq;
    },
    compact: async (s) => {
      if (compacting) r.overlaps.push('two compactions at once');
      compacting = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 0)); // yield: give concurrent operations a chance to interleave
        if (options.failCompaction === 'throw') throw new Error('disk full');
        if (options.failCompaction === 'unloaded') {
          unloaded = true;
          throw new Error('publish interrupted');
        }
        r.compactions++;
        return await journal.compact(s);
      } finally {
        compacting = false;
      }
    },
  };
  const resources = createResourceManager(R);
  let ids = 0;
  r.manager = createAttemptManager({ journal: wrapped, history: createMemoryHistory(), resources, newAttemptId: () => `a-${++ids}` as never, ...(policy === undefined ? {} : { autoCompaction: policy }) });
  await r.manager.recover(r.now++);
  resources.observe(observation({ agent: A, observedAt: r.now++, energy: 1_000_000, unlockedColors: [RED] }));
  return r;
}

const w = (x: number, y = 0): PixelWrite[] => [{ taskId: `t-${x},${y}` as TaskId, point: { x, y }, color: RED }];

/** One complete attempt (lease, start, finish). */
async function cycle(r: Rig, x: number, y = 0): Promise<void> {
  const a = await r.manager.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: w(x, y), now: r.now++, ttlMs: 1e9 });
  await r.manager.start(a.attemptId, r.now++);
  await r.manager.finish(a.attemptId, [{ taskId: a.writes[0]!.taskId, status: 'applied' }], r.now++);
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof AttemptError ? error.code : String(error);
  }
}

describe('automatic compaction: policy', () => {
  it('compacts when the active generation reaches the event threshold, keeping the logical state', async () => {
    const r = await rig({ enabled: true, maxActiveEvents: 20 });
    for (let x = 0; x < 40; x++) await cycle(r, x);
    expect(r.manager.compactionStatus().automatic).toBeGreaterThanOrEqual(5);
    expect(r.journal.events.length).toBeLessThan(20);
    expect(r.journal.generation).toBe(r.manager.compactionStatus().automatic);
    expect(replayJournal(null, r.all).state).toEqual(r.manager.state());
  });

  it('disabled (diagnostics) or absent: never automatic', async () => {
    for (const policy of [{ enabled: false, maxActiveEvents: 1 }, undefined]) {
      const r = await rig(policy);
      for (let x = 0; x < 10; x++) await cycle(r, x);
      expect(r.manager.compactionStatus().automatic).toBe(0);
      expect(r.journal.generation).toBe(0);
    }
  });

  it('byte and age thresholds', async () => {
    const bytes = await rig({ enabled: true, maxActiveBytes: 2_000 });
    for (let x = 0; x < 10; x++) await cycle(bytes, x);
    expect(bytes.manager.compactionStatus().automatic).toBeGreaterThan(0);
    const age = await rig({ enabled: true, maxAgeMs: 50 });
    await cycle(age, 0);
    expect(age.manager.compactionStatus().automatic).toBe(0);
    age.now += 100;
    await cycle(age, 1);
    expect(age.manager.compactionStatus().automatic).toBe(1);
  });

  it('skipped, with the reason, when the open attempts are large or the free space is unknown or short', async () => {
    const big = await rig({ enabled: true, maxActiveEvents: 3, maxOpenWrites: 2 });
    for (let x = 10; x < 13; x++) await big.manager.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: w(x), now: big.now++, ttlMs: 1e9 });
    await cycle(big, 0);
    expect(big.manager.compactionStatus()).toMatchObject({ automatic: 0, lastProblem: { kind: 'skipped', reason: expect.stringMatching(/open attempts hold 3 pixels/) as string } });
    const unknown = await rig({ enabled: true, maxActiveEvents: 3, minFreeBytes: 1 }, { freeBytes: null });
    await cycle(unknown, 0);
    expect(unknown.manager.compactionStatus().lastProblem?.reason).toMatch(/free disk space unknown/);
    const short = await rig({ enabled: true, maxActiveEvents: 3, minFreeBytes: 1_000_000 }, { freeBytes: 500_000 });
    await cycle(short, 0);
    expect(short.manager.compactionStatus().lastProblem?.reason).toMatch(/not enough free disk space/);
    expect(short.journal.generation).toBe(0);
  });

  it('never on a damaged journal, never during the recovery', async () => {
    const base = createMemoryJournal();
    const damaged: AttemptJournal = { load: async (v) => ({ ...(await base.load(v)), corruptLines: [1] }), stats: () => base.stats(), append: (e) => base.append(e), compact: (s) => base.compact(s) };
    const resources = createResourceManager(R);
    const m = createAttemptManager({ journal: damaged, history: createMemoryHistory(), resources, newAttemptId: () => 'x' as never, autoCompaction: { enabled: true, maxActiveEvents: 1 } });
    await m.recover(1);
    expect(base.generation).toBe(0);
    expect(await code(m.compact(2))).toBe('JOURNAL_DAMAGED');
  });

  it('a failed compaction does not fail the operation; an unknown journal state stops every later operation', async () => {
    const failing = await rig({ enabled: true, maxActiveEvents: 3 }, { failCompaction: 'throw' });
    await cycle(failing, 0);
    expect(failing.manager.compactionStatus().lastProblem).toMatchObject({ kind: 'failed', reason: 'disk full' });
    expect(failing.manager.usable()).toBe(true);
    await cycle(failing, 1); // still working
    const lost = await rig({ enabled: true, maxActiveEvents: 3 }, { failCompaction: 'unloaded' });
    await cycle(lost, 0);
    expect(lost.manager.usable()).toBe(false);
    expect(await code(lost.manager.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: w(5), now: lost.now++, ttlMs: 10 }))).toBe('JOURNAL_UNAVAILABLE');
  });
});

describe('automatic compaction: concurrency with journal writes', () => {
  it('many concurrent operations with frequent compactions: no overlap, no lost event, the same state as the full journal', async () => {
    const r = await rig({ enabled: true, maxActiveEvents: 7 });
    // 60 attempts launched at once: leases, starts and finishes interleave with automatic compactions.
    await Promise.all(Array.from({ length: 60 }, (_, k) => cycle(r, k % 30, Math.floor(k / 30) + 1)));
    // A few left open across the compactions.
    const open = await Promise.all([40, 41, 42].map((x) => r.manager.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: w(x), now: r.now++, ttlMs: 1e9 })));
    await Promise.all(Array.from({ length: 20 }, (_, k) => cycle(r, 50 + k)));
    expect(r.overlaps).toEqual([]);
    expect(r.compactions).toBeGreaterThan(5);
    const reference = replayJournal(null, r.all);
    expect(reference.inconsistent).toBe(0);
    expect(reference.state).toEqual(r.manager.state());
    // A new process recovers the same reservations from checkpoint + tail.
    const resources = createResourceManager(R);
    const restarted = createAttemptManager({ journal: r.journal, history: createMemoryHistory(), resources, newAttemptId: () => 'z' as never });
    const report = await restarted.recover(r.now + 10);
    expect([...report.released].sort()).toEqual(open.map((a) => a.attemptId).sort());
    expect(report.fromCheckpoint).toBe(true);
  });
});
