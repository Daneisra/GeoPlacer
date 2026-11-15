/**
 * Phase 1B.7: cost of the attempt journal, before and after compaction.
 *
 *   npm run bench:journal
 *
 * Scenario (as measured in Phase 1B.6): 1 000 attempts of 1 000 pixels,
 * the last 5 left open, written in bulk with the journal line format
 * (about 146 MiB). Measured:
 * - append of one event (fsync) and a full attempt cycle;
 * - recovery BEFORE compaction: cold (a new process: start, load, replay,
 *   recover; peak resident memory) and warm (a second recovery in the same
 *   process: retained memory);
 * - the compaction: duration (writes are blocked during all of it: the
 *   manager is serialized), checkpoint size, active journal size;
 * - recovery AFTER compaction, cold and warm.
 * "Cold" means a new process: the OS file cache cannot be purged here, so
 * the file may already be in memory. The resource rules are synthetic.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, Attempt, JournalEvent, PixelWrite, ProjectId, ResourceRules, Rgb, TaskId, TemplateId } from '@geoplacer/core';
import { createAttemptManager, createMemoryHistory, createResourceManager, encodeJournalLine } from '@geoplacer/core';
import { FileAttemptJournal, FileHistoryStore, acquireDataDirectoryLock } from '../src/index.js';

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const mib = (bytes: number): number => +(bytes / 1048576).toFixed(1);
const RED = 0xff0000 as Rgb;
const agent = 'agent-1' as AgentId;
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'bench-simulated',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 1_000_000, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [] },
  currency: {},
};

function writes(n: number, offset: number): PixelWrite[] {
  return Array.from({ length: n }, (_, k) => {
    const i = offset + k;
    const x = i % 4096;
    const y = Math.floor(i / 4096);
    return { taskId: `projet/modele@3:${x},${y}:#ff0000` as TaskId, point: { x, y }, color: RED };
  });
}

function attempt(id: string, w: PixelWrite[], at: number): Attempt {
  return { attemptId: id as never, agent, projectId: 'projet' as ProjectId, templateId: 'modele' as TemplateId, revision: 3, writes: w, energyCost: w.length, state: 'leased', leasedAt: at, expiresAt: at + 1e12, startedAt: null, needsReconciliationAt: null, closedAt: null, results: [], reason: null };
}

/** Writes the scenario journal (generation 0) in bulk. */
function prepare(root: string, attempts: number, size: number): number {
  const file = path.join(root, 'journal', 'attempts.log');
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  let seq = 0;
  let at = 1;
  const put = (e: JournalEvent): void => void writeSync(fd, encodeJournalLine(e, ++seq));
  for (let k = 0; k < attempts; k++) {
    const id = `a-${k}`;
    const w = writes(size, (k * size) % (4096 * 4096));
    put({ type: 'leased', attempt: attempt(id, w, at++) });
    put({ type: 'started', attemptId: id as never, at: at++ });
    if (k >= attempts - 5) continue; // left open (started: kept open across recoveries, to reconcile)
    put({ type: 'finished', attemptId: id as never, at: at++, outcomes: w.map((x) => ({ taskId: x.taskId, status: 'applied' })) });
  }
  closeSync(fd);
  return statSync(file).size;
}

async function recoverOnce(root: string, now: number): Promise<{ ms: number; open: number; generation: number; fromCheckpoint: boolean; retainedMib: number }> {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const base = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const lock = await acquireDataDirectoryLock(root);
  const journal = new FileAttemptJournal(lock);
  const history = new FileHistoryStore(lock);
  const manager = createAttemptManager({ journal, history, resources: createResourceManager(rules), newAttemptId: () => randomUUID() as never });
  const t = performance.now();
  const report = await manager.recover(now);
  const ms = performance.now() - t;
  gc?.();
  const retained = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - base;
  const open = manager.open().length;
  await journal.close();
  await history.close();
  await lock.release();
  return { ms: Math.round(ms), open, generation: report.generation, fromCheckpoint: report.fromCheckpoint, retainedMib: mib(Math.max(0, retained)) };
}

/** Child modes (one process each: "cold"). */
async function child(mode: string, root: string): Promise<void> {
  if (mode === 'recover') {
    const cold = await recoverOnce(root, 9e12);
    const warm = await recoverOnce(root, 9e12 + 1);
    // performance.now() counts from the process start (module loading included).
    console.log(JSON.stringify({ cold: { ...cold, sinceProcessStartMs: Math.round(performance.now()) }, warm, peakRssMib: mib(process.resourceUsage().maxRSS * 1024) }));
  } else if (mode === 'compact') {
    const lock = await acquireDataDirectoryLock(root);
    const journal = new FileAttemptJournal(lock);
    const manager = createAttemptManager({ journal, history: createMemoryHistory(), resources: createResourceManager(rules), newAttemptId: () => randomUUID() as never });
    await manager.recover(9e12 + 10);
    const t = performance.now();
    const report = await manager.compact(9e12 + 11);
    const ms = performance.now() - t;
    await journal.close();
    await lock.release();
    console.log(JSON.stringify({ compactMs: Math.round(ms), writesBlockedMs: Math.round(ms), checkpointMib: mib(report.checkpointBytes), openAttempts: report.openAttempts, closedSummaries: report.closedSummaries, generation: report.generation, peakRssMib: mib(process.resourceUsage().maxRSS * 1024) }));
  }
}

function runChild(mode: string, root: string): Record<string, unknown> {
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', self, mode, root], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (result.status !== 0) throw new Error(`${mode} failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

const [modeArg, rootArg] = process.argv.slice(2);
if (modeArg !== undefined && rootArg !== undefined) await child(modeArg, rootArg);
else {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
  const roots: string[] = [];
  try {
    // Appends.
    {
      const root = mkdtempSync(path.join(tmpdir(), 'geoplacer-journal-'));
      roots.push(root);
      const lock = await acquireDataDirectoryLock(root);
      const journal = new FileAttemptJournal(lock);
      const manager = createAttemptManager({ journal, history: new FileHistoryStore(lock), resources: createResourceManager(rules), newAttemptId: () => randomUUID() as never });
      await manager.recover(1);
      const appendTimes: number[] = [];
      for (let k = 0; k < 30; k++) {
        const t = performance.now();
        await journal.append({ type: 'leased', attempt: attempt(randomUUID(), writes(1000, k * 1000), 10 + k) });
        appendTimes.push(performance.now() - t);
      }
      console.log(JSON.stringify({ append: 'lease of 1 000 pixels (fsync)', medianMs: +median(appendTimes).toFixed(2) }));
      await journal.close();
      await lock.release();
    }
    const root = mkdtempSync(path.join(tmpdir(), 'geoplacer-journal-'));
    roots.push(root);
    const bytes = prepare(root, 1000, 1000);
    console.log(JSON.stringify({ scenario: '1 000 attempts of 1 000 pixels, 5 open', journalMib: mib(bytes) }));
    const before = runChild('recover', root);
    console.log(JSON.stringify({ phase: 'before compaction', ...before }));
    const compaction = runChild('compact', root);
    const active = statSync(path.join(root, 'journal', `attempts-${String(compaction['generation']).padStart(12, '0')}.log`)).size;
    console.log(JSON.stringify({ phase: 'compaction', ...compaction, activeJournalBytes: active }));
    const after = runChild('recover', root);
    console.log(JSON.stringify({ phase: 'after compaction', ...after }));
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
}
