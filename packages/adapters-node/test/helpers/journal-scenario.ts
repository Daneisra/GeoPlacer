/**
 * Deterministic attempt scenario on the real file journal (tests and the
 * crash child). Everything is local: no canvas writes, synthetic resource
 * rules (not a real service).
 */

import path from 'node:path';
import type { AgentId, AttemptManager, JournalEvent, JournalState, ProjectId, ResourceRules, Rgb, TaskId, TemplateId } from '@geoplacer/core';
import { JournalStateBuilder, createAttemptManager, createMemoryHistory, createResourceManager, decodeJournal } from '@geoplacer/core';
import type { JournalFs } from '../../src/index.js';
import { FileAttemptJournal, checkpointName, decodePointer, generationsIn, logName, nodeJournalFs } from '../../src/index.js';
import type { DataDirectoryLock } from '../../src/lock.js';

export const RED = 0xff0000 as Rgb;
export const AGENT = 'agent-1' as AgentId;
const W = 64;

// SYNTHETIC rules (tests only).
export const RULES: ResourceRules = {
  schemaVersion: 1,
  id: 'test-simulated-journal',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 1_000_000, capacityLimit: 1_000_000, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};

export interface Harness {
  readonly journal: FileAttemptJournal;
  readonly manager: AttemptManager;
  readonly clock: { now: number };
  /** The agent's resources observed now (newer than any spending). */
  readonly observe: () => void;
}

/** Journals opened by openHarness (tests close them all at the end). */
export const openedJournals: FileAttemptJournal[] = [];

export function openHarness(lock: DataDirectoryLock, options: { fs?: JournalFs; retainGenerations?: number; base?: number; idPrefix?: string } = {}): Harness {
  const journal = new FileAttemptJournal(lock, { fs: options.fs ?? nodeJournalFs, retainGenerations: options.retainGenerations ?? 100 });
  openedJournals.push(journal);
  const resources = createResourceManager(RULES);
  const clock = { now: options.base ?? 1_000_000 };
  let ids = 0;
  const prefix = options.idPrefix ?? 'a';
  const manager = createAttemptManager({ journal, history: createMemoryHistory(), resources, newAttemptId: () => `${prefix}-${++ids}` as never });
  const observe = (): void => {
    resources.observe({ type: 'resource-observation', agent: AGENT, observedAt: ++clock.now, energy: 1_000_000, currency: 0, unlockedColors: [RED], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
  };
  return { journal, manager, clock, observe };
}

/** Runs `count` deterministic steps from step `from`: some attempts left leased, some started, the others closed; compacts every `compactEvery` steps. */
export async function runSteps(h: Harness, from: number, count: number, compactEvery = 0): Promise<void> {
  const tick = (): number => ++h.clock.now;
  for (let i = from; i < from + count; i++) {
    const x = i % W;
    const y = Math.floor(i / W) % W;
    if (h.manager.inFlight().has(`${x},${y}`)) continue;
    h.observe();
    const writes = Array.from({ length: 1 + (i % 3) }, (_, k) => ({ taskId: `p/m@1:${x},${y + k * W}:#ff0000` as TaskId, point: { x, y: y + k * W }, color: RED }));
    const leased = await h.manager.lease({ agent: AGENT, projectId: 'p' as ProjectId, templateId: 'm' as TemplateId, revision: 1, writes, now: tick(), ttlMs: 1_000_000_000 });
    if (i % 7 !== 3) {
      await h.manager.start(leased.attemptId, tick());
      if (i % 11 !== 5) {
        if (i % 5 === 0) await h.manager.fail(leased.attemptId, 'simulated rejection', writes.map((w) => ({ taskId: w.taskId, status: 'rejected' as const, reason: 'other' as const })), tick());
        else await h.manager.finish(leased.attemptId, writes.map((w) => ({ taskId: w.taskId, status: 'applied' as const })), tick());
      }
    }
    if (compactEvery > 0 && (i + 1) % compactEvery === 0) await h.manager.compact(tick());
  }
}

/** Loads a journal into a state, without a manager (no recovery side effects). */
export async function loadState(journal: FileAttemptJournal): Promise<JournalState> {
  let builder = new JournalStateBuilder();
  await journal.load({ checkpoint: (s) => (builder = JournalStateBuilder.from(s)), event: (e, seq) => void builder.apply(e, seq) });
  return builder.toState();
}

/**
 * Reference "full journal" state: replays the logs of every kept generation
 * from 0 up to the one in use (needs all generations kept).
 */
export async function fullReplay(root: string): Promise<{ state: JournalState; inconsistent: number; events: number }> {
  const dir = path.join(root, 'journal');
  const { readFile, readdir } = await import('node:fs/promises');
  const names = await readdir(dir);
  const pointer = names.includes('CURRENT') ? decodePointer(new Uint8Array(await readFile(path.join(dir, 'CURRENT')))) : 0;
  if (pointer === null) throw new Error('bad pointer');
  const builder = new JournalStateBuilder();
  let inconsistent = 0;
  let events = 0;
  for (let g = 0; g <= pointer; g++) {
    if (!names.includes(logName(g))) {
      if (g === 0) continue;
      throw new Error(`generation ${g} not kept`);
    }
    const decoded = decodeJournal(new Uint8Array(await readFile(path.join(dir, logName(g)))));
    if (decoded.corruptLines.length > 0) throw new Error(`generation ${g} damaged`);
    for (const { event, seq } of decoded.entries) {
      events++;
      if (builder.apply(event as JournalEvent, seq) !== null) inconsistent++;
    }
  }
  return { state: builder.toState(), inconsistent, events };
}

export async function journalFiles(root: string): Promise<{ names: string[]; pointer: number | null; gens: ReturnType<typeof generationsIn> }> {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = path.join(root, 'journal');
  const names = (await readdir(dir)).sort();
  const pointer = names.includes('CURRENT') ? decodePointer(new Uint8Array(await readFile(path.join(dir, 'CURRENT')))) : null;
  return { names, pointer, gens: generationsIn(names) };
}

export { checkpointName, logName };
