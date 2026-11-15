import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { HistoryEntry, JournalEvent } from '@geoplacer/core';
import { AttemptError, crc32, encodeHistoryLine } from '@geoplacer/core';
import { FileAttemptJournal, FileHistoryStore, JournalOpenError, acquireDataDirectoryLock, encodePointer, nodeJournalFs, type DataDirectoryLock } from '../src/index.js';
import { FaultyFs, type FaultMode } from './helpers/faulty-fs.js';
import { AGENT, checkpointName, fullReplay, historyOnDisk, journalFiles, loadState, logName, openHarness, openedJournals, runSteps } from './helpers/journal-scenario.js';

const temps: string[] = [];
const locks: DataDirectoryLock[] = [];
afterAll(async () => {
  await Promise.all(openedJournals.splice(0).map((j) => j.close()));
  await Promise.all(locks.splice(0).map((l) => l.release()));
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});
async function lockedRoot(): Promise<{ root: string; lock: DataDirectoryLock }> {
  const root = await mkdtemp(path.join(tmpdir(), 'geoplacer-journal-'));
  temps.push(root);
  const lock = await acquireDataDirectoryLock(root);
  locks.push(lock);
  return { root, lock };
}
const jdir = (root: string): string => path.join(root, 'journal');

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof AttemptError || error instanceof JournalOpenError ? error.code : String(error);
  }
}

/** A Phase 1B.6 line (format 1, no sequence number). */
function v1Line(event: JournalEvent): string {
  const json = JSON.stringify({ v: 1, event });
  return `${crc32(new TextEncoder().encode(json)).toString(16).padStart(8, '0')} ${json}\n`;
}

describe('file journal: generations and compaction', () => {
  it('appends numbered lines, compacts into checkpoints and generations, and rebuilds the same state as the full journal', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 60, 20);
    const files = await journalFiles(root);
    expect(files.pointer).toBe(3);
    expect(files.gens.checkpoints).toEqual([1, 2, 3]);
    expect(files.gens.logs).toEqual([1, 2, 3]);
    expect(files.gens.legacyLog).toBe(true);
    const reference = await fullReplay(root);
    expect(reference.inconsistent).toBe(0);
    const reopened = new FileAttemptJournal(lock);
    expect(await loadState(reopened)).toEqual(reference.state);
    expect(h.manager.state()).toEqual(reference.state);
    await h.journal.close();
  });

  it('retention keeps the current and previous generations (default), never a preserved one', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock, { retainGenerations: 2 });
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 50, 10);
    const files = await journalFiles(root);
    expect(files.pointer).toBe(5);
    expect(files.gens).toEqual({ logs: [4, 5], checkpoints: [4, 5], legacyLog: false });
    expect(files.names.filter((n) => n.includes('.tmp-'))).toEqual([]);
    const restarted = openHarness(lock, { retainGenerations: 2, idPrefix: 'b' });
    expect(await restarted.manager.recover(restarted.clock.now + 10_000)).toMatchObject({ generation: 5, fromCheckpoint: true, damaged: false });
  });

  it('reads the journal of Phase 1B.6 (format 1, generation 0) and continues it with numbered lines', async () => {
    const { root, lock } = await lockedRoot();
    await mkdir(jdir(root), { recursive: true });
    const attempt = { attemptId: 'old-1', agent: AGENT, projectId: 'p', templateId: 'm', revision: 1, writes: [{ taskId: 't', point: { x: 1, y: 1 }, color: 0xff0000 }], energyCost: 1, state: 'leased', leasedAt: 10, expiresAt: 10_000_000_000, startedAt: null, needsReconciliationAt: null, closedAt: null, results: [], reason: null };
    await writeFile(path.join(jdir(root), 'attempts.log'), v1Line({ type: 'leased', attempt } as never) + v1Line({ type: 'started', attemptId: 'old-1', at: 11 } as never));
    const h = openHarness(lock);
    const report = await h.manager.recover(h.clock.now);
    expect(report).toMatchObject({ generation: 0, fromCheckpoint: false, toReconcile: ['old-1'], sequenceGaps: 0, damaged: false });
    await h.manager.compact(h.clock.now + 1);
    const reopened = new FileAttemptJournal(lock);
    const state = await loadState(reopened);
    expect(state.open.map((a) => [a.attemptId, a.state])).toEqual([['old-1', 'needs-reconciliation']]);
    expect(state.lastSeq).toBe(3);
  });

  it('refuses a missing pointer when generation files exist, and an unreadable pointer', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 10, 5);
    await h.journal.close();
    const pointer = await readFile(path.join(jdir(root), 'CURRENT'));
    await rm(path.join(jdir(root), 'CURRENT'));
    expect(await code(new FileAttemptJournal(lock).load({ checkpoint() {}, event() {} }))).toBe('NO_POINTER');
    await writeFile(path.join(jdir(root), 'CURRENT'), pointer.toString().replace('generation 2', 'generation 1'));
    expect(await code(new FileAttemptJournal(lock).load({ checkpoint() {}, event() {} }))).toBe('BAD_POINTER');
    await writeFile(path.join(jdir(root), 'CURRENT'), pointer);
    expect(await code(new FileAttemptJournal(lock).load({ checkpoint() {}, event() {} }))).toBe('resolved');
  });

  it('an unusable checkpoint falls back to the previous generation (reported as damage) or is refused', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 30, 10);
    await runSteps(h, 30, 4);
    await h.journal.close();
    const reference = await fullReplay(root);
    const ckpt = path.join(jdir(root), checkpointName(3));
    const bytes = await readFile(ckpt);
    bytes[bytes.length - 3]! ^= 0x01;
    await writeFile(ckpt, bytes);
    const fallback = new FileAttemptJournal(lock);
    let state = null as unknown;
    const report = await fallback.load({ checkpoint() {}, event() {} });
    expect(report.problems).toEqual(['checkpoint of generation 3 unusable: rebuilt from generation 2']);
    state = await loadState(new FileAttemptJournal(lock));
    expect(state).toEqual(reference.state);
    // A manager sees the damage: no compaction until a repair.
    const m = openHarness(lock, { idPrefix: 'c' });
    expect(await m.manager.recover(m.clock.now + 100_000)).toMatchObject({ damaged: true });
    expect(await code(m.manager.compact(m.clock.now + 100_001))).toBe('JOURNAL_DAMAGED');
    await m.journal.close();
    // Previous generation not kept: refused.
    await rm(path.join(jdir(root), logName(2)));
    expect(await code(new FileAttemptJournal(lock).load({ checkpoint() {}, event() {} }))).toBe('CHECKPOINT_UNUSABLE');
  });

  it('sequence numbers expose a missing event in the middle (damage), not only a bad checksum', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 6);
    await h.journal.close();
    const file = path.join(jdir(root), logName(0));
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.splice(3, 1); // a whole valid line disappears
    await writeFile(file, lines.join('\n'));
    const m = openHarness(lock, { idPrefix: 'g' });
    const report = await m.manager.recover(m.clock.now + 100_000);
    expect(report).toMatchObject({ corruptLines: [], damaged: true });
    expect(report.sequenceGaps).toBeGreaterThan(0);
    await m.journal.close();
  });
});

describe('file journal: interrupted compaction (fault injection at every file operation)', () => {
  for (const mode of ['before', 'after'] as FaultMode[]) {
    it(`a failure ${mode} any operation of the compaction leaves a journal that rebuilds the same state, and keeps working`, { timeout: 60_000 }, async () => {
      let k = 0;
      let reachedEnd = false;
      const steps: string[] = [];
      for (; !reachedEnd && k < 200; k++) {
        const { root, lock } = await lockedRoot();
        const fs = new FaultyFs(nodeJournalFs);
        const h = openHarness(lock, { fs, retainGenerations: 1 });
        await h.manager.recover(h.clock.now);
        await runSteps(h, 0, 12, 6); // two clean compactions first (retention exercised)
        const before = h.manager.state();
        fs.armed = true;
        fs.failAt = k;
        fs.mode = mode;
        fs.count = 0;
        const callsBefore = fs.calls.length;
        const result = await code(h.manager.compact(h.clock.now + 1));
        fs.armed = false;
        h.clock.now += 1;
        if (fs.count <= k) reachedEnd = true;
        else steps.push(`${fs.calls[callsBefore + k]?.op ?? '?'}:${fs.calls[callsBefore + k]?.name ?? '?'}`);
        // The logical state never changes with a compaction, whatever happened.
        expect(h.manager.state()).toEqual(before);
        // A restart rebuilds exactly that state; no open attempt is lost.
        const restartedJournal = new FileAttemptJournal(lock);
        expect({ k, mode, result: result === 'resolved' || result.startsWith('Error: injected'), state: await loadState(restartedJournal) }).toEqual({ k, mode, result: true, state: before });
        await restartedJournal.close();
        // The same instance keeps working (or refuses until reloaded), then a restart still agrees.
        const more = await code(runSteps(h, 100, 5));
        if (more !== 'resolved') expect(more).toBe('NOT_LOADED');
        const after = h.manager.state();
        await h.journal.close();
        const again = new FileAttemptJournal(lock);
        expect(await loadState(again)).toEqual(after);
        // And a later compaction succeeds (orphans of the interrupted one never win).
        const h2 = openHarness(lock, { retainGenerations: 1, idPrefix: `z${k}` });
        const report = await h2.manager.recover(h.clock.now + 10_000);
        expect(report.damaged).toBe(false);
        await h2.manager.compact(h.clock.now + 10_001);
        const final = await journalFiles(root);
        expect(final.names.filter((n) => n.includes('.tmp-'))).toEqual([]);
        await h2.journal.close();
        await again.close();
      }
      expect(reachedEnd).toBe(true);
      // Every step of the compaction was interrupted at least once.
      expect(steps.join(' ')).toMatch(/writeNew:checkpoint-.*rename:checkpoint-.*writeNew:attempts-.*readFile:checkpoint-.*writeNew:CURRENT\.tmp-.*rename:CURRENT/s);
    });
  }
});

describe('file journal: appends', () => {
  it('a torn last line is moved aside and cut off before the next append; damage before the end is kept', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 3);
    await h.journal.close();
    const file = path.join(jdir(root), logName(0));
    const text = await readFile(file, 'utf8');
    await writeFile(file, text + text.split('\n')[0]!.slice(0, 17));
    const m = openHarness(lock, { idPrefix: 't', base: h.clock.now + 100_000 });
    expect(await m.manager.recover(++m.clock.now)).toMatchObject({ discardedTailBytes: 17, damaged: false });
    await runSteps(m, 50, 1); // the next append cuts the torn tail first
    const aside = (await readdir(jdir(root))).filter((n) => n.startsWith('attempts.log.torn-'));
    expect(aside).toHaveLength(1);
    expect((await readFile(path.join(jdir(root), aside[0]!), 'utf8')).length).toBe(17);
    await m.journal.close();
    const bytes = await readFile(file);
    bytes[20]! ^= 0x01;
    await writeFile(file, bytes);
    const d = openHarness(lock, { idPrefix: 'u' });
    expect(await d.manager.recover(d.clock.now + 200_000)).toMatchObject({ corruptLines: [1], damaged: true });
    await d.journal.close();
  });

  it('a failed append (partial line, then an error) never leaves damage before the end', async () => {
    const { root, lock } = await lockedRoot();
    const fs = new FaultyFs(nodeJournalFs);
    const h = openHarness(lock, { fs });
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 2);
    fs.armed = true;
    fs.mode = 'partial';
    fs.count = 0;
    fs.failAt = fs.calls.length; // never by index: the next write below
    fs.onCall = (call) => {
      if (call.op === 'write') fs.failAt = fs.count;
    };
    expect(await code(runSteps(h, 2, 1))).toMatch(/injected partial/);
    fs.armed = false;
    fs.onCall = null;
    await runSteps(h, 3, 2);
    await h.journal.close();
    const reopened = openHarness(lock, { idPrefix: 'v' });
    expect(await reopened.manager.recover(reopened.clock.now + 100_000)).toMatchObject({ corruptLines: [], sequenceGaps: 0, damaged: false });
    expect((await readdir(jdir(root))).filter((n) => n.startsWith('attempts.log.torn-'))).toHaveLength(1);
    await reopened.journal.close();
  });
});

describe('history rotation', () => {
  const entry = (at: number, agent = 'x', templateId = 'm'): HistoryEntry => ({ at, agent: agent as never, templateId: templateId as never, revision: 1, attemptId: `a${at}` as never, state: 'finished', applied: 1, alreadyCorrect: 0, rejected: 0, unknown: 0, observedCorrect: 0, observedIncorrect: 0 });
  const lineBytes = encodeHistoryLine(entry(10)).length;

  it('rotates by size, keeps the configured number of segments, reads only the segments it needs', async () => {
    const { root, lock } = await lockedRoot();
    const history = new FileHistoryStore(lock, { maxSegmentBytes: lineBytes * 10, maxSegments: 3 });
    for (let i = 10; i < 60; i++) await history.append(entry(i, i % 2 === 0 ? 'x' : 'y'));
    const segments = (await readdir(jdir(root))).filter((n) => n.startsWith('history-')).sort();
    expect(segments).toHaveLength(3);
    const all = await history.query({ limit: 1000 });
    expect(all.map((e) => e.at)).toEqual(Array.from({ length: 30 }, (_, i) => 30 + i));
    expect(history.lastQuerySegments).toBe(3);
    expect((await history.query({ limit: 5 })).map((e) => e.at)).toEqual([55, 56, 57, 58, 59]);
    expect(history.lastQuerySegments).toBe(1);
    expect((await history.query({ agent: 'y' as never, since: 52, limit: 10 })).map((e) => e.at)).toEqual([53, 55, 57, 59]);
    expect(history.lastQuerySegments).toBe(1); // the newest segment starts before `since`: older ones are not read
    expect((await history.query({ agent: 'y' as never, since: 45, limit: 10 })).map((e) => e.at)).toEqual([45, 47, 49, 51, 53, 55, 57, 59]);
    expect(history.lastQuerySegments).toBe(2);
    await history.close();
  });

  it('reads the history of Phase 1B.6 (history.log) as the oldest segment, and handles a torn last line', async () => {
    const { root, lock } = await lockedRoot();
    await mkdir(jdir(root), { recursive: true });
    await writeFile(path.join(jdir(root), 'history.log'), encodeHistoryLine(entry(1)) + encodeHistoryLine(entry(2)) + encodeHistoryLine(entry(3)).slice(0, 9));
    const history = new FileHistoryStore(lock, { maxSegmentBytes: lineBytes * 2, maxSegments: 4 });
    expect((await history.query({ limit: 10 })).map((e) => e.at)).toEqual([1, 2]);
    expect(history.lastQueryCorruptLines).toBe(0);
    for (let i = 4; i < 8; i++) await history.append(entry(i));
    expect((await history.query({ limit: 10 })).map((e) => e.at)).toEqual([1, 2, 4, 5, 6, 7]);
    await history.close();
  });
});

describe('real process kills at named steps (explicit synchronisation, no timer)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');

  /** Runs journal-child, which kills itself when it reaches `step` (`op:filePrefix:phase#occurrence`). */
  function killAt(root: string, round: number, step: string): Promise<{ reached: boolean; output: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fixtures', 'journal-child.ts'), root, String(round), step], {
        cwd: repoRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
      proc.on('exit', (exitCode) => {
        const reached = out.includes(`reached ${step}`);
        if (!reached && exitCode !== 0) reject(new Error(`journal child failed (${String(exitCode)}): ${out}`));
        else resolve({ reached, output: out });
      });
    });
  }

  const steps = [
    'write:attempts:partial#3',
    'sync:attempts:before#4',
    'writeNew:checkpoint:before#1',
    'writeNew:checkpoint:after#1',
    'rename:checkpoint:after#1',
    'writeNew:attempts-:after#1',
    'readFile:checkpoint:after#2', // #1 is the read of the recovery
    'writeNew:CURRENT:after#1',
    'rename:CURRENT:after#1',
    'remove:attempts.log:before#1', // retention (last: it deletes generations)
  ];

  it('after a kill at each step, the journal reopens to the state of the full journal; no open attempt is lost', { timeout: 300_000 }, async () => {
    const { root, lock } = await lockedRoot();
    await lock.release();
    locks.splice(locks.indexOf(lock), 1);
    let historyEntries = 0;
    for (const [round, step] of steps.entries()) {
      const { reached, output } = await killAt(root, round, step);
      expect({ step, reached, output: reached ? '' : output }).toEqual({ step, reached: true, output: '' });
      const relock = await acquireDataDirectoryLock(root);
      try {
        // Retention deletes the generations the full replay needs: compare with the state saved before the compaction.
        const reference = step.startsWith('remove')
          ? { state: JSON.parse(await readFile(path.join(root, 'expected-state.json'), 'utf8')) as unknown, inconsistent: 0 }
          : await fullReplay(root);
        expect(reference.inconsistent).toBe(0);
        const journal = new FileAttemptJournal(relock);
        const report = await journal.load({ checkpoint() {}, event() {} });
        expect({ step, corrupt: report.corruptLines, gaps: report.sequenceGaps, problems: report.problems }).toEqual({ step, corrupt: [], gaps: 0, problems: [] });
        const state = await loadState(new FileAttemptJournal(relock));
        expect(state).toEqual(reference.state);
        // The history on disk survives the kills too: readable, and every entry is a closed attempt.
        const history = await historyOnDisk(root);
        expect({ step, corrupt: history.corruptLines }).toEqual({ step, corrupt: 0 });
        const closed = new Set<string>(state.closed.map((c) => c.attemptId));
        expect({ step, notClosed: history.attemptIds.filter((id) => !closed.has(id)) }).toEqual({ step, notClosed: [] });
        historyEntries += history.attemptIds.length;
        await journal.close();
      } finally {
        await relock.release();
      }
    }
    expect(historyEntries).toBeGreaterThan(0);
  });
});

describe('file journal: concurrency and statistics (Phase 1B.8)', () => {
  it('an append and a compaction called at once on the journal itself never overlap: no event lands in a superseded generation', async () => {
    const { lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 6);
    const state = h.manager.state();
    const events: JournalEvent[] = Array.from({ length: 10 }, (_, k) => ({ type: 'canvas-read-required', at: 2e12 + k, reason: `concurrent ${k}` }));
    const results = await Promise.allSettled([h.journal.compact(state), ...events.map((e) => h.journal.append(e))]);
    expect(results.map((r) => r.status)).toEqual(Array(11).fill('fulfilled'));
    await h.journal.close();
    const reloaded = await loadState(new FileAttemptJournal(lock));
    expect(reloaded.lastSeq).toBe(state.lastSeq + 10);
    expect(reloaded.damage).toEqual({ at: 2e12 + 9, reason: 'concurrent 9' });
  });

  it('statistics count the active generation from the load on; the free space is known on this disk', async () => {
    const { lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 5);
    const before = await h.journal.stats();
    expect(before.activeEvents).toBeGreaterThan(5);
    expect(before.activeBytes).toBeGreaterThan(0);
    expect(before.freeBytes).toBeGreaterThan(0);
    await h.journal.close();
    const again = new FileAttemptJournal(lock);
    await expect(again.stats()).rejects.toMatchObject({ code: 'NOT_LOADED' });
    await again.load({ checkpoint() {}, event() {} });
    expect(await again.stats()).toMatchObject({ activeEvents: before.activeEvents, activeBytes: before.activeBytes, generation: 0 });
    await again.compact(h.manager.state());
    expect(await again.stats()).toMatchObject({ activeEvents: 0, activeBytes: 0, generation: 1 });
    await again.close();
  });

  it('automatic compaction on disk under concurrent operations: reloads to the same state, never two at a time', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock, { autoCompaction: { enabled: true, maxActiveEvents: 15, minFreeBytes: 1 } });
    await h.manager.recover(h.clock.now);
    h.observe(); // once: the concurrent cycles below spend nothing (already-correct outcomes)
    const cycle = async (x: number, y: number): Promise<void> => {
      const writes = [{ taskId: `c-${x},${y}` as never, point: { x, y }, color: 0xff0000 as never }];
      const a = await h.manager.lease({ agent: AGENT, projectId: 'p' as never, templateId: 'm' as never, revision: 1, writes, now: ++h.clock.now, ttlMs: 1e12 });
      await h.manager.start(a.attemptId, ++h.clock.now);
      if (x % 9 !== 4) await h.manager.finish(a.attemptId, [{ taskId: writes[0]!.taskId, status: 'already-correct' }], ++h.clock.now);
    };
    await Promise.all(Array.from({ length: 90 }, (_, k) => cycle(k % 30, Math.floor(k / 30))));
    expect(h.manager.compactionStatus().automatic).toBeGreaterThan(3);
    expect(h.manager.compactionStatus().lastProblem).toBeNull();
    const expected = h.manager.state();
    await h.journal.close();
    expect(await loadState(new FileAttemptJournal(lock))).toEqual(expected);
    expect((await fullReplay(root)).state).toEqual(expected);
  });
});

describe('file journal: pointer format', () => {
  it('is checked by CRC', () => {
    const bytes = encodePointer(7);
    expect(new TextDecoder().decode(bytes)).toMatch(/^geoplacer-journal-pointer 1\ngeneration 7\ncrc [0-9a-f]{8}\n$/);
  });
});
