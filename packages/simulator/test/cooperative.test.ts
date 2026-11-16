/**
 * Phase 1C.0: the cooperative scheduler (yields between the phases of a cycle and between slices
 * of its long computations). A deterministic yield hook injects an action at the k-th yield, for
 * many k spread over a whole run: an outside actor, a move of the template (new revision), a
 * pause, a stop with abort. Whatever k: nothing is applied twice, nothing is painted at the old
 * placement after a move, nothing is leased after a pause or a stop was asked, outside changes
 * are repainted, and the run ends with the canvas equal to the template.
 */

import { describe, expect, it } from 'vitest';
import type { CooperativeOptions, JournalEvent, SchedulerStatus, Template } from '@geoplacer/core';
import { BLUE, Engine, GREEN, RED, image, template, until } from './helpers/engine.js';

const flag = (w: number, h: number, revision = 1, at = { x: 2, y: 3 }): Template => template(image(w, h, (x, y) => ((x + y) % 2 === 0 ? RED : GREEN)), revision, at);

/** A yield hook calling `action(k)` at the k-th yield (no real event loop turn: deterministic). */
function hook(action: (k: number) => void, slicePixels = 6): CooperativeOptions & { count: number } {
  const o = {
    count: 0,
    slicePixels,
    async yieldTo() {
      o.count++;
      action(o.count);
    },
  };
  return o;
}

const leases = (events: readonly JournalEvent[]): number => events.filter((e) => e.type === 'leased').length;
const engineFor = (cooperative: CooperativeOptions, progressMode: 'full' | 'incremental' = 'incremental') =>
  new Engine(flag(12, 10), { cooperative, config: { progressMode, maxBatchSize: 7 }, energy: 60, capacity: 60 });

/**
 * Yields of a whole run, and k values spread over it (first, last, and about `n` between), plus
 * EVERY yield up to `dense` (the first cycles: each kind of yield point of a cycle is hit).
 */
function spread(total: number, n: number, dense = 0): number[] {
  const ks = new Set<number>([1, 2, 3, total]);
  for (let k = 1; k <= Math.min(dense, total); k++) ks.add(k);
  for (let i = 1; i <= n; i++) ks.add(Math.max(1, Math.round((i * total) / (n + 1))));
  return [...ks].filter((k) => k >= 1 && k <= total).sort((a, b) => a - b);
}

async function totalYields(): Promise<number> {
  const h = hook(() => undefined);
  const e = engineFor(h);
  await e.scheduler.start();
  expect((await e.scheduler.done()).state).toBe('completed');
  return h.count;
}

describe('cooperative scheduler (Phase 1C.0)', () => {
  it('with no-op yields, exactly the same run as without: same writes in the same order, same final state', async () => {
    for (const progressMode of ['full', 'incremental'] as const) {
      const runs: { applied: string[]; final: SchedulerStatus; yields: number }[] = [];
      for (const cooperative of [undefined, hook(() => undefined, 5)]) {
        const e = new Engine(flag(12, 10), { ...(cooperative === undefined ? {} : { cooperative }), config: { progressMode, maxBatchSize: 7 } });
        await e.scheduler.start();
        const final = await e.scheduler.done();
        runs.push({ applied: e.canvas.events.filter((x) => x.kind === 'applied').map((x) => `${x.point.x},${x.point.y}`), final, yields: cooperative?.count ?? 0 });
      }
      const [plain, sliced] = runs;
      expect(sliced!.applied, progressMode).toEqual(plain!.applied);
      expect({ ...sliced!.final, at: 0 }, progressMode).toEqual({ ...plain!.final, at: 0 });
      expect(sliced!.yields, progressMode).toBeGreaterThan(100);
    }
  });

  it('an outside actor at any yield: seen at the next canvas read and repainted, nothing applied twice by the agent', async () => {
    const total = await totalYields();
    let afterLastRead = 0;
    for (const k of spread(total, 24)) {
      let readsAtEdit = -1;
      let reads = 0;
      const e: Engine = engineFor(
        hook((n) => {
          if (n !== k) return;
          readsAtEdit = reads;
          // Erase two painted pixels (if any) and miscolor a third one.
          const painted = e.canvas.events.filter((x) => x.kind === 'applied').slice(0, 2);
          for (const p of painted) e.canvas.erase(p.point);
          e.canvas.paint({ x: 5, y: 6 }, BLUE);
        })
      );
      // Counts the canvas reads, to know whether one happened after the change.
      const reader = e.canvas.reader as { readRegion: (...a: never[]) => Promise<unknown> };
      const read = reader.readRegion.bind(reader);
      reader.readRegion = (...a: never[]) => (reads++, read(...a));
      await e.scheduler.start();
      let final = await e.scheduler.done();
      expect(final.state, `k ${k}`).toBe('completed');
      expect(readsAtEdit, `k ${k}`).toBeGreaterThanOrEqual(0);
      if (reads === readsAtEdit) {
        // The change came after the last read of this run (as if made just after the end):
        // it is seen by the next read, i.e. the next start.
        afterLastRead++;
        expect(e.wrong(), `k ${k}`).toBeGreaterThan(0);
        await e.scheduler.start();
        final = await e.scheduler.done();
      }
      expect(final, `k ${k}`).toMatchObject({ state: 'completed', correct: 120, incorrect: 0, unknown: 0 });
      expect(e.wrong(), `k ${k}`).toBe(0);
      expect(final.recentErrors.filter((x) => x.code === 'OVERLAP'), `k ${k}`).toEqual([]);
    }
    // Most changes land during the run (and only the last yields come after the last read).
    expect(afterLastRead).toBeLessThanOrEqual(2);
  });

  it('a move of the template (new revision) at any yield: nothing painted at the old placement afterwards', async () => {
    const total = await totalYields();
    for (const k of spread(total, 24)) {
      let movedAt = -1;
      const e: Engine = engineFor(
        hook((n) => {
          if (n !== k) return;
          movedAt = e.canvas.events.length;
          e.current = flag(12, 10, 2, { x: 30, y: 30 });
        })
      );
      await e.scheduler.start();
      const final = await e.scheduler.done();
      expect(movedAt, `k ${k}`).toBeGreaterThanOrEqual(0);
      expect(final, `k ${k}`).toMatchObject({ state: 'completed', revision: 2 });
      expect(e.wrong(), `k ${k}`).toBe(0);
      const late = e.canvas.events.slice(movedAt).filter((x) => x.kind === 'applied' && (x.point.x < 30 || x.point.y < 30));
      expect(late.map((x) => `${x.point.x},${x.point.y}`), `k ${k}: written at the old placement after the move`).toEqual([]);
    }
  });

  it('a pause at any yield: no lease after the request; resumed, the run finishes, nothing applied twice', async () => {
    const total = await totalYields();
    for (const k of spread(total, 24, 160)) {
      let paused = null as Promise<void> | null;
      let leasedAtRequest = -1;
      const e: Engine = engineFor(
        hook((n) => {
          if (n !== k) return;
          leasedAtRequest = leases(e.journal.events);
          paused = e.scheduler.pause();
        })
      );
      await e.scheduler.start();
      await until(() => paused !== null || e.scheduler.status().state === 'completed');
      if (paused === null) continue; // the run ended before the k-th yield in this mode
      await paused;
      expect(e.scheduler.status().state, `k ${k}`).toBe('paused');
      expect(leases(e.journal.events), `k ${k}: leased after the pause request`).toBe(leasedAtRequest);
      e.scheduler.resume();
      const final = await e.scheduler.done();
      expect(final.state, `k ${k}`).toBe('completed');
      expect(e.wrong(), `k ${k}`).toBe(0);
      expect(e.appliedTwice(), `k ${k}`).toBe(0);
    }
  });

  it('a stop with abort at any yield: stops at once, no lease after the request; a new process finishes it', async () => {
    const total = await totalYields();
    for (const k of spread(total, 24, 160)) {
      let stopped = null as Promise<SchedulerStatus> | null;
      let leasedAtRequest = -1;
      const e: Engine = engineFor(
        hook((n) => {
          if (n !== k) return;
          leasedAtRequest = leases(e.journal.events);
          stopped = e.scheduler.stop({ abort: true });
        })
      );
      await e.scheduler.start();
      await until(() => stopped !== null || e.scheduler.status().state === 'completed');
      if (stopped === null) continue;
      expect((await stopped).state, `k ${k}`).toBe('stopped');
      expect(leases(e.journal.events), `k ${k}: leased after the stop request`).toBe(leasedAtRequest);
      const next = e.startProcess();
      await next.start();
      const final = await next.done();
      expect(final.state, `k ${k}`).toBe('completed');
      expect(e.wrong(), `k ${k}`).toBe(0);
      expect(e.appliedTwice(), `k ${k}`).toBe(0);
    }
  });

  it('a journal compaction at any yield: it is never blocked by the computation, and the run is unchanged', async () => {
    // The journal is never awaited inside a sliced computation: a compaction asked at a yield runs
    // meanwhile (one at a time with the leases), and the run finishes with nothing applied twice.
    const total = await totalYields();
    for (const k of spread(total, 24)) {
      let compaction = null as Promise<unknown> | null;
      const e: Engine = engineFor(
        hook((n) => {
          if (n !== k) return;
          compaction = e.attempts.compact(e.clock.now());
        })
      );
      await e.scheduler.start();
      const final = await e.scheduler.done();
      await until(() => compaction !== null || final.state === 'completed');
      if (compaction !== null) await compaction;
      expect(final.state, `k ${k}`).toBe('completed');
      expect(final.recentErrors, `k ${k}`).toEqual([]);
      expect(e.wrong(), `k ${k}`).toBe(0);
      expect(e.appliedTwice(), `k ${k}`).toBe(0);
      // The compacted journal still describes the run: a new process recovers nothing to redo.
      const next = e.startProcess();
      await next.start();
      expect((await next.done()).state, `k ${k}`).toBe('completed');
      expect(e.appliedTwice(), `k ${k}`).toBe(0);
    }
  });

  it('refuses a slice size that is not a positive integer', () => {
    for (const slicePixels of [0, -1, 1.5, Number.NaN]) {
      expect(() => engineFor({ slicePixels, yieldTo: async () => undefined })).toThrow(/slicePixels/);
    }
  });
});
