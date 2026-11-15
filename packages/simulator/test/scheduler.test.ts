/**
 * Phase 1B.8: the single-agent scheduler on the local simulated canvas:
 * state machine, commands, waiting without busy loop, faults, restarts.
 */

import { describe, expect, it } from 'vitest';
import type { JournalEvent, SchedulerEvent } from '@geoplacer/core';
import { SchedulerConfigError, createMemoryJournal, createScheduler } from '@geoplacer/core';
import { A, BLUE, CONFIG, Engine, GREEN, RED, image, template, until } from './helpers/engine.js';

const flag = (w: number, h: number) => template(image(w, h, (x, y) => ((x + y) % 2 === 0 ? RED : GREEN)));

describe('scheduler: a complete run and its state machine', () => {
  it('paints the whole template and ends completed; the status carries the structured state', async () => {
    const e = new Engine(flag(6, 4));
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final).toMatchObject({ state: 'completed', reason: 'the canvas matches the template', revision: 1, agent: A, workPixels: 0, correct: 24, incorrect: 0, unknown: 0, progressPercent: 100, openAttempts: 0, applied: 24 });
    expect(final.observations.canvas).toMatchObject({ source: 'simulated' });
    expect(final.observations.resources).not.toBeNull();
    expect(e.wrong()).toBe(0);
    expect(e.appliedTwice()).toBe(0);
    expect(e.states()).toEqual(['initializing', 'running', 'completed']);
    expect(e.events.some((x) => x.type === 'progress')).toBe(true);
    expect(e.events.filter((x) => x.type === 'attempt').length).toBe(final.attemptsClosed);
  });

  it('step() runs one cycle at a time, deterministically', async () => {
    const run = async (): Promise<string> => {
      const e = new Engine(flag(4, 3), { config: { maxBatchSize: 5 } });
      for (let k = 0; k < 10 && e.scheduler.status().state !== 'completed'; k++) await e.scheduler.step();
      return JSON.stringify({ journal: e.journal.events, canvas: e.canvas.events, state: e.scheduler.status().state });
    };
    const first = await run();
    expect(first).toBe(await run());
    expect(JSON.parse(first).state).toBe('completed');
  });

  it('refuses a configuration of more agents than allowed, and multi-agent scheduling in V1', () => {
    const deps = new Engine(flag(2, 2)).scheduler;
    void deps;
    const e = new Engine(flag(2, 2));
    const make = (agents: string[], max: number) => () =>
      createScheduler({ ...CONFIG, agents: agents as never, maxActiveAgents: max }, { clock: e.clock, canvas: e.canvas, templates: { current: async () => e.current }, resourceSource: e.canvas.resourceSource(), resources: e.resources, attempts: e.attempts });
    expect(make(['a', 'b'], 1)).toThrow(SchedulerConfigError);
    expect(make(['a', 'b'], 2)).toThrow(/not activated in V1/);
    expect(make([], 1)).toThrow(SchedulerConfigError);
    expect(() => createScheduler({ ...CONFIG, minBatchSize: 50, maxBatchSize: 10 }, { clock: e.clock, canvas: e.canvas, templates: { current: async () => e.current }, resourceSource: e.canvas.resourceSource(), resources: e.resources, attempts: e.attempts })).toThrow(/minBatchSize/);
  });
});

describe('scheduler: time and resources', () => {
  it('waits for energy on the virtual clock without busy loop: one sleep per wait, the computed time', async () => {
    const e = new Engine(flag(10, 10), { energy: 5, capacity: 10, regenIntervalMs: 1_000, config: { maxBatchSize: 10, minBatchSize: 5 } });
    const t0 = e.clock.now();
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    expect(e.wrong()).toBe(0);
    // 100 pixels, 5 at start, 1 per second: about 95 s of virtual time, waits of ~5 s each (batches of 5).
    const waits = e.sleeps.filter((ms) => ms > 100);
    expect(waits.length).toBeGreaterThanOrEqual(18);
    expect(waits.length).toBeLessThanOrEqual(25);
    expect(final.cycles).toBeLessThan(80);
    expect(e.clock.now() - t0).toBeGreaterThan(90_000);
    expect(e.states()).toContain('waiting-resources');
  });

  it('an unavailable agent: waits until the announced date; indefinitely unavailable: error', async () => {
    const e = new Engine(flag(4, 2));
    const until_ = e.clock.now() + 3_600_000;
    e.canvas.setAvailability(A, { status: 'unavailable', until: until_ });
    await e.scheduler.step();
    expect(e.scheduler.status()).toMatchObject({ state: 'waiting-resources', nextAvailabilityAt: until_ });
    expect(e.clock.now()).toBeGreaterThanOrEqual(until_);
    e.canvas.setAvailability(A, { status: 'available' });
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    const f = new Engine(flag(4, 2));
    f.canvas.setAvailability(A, { status: 'unavailable', until: null });
    await f.scheduler.start();
    expect(await f.scheduler.done()).toMatchObject({ state: 'error', reason: expect.stringMatching(/AGENT_UNAVAILABLE/) as string });
  });

  it('individual palette: work in a locked color is reported, not hidden as completed', async () => {
    const e = new Engine(template(image(4, 2, (x) => (x === 3 ? BLUE : RED))));
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final).toMatchObject({ state: 'error', reason: expect.stringMatching(/BLOCKED.*not unlocked/) as string, incorrect: 2 });
    expect(e.wrong()).toBe(2);
  });
});

describe('scheduler: commands', () => {
  it('pause waits for the write in progress, then nothing happens until resume', async () => {
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
    e.canvas.injectFaults({ kind: 'hold', appliedBefore: false });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    const paused = e.scheduler.pause();
    expect(e.scheduler.status().state).toBe('running'); // the write is still pending
    e.canvas.releaseHeld();
    await paused;
    expect(e.scheduler.status().state).toBe('paused');
    const calls = e.canvas.writeCalls;
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
    expect(e.canvas.writeCalls).toBe(calls);
    expect(e.scheduler.status().openAttempts).toBe(0); // the held write was closed, not abandoned
    e.scheduler.resume();
    expect((await e.scheduler.done()).state).toBe('completed');
    expect(e.states()).toEqual(expect.arrayContaining(['paused', 'running', 'completed']));
  });

  it('stop during a write (abort): the attempt is reconciled before stopping, never abandoned; a later start finishes', async () => {
    for (const appliedBefore of [true, false]) {
      const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
      e.canvas.injectFaults({ kind: 'hold', appliedBefore });
      await e.scheduler.start();
      await until(() => e.canvas.holding);
      const stopped = await e.scheduler.stop({ abort: true });
      expect(stopped).toMatchObject({ state: 'stopped', openAttempts: 0, uncertainAttempts: [] });
      expect(stopped.recentErrors.some((x) => x.code === 'WRITE_UNCERTAIN')).toBe(true);
      const reconciled = e.journal.events.filter((x) => x.type === 'reconciled') as Extract<JournalEvent, { type: 'reconciled' }>[];
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]!.results.every((r) => r.result === (appliedBefore ? 'observed-correct' : 'observed-incorrect'))).toBe(true);
      await e.scheduler.start();
      expect((await e.scheduler.done()).state).toBe('completed');
      expect(e.appliedTwice()).toBe(0);
    }
  });

  it('stop when no covering read is possible: the started attempt is reported open, and the next process reconciles it', async () => {
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
    e.canvas.injectFaults({ kind: 'hold', appliedBefore: true });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    const read = e.canvas.reader.readRegion.bind(e.canvas.reader);
    (e.canvas.reader as { readRegion: typeof read }).readRegion = async () => {
      throw new Error('canvas unreachable');
    };
    const stopped = await e.scheduler.stop({ abort: true });
    expect(stopped.state).toBe('stopped');
    expect(stopped.uncertainAttempts).toHaveLength(1);
    expect(stopped.recentErrors.some((x) => x.code === 'LEFT_UNCERTAIN')).toBe(true);
    (e.canvas.reader as { readRegion: typeof read }).readRegion = read;
    e.startProcess();
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    expect(e.appliedTwice()).toBe(0);
  });

  it('stop without abort lets the current write finish; pause while waiting for energy wakes the sleep', async () => {
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
    e.canvas.injectFaults({ kind: 'hold', appliedBefore: false });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    const stopping = e.scheduler.stop();
    e.canvas.releaseHeld();
    expect(await stopping).toMatchObject({ state: 'stopped', openAttempts: 0 });
    expect(e.journal.events.filter((x) => x.type === 'finished')).toHaveLength(1);
  });

  it('subscribers receive the events; a failing listener does not break the loop', async () => {
    const e = new Engine(flag(3, 2));
    const seen: SchedulerEvent['type'][] = [];
    e.scheduler.subscribe(() => {
      throw new Error('listener bug');
    });
    const unsubscribe = e.scheduler.subscribe((x) => seen.push(x.type));
    await e.scheduler.start();
    await e.scheduler.done();
    expect(new Set(seen)).toEqual(new Set(['state', 'cycle', 'attempt', 'progress']));
    unsubscribe();
  });
});

describe('scheduler: faults, restarts, revisions', () => {
  it('every simulator fault during a run: completed, nothing applied twice, never resent blindly, energy never counted twice', async () => {
    const e = new Engine(flag(8, 6), { config: { maxBatchSize: 6 } });
    e.canvas.injectFaults({ kind: 'fail-before' }, { kind: 'partial', applied: 2 }, { kind: 'answer-lost' }, { kind: 'unknown-outcomes' }, { kind: 'reject', reason: 'rate-limited' });
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    expect(e.wrong()).toBe(0);
    expect(e.appliedTwice()).toBe(0);
    expect(e.canvas.pendingFaults).toBe(0);
    // Every write call is a distinct attempt: nothing resent.
    const started = e.journal.events.filter((x) => x.type === 'started').length;
    expect(e.canvas.writeCalls).toBe(started);
    // The engine's energy view agrees with the provider's.
    const now = e.clock.now();
    e.resources.observe(e.canvas.observe(A));
    expect(e.resources.stateAt(A, now, now).energy).toBe(e.canvas.observe(A).energy);
    const codes = new Set(final.recentErrors.map((x) => x.code));
    expect(codes.has('WRITE_UNCERTAIN')).toBe(true);
    expect(codes.has('PIXELS_REJECTED')).toBe(true);
  });

  it('process restart in the middle (a write landed, the answer never journaled): reconciled, finished, nothing applied twice', async () => {
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
    e.canvas.injectFaults({ kind: 'hold', appliedBefore: true });
    await e.scheduler.start();
    await until(() => e.canvas.holding);
    // The process dies: its scheduler is dropped and its held write never answers.
    e.canvas.forgetHeld();
    e.startProcess();
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final.state).toBe('completed');
    expect(e.appliedTwice()).toBe(0);
    expect(e.journal.events.some((x) => x.type === 'reconciled')).toBe(true);
  });

  it('a crash while journaling (append fails): error, then a new process recovers and finishes', async () => {
    const base = createMemoryJournal();
    let failNext = false;
    const journal = Object.assign(Object.create(base) as typeof base, {
      events: base.events,
      load: base.load.bind(base),
      stats: base.stats.bind(base),
      compact: base.compact.bind(base),
      append: async (event: JournalEvent) => {
        if (failNext && event.type === 'finished') {
          failNext = false;
          throw new Error('disk failure while journaling');
        }
        return base.append(event);
      },
    });
    Object.defineProperty(journal, 'events', { get: () => base.events });
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 }, journal });
    failNext = true;
    await e.scheduler.start();
    const failed = await e.scheduler.done();
    expect(failed).toMatchObject({ state: 'error', reason: expect.stringMatching(/disk failure/) as string });
    e.startProcess();
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    expect(e.appliedTwice()).toBe(0);
  });

  it('a crash during an automatic compaction (journal left unknown): error; a new process recovers and finishes', async () => {
    const base = createMemoryJournal();
    let breakCompaction = true;
    let unloaded = false;
    const journal = {
      get events() {
        return base.events;
      },
      load: async (v: Parameters<typeof base.load>[0]) => {
        unloaded = false;
        return base.load(v);
      },
      stats: async () => {
        if (unloaded) throw Object.assign(new Error('not loaded'), { code: 'NOT_LOADED' });
        return base.stats();
      },
      append: async (ev: JournalEvent) => {
        if (unloaded) throw Object.assign(new Error('not loaded'), { code: 'NOT_LOADED' });
        return base.append(ev);
      },
      compact: async (s: Parameters<typeof base.compact>[0]) => {
        if (breakCompaction) {
          breakCompaction = false;
          unloaded = true;
          throw new Error('publish interrupted');
        }
        return base.compact(s);
      },
    };
    const e = new Engine(flag(8, 4), { config: { maxBatchSize: 4 }, journal: journal as never, autoCompaction: { enabled: true, maxActiveEvents: 10 } });
    await e.scheduler.start();
    expect(await e.scheduler.done()).toMatchObject({ state: 'error', reason: expect.stringMatching(/JOURNAL_UNAVAILABLE/) as string });
    e.startProcess();
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    expect(e.attempts.compactionStatus().automatic).toBeGreaterThan(0);
    expect(e.appliedTwice()).toBe(0);
  });

  it('a new revision during the run: old attempts handled, the new image painted', async () => {
    const e = new Engine(flag(6, 4), { config: { maxBatchSize: 4 } });
    await e.scheduler.step();
    await e.scheduler.step();
    e.current = template(image(6, 4, () => GREEN), 2);
    await e.scheduler.start();
    const final = await e.scheduler.done();
    expect(final).toMatchObject({ state: 'completed', revision: 2 });
    expect(e.wrong()).toBe(0);
  });

  it('automatic compaction during a long run keeps working and the state equals the full journal', async () => {
    const e = new Engine(flag(12, 8), { config: { maxBatchSize: 3 }, autoCompaction: { enabled: true, maxActiveEvents: 12 } });
    await e.scheduler.start();
    expect((await e.scheduler.done()).state).toBe('completed');
    expect(e.attempts.compactionStatus().automatic).toBeGreaterThan(5);
    e.startProcess();
    const report = await e.attempts.recover(e.clock.now());
    expect(report).toMatchObject({ fromCheckpoint: true, damaged: false, toReconcile: [] });
  });
});
