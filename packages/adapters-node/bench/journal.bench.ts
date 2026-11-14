/**
 * Phase 1B.6: cost of the attempt journal on disk.
 *
 *   npm run bench:journal
 *
 * - append: one event (fsync) for leases of 1, 100 and 1 000 writes, and
 *   the full cycle lease + start + finish (+ history) of a 1 000-write
 *   attempt through the AttemptManager;
 * - recovery: load + replay + recover of journals holding 100 and 1 000
 *   attempts of 1 000 writes and 10 000 attempts of 10 writes (written in
 *   bulk with the same line format; the last 5 attempts left open), with
 *   the file size and the extra memory.
 * The resource rules are synthetic (not a real service).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentId, Attempt, JournalEvent, PixelWrite, ProjectId, ResourceRules, Rgb, TaskId, TemplateId } from '@geoplacer/core';
import { createAttemptManager, createResourceManager, encodeJournalLine } from '@geoplacer/core';
import { FileAttemptJournal, FileHistoryStore, acquireDataDirectoryLock } from '../src/index.js';

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const used = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
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
  return { attemptId: id as never, agent, projectId: 'projet' as ProjectId, templateId: 'modele' as TemplateId, revision: 3, writes: w, energyCost: w.length, state: 'leased', leasedAt: at, expiresAt: at + 60_000, startedAt: null, needsReconciliationAt: null, closedAt: null, results: [], reason: null };
}

const roots: string[] = [];
const newRoot = (): string => {
  const r = mkdtempSync(path.join(tmpdir(), 'geoplacer-journal-'));
  roots.push(r);
  return r;
};

try {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
  {
    const lock = await acquireDataDirectoryLock(newRoot());
    const journal = new FileAttemptJournal(lock);
    for (const n of [1, 100, 1000]) {
      const times: number[] = [];
      for (let k = 0; k < 30; k++) {
        const event: JournalEvent = { type: 'leased', attempt: attempt(randomUUID(), writes(n, k * n), k) };
        const t = performance.now();
        await journal.append(event);
        times.push(performance.now() - t);
      }
      console.log(JSON.stringify({ append: `lease of ${n} writes`, lineBytes: encodeJournalLine({ type: 'leased', attempt: attempt(randomUUID(), writes(n, 0), 0) }).length, medianMs: +median(times).toFixed(2) }));
    }
    await journal.close();
    await lock.release();
  }
  {
    const lock = await acquireDataDirectoryLock(newRoot());
    const journal = new FileAttemptJournal(lock);
    const history = new FileHistoryStore(lock);
    const resources = createResourceManager(rules);
    const manager = createAttemptManager({ journal, history, resources, newAttemptId: () => randomUUID() as never });
    let now = 1;
    await manager.recover(now++);
    resources.observe({ type: 'resource-observation', agent, observedAt: now++, energy: 1_000_000, currency: 0, unlockedColors: [RED], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
    const times: number[] = [];
    for (let k = 0; k < 20; k++) {
      const w = writes(1000, k * 1000);
      const t = performance.now();
      const a = await manager.lease({ agent, projectId: 'projet' as ProjectId, templateId: 'modele' as TemplateId, revision: 3, writes: w, now: now++, ttlMs: 60_000 });
      await manager.start(a.attemptId, now++);
      await manager.finish(a.attemptId, w.map((x) => ({ taskId: x.taskId, status: 'applied' as const })), now++);
      times.push(performance.now() - t);
    }
    console.log(JSON.stringify({ cycle: 'lease + start + finish + history, 1 000 writes', medianMs: +median(times).toFixed(2) }));
    await journal.close();
    await history.close();
    await lock.release();
  }
  for (const [attempts, size] of [
    [100, 1000],
    [1000, 1000],
    [10_000, 10],
  ] as const) {
    const root = newRoot();
    const file = path.join(root, 'journal', 'attempts.log');
    mkdirSync(path.dirname(file), { recursive: true });
    const parts: string[] = [];
    let at = 1;
    for (let k = 0; k < attempts; k++) {
      const id = `a-${k}`;
      const w = writes(size, (k * size) % (4096 * 4096));
      parts.push(encodeJournalLine({ type: 'leased', attempt: attempt(id, w, at++) }));
      if (k >= attempts - 5) continue; // left open
      parts.push(encodeJournalLine({ type: 'started', attemptId: id as never, at: at++ }));
      parts.push(encodeJournalLine({ type: 'finished', attemptId: id as never, at: at++, outcomes: w.map((x) => ({ taskId: x.taskId, status: 'applied' })) }));
    }
    writeFileSync(file, parts.join(''));
    parts.length = 0;
    const lock = await acquireDataDirectoryLock(root);
    const journal = new FileAttemptJournal(lock);
    const history = new FileHistoryStore(lock);
    const manager = createAttemptManager({ journal, history, resources: createResourceManager(rules), newAttemptId: () => randomUUID() as never });
    (globalThis as { gc?: () => void }).gc?.();
    const base = used();
    const t = performance.now();
    const report = await manager.recover(at + 1);
    const ms = performance.now() - t;
    console.log(
      JSON.stringify({
        recovery: `${attempts} attempts of ${size} writes`,
        fileMb: +(statSync(file).size / 1048576).toFixed(1),
        ms: Math.round(ms),
        released: report.released.length,
        extraMb: +((used() - base) / 1048576).toFixed(1),
      }),
    );
    await journal.close();
    await history.close();
    await lock.release();
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
