/**
 * Phase 1B.8: after a damaged journal, a recent timestamp alone never
 * suffices. Every lease carries its evidence (a read newer than the
 * damage with a valid value at each leased point) and an uncertain
 * attempt closes only when each of its pixels was observed.
 */

import { describe, expect, it } from 'vitest';
import type { AgentId, AttemptJournal, AttemptManager, CanvasSnapshot, JournalEvent, JournalState, PixelWrite, ProjectId, TaskId, Template, TemplateId } from '../src/index.js';
import {
  AttemptError,
  JournalStateBuilder,
  TRANSPARENT,
  UNKNOWN,
  createArraySnapshot,
  createAttemptManager,
  createMemoryHistory,
  createMemoryJournal,
  createResourceManager,
  nextBatch,
  prepareTemplateSync,
  replayJournal,
  stateFromObservation,
  upgradeJournalState,
} from '../src/index.js';
import { RED, SIMULATED_RULES as R, observation } from './helpers/resources.js';
import { image } from './helpers/strategy.js';

const A = 'agent-1' as AgentId;
const P = 'projet' as ProjectId;
const T = 'modele' as TemplateId;
const W = 8;
const H = 4;

/** A canvas read of rect (x0, y0, w, h) at `at`; `value(x, y)` gives each pixel (default: empty). */
function read(at: number, x0 = 0, y0 = 0, w = W, h = H, value: (x: number, y: number) => number = () => TRANSPARENT): CanvasSnapshot {
  const pixels = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = value(x0 + x, y0 + y);
  return createArraySnapshot({ rect: { minX: x0, minY: y0, width: w, height: h }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: at, pixels });
}

const writes = (points: readonly [number, number][], tag = 'w'): PixelWrite[] => points.map(([x, y]) => ({ taskId: `${tag}-${x},${y}` as TaskId, point: { x, y }, color: RED }));
const row = (y: number, from: number, to: number): [number, number][] => Array.from({ length: to - from }, (_, k) => [from + k, y]);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof AttemptError ? error.code : String(error);
  }
}

interface World {
  journal: ReturnType<typeof createMemoryJournal>;
  manager: AttemptManager;
  resources: ReturnType<typeof createResourceManager>;
  now: number;
}

/** A journal with started attempts on distinct zones, then a "damaged" recovery (lines lost). */
async function damagedWorld(zones: readonly [number, number][][]): Promise<World & { ids: string[] }> {
  const journal = createMemoryJournal();
  let ids = 0;
  const resources = createResourceManager(R);
  const before = createAttemptManager({ journal, history: createMemoryHistory(), resources, newAttemptId: () => `a-${++ids}` as never });
  await before.recover(1_000);
  resources.observe(observation({ agent: A, observedAt: 1_001, energy: 10, unlockedColors: [RED] }));
  const started: string[] = [];
  let now = 1_002;
  for (const zone of zones) {
    const a = await before.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: writes(zone), now: now++, ttlMs: 1e9 });
    await before.start(a.attemptId, now++);
    started.push(a.attemptId);
  }
  // The new process sees damage (a line lost before the end).
  const damaged: AttemptJournal = {
    load: async (visitor) => ({ ...(await journal.load(visitor)), corruptLines: [2] }),
    append: (e) => journal.append(e),
    stats: () => journal.stats(),
    compact: (s) => journal.compact(s),
  };
  const res2 = createResourceManager(R);
  const manager = createAttemptManager({ journal: damaged, history: createMemoryHistory(), resources: res2, newAttemptId: () => `b-${++ids}` as never });
  const report = await manager.recover(2_000);
  expect(report).toMatchObject({ damaged: true, released: [], damage: { at: 2_000 } });
  res2.observe(observation({ agent: A, observedAt: 2_001, energy: 10, unlockedColors: [RED] }));
  return { journal, manager, resources: res2, now: 2_002, ids: started };
}

const lease = (w: World, points: [number, number][], evidence?: CanvasSnapshot, tag = 'n') =>
  w.manager.lease({ agent: A, projectId: P, templateId: T, revision: 1, writes: writes(points, tag), now: w.now++, ttlMs: 100, ...(evidence === undefined ? {} : { evidence }) });

describe('leases after damage need evidence covering every leased point', () => {
  it('a recent read of one pixel, of half the pixels: refused; a complete read: accepted', async () => {
    const w = await damagedWorld([]);
    const points = row(3, 0, 6);
    expect(await code(lease(w, points))).toBe('EVIDENCE_REQUIRED'); // no read at all
    expect(await code(lease(w, points, read(1_999)))).toBe('EVIDENCE_REQUIRED'); // older than the damage
    expect(await code(lease(w, points, read(2_500, 0, 3, 1, 1)))).toBe('EVIDENCE_REQUIRED'); // one pixel
    expect(await code(lease(w, points, read(2_500, 0, 3, 3, 1)))).toBe('EVIDENCE_REQUIRED'); // half of them
    expect(await code(lease(w, points, read(2_500)))).toBe('resolved'); // complete
    expect(w.manager.damage()).toEqual({ at: 2_000, reason: 'recovered from a damaged journal' }); // never lifted by a read
  });

  it('unknown or invalid values in the read do not count as observed', async () => {
    const w = await damagedWorld([]);
    const points = row(0, 0, 4);
    for (const bad of [UNKNOWN, Number.NaN, 0x1000000, -5, 1.5, Number.POSITIVE_INFINITY]) {
      // Raw values from get() (an Int32Array would coerce NaN or 1.5 into valid integers).
      const base = read(2_500);
      const evidence: CanvasSnapshot = { rect: base.rect, coordinateSystem: base.coordinateSystem, source: base.source, observedAt: base.observedAt, get: (p) => (p.x === 2 ? bad : TRANSPARENT) as never };
      expect({ bad, result: await code(lease(w, points, evidence)) }).toEqual({ bad, result: 'EVIDENCE_REQUIRED' });
    }
    expect(await code(lease(w, points, read(2_500, 0, 0, W, H, () => 0x00ff00)))).toBe('resolved'); // a wrong color is still an observation
  });

  it('the WorkPlanner refuses a read taken at or before the damage and never proposes unknown pixels then', () => {
    const t: Template = { id: T, projectId: P, name: 'm', revision: 1, image: image(W, H, () => RED), placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' }, palette: { id: 'p', colors: [{ rgb: RED }] }, alphaThreshold: 128, quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 }, priority: 0, status: 'active', strategy: { id: 'top-to-bottom' }, sourceImageHash: 'a'.repeat(64), quantizedImageHash: 'b'.repeat(64), createdAt: 0, updatedAt: 0, warnings: [] };
    const prepared = prepareTemplateSync(t);
    const resources = stateFromObservation(R, observation({ agent: A, observedAt: 2_500, energy: 10, unlockedColors: [RED] }));
    const halfUnknown = read(2_500, 0, 0, W, H, (_x, y) => (y < 2 ? TRANSPARENT : UNKNOWN));
    const req = (snapshot: CanvasSnapshot, damageFloor: number | null) =>
      nextBatch(prepared, { agent: A, snapshot, resources, rules: R, maxBatch: 100, inFlight: new Set(), committedEnergy: 0, unknownPixels: 'include', damageFloor, now: 2_500 });
    expect(req(read(2_000), 2_000).refusals.map((r) => r.code)).toEqual(['SNAPSHOT_BEFORE_DAMAGE']);
    expect(req(halfUnknown, null).writes).toHaveLength(10); // without damage, 'include' takes unknown pixels (16 > budget 10)
    const planned = req(halfUnknown, 2_000).writes;
    expect(planned.every((x) => x.point.y < 2)).toBe(true); // with damage: observed pixels only
    expect(planned).toHaveLength(10);
  });
});

describe('uncertain attempts close only when every pixel was observed', () => {
  it('one pixel, half, then all: the attempt stays open (points reserved) until fully observed', async () => {
    const zone = row(1, 0, 6);
    const w = await damagedWorld([zone]);
    const id = w.ids[0]! as never;
    expect([...w.manager.inFlight()].sort()).toEqual(zone.map(([x, y]) => `${x},${y}`).sort());
    expect(await code(w.manager.reconcile(id, read(2_500, 0, 1, 1, 1), w.now++))).toBe('INCOMPLETE_OBSERVATION');
    expect(await code(w.manager.reconcile(id, read(2_500, 0, 1, 3, 1), w.now++))).toBe('INCOMPLETE_OBSERVATION');
    expect(w.manager.inFlight().size).toBe(6);
    expect(await code(lease(w, [[2, 1]], read(2_500)))).toBe('OVERLAP'); // still reserved
    const closed = await w.manager.reconcile(id, read(2_500, 0, 0, W, H, (x) => (x < 3 ? RED : TRANSPARENT)), w.now++);
    expect(closed.results.map((r) => r.result)).toEqual(['observed-correct', 'observed-correct', 'observed-correct', 'observed-incorrect', 'observed-incorrect', 'observed-incorrect']);
    expect(w.manager.inFlight().size).toBe(0);
  });

  it('several snapshots covering progressively: accepted together; the newest valid value counts', async () => {
    const w = await damagedWorld([row(2, 0, 6)]);
    const id = w.ids[0]! as never;
    const left = read(2_400, 0, 2, 3, 1, () => TRANSPARENT);
    const right = read(2_450, 3, 2, 3, 1, () => RED);
    const newer = read(2_500, 0, 2, 1, 1, () => RED); // overrides x=0 of `left`
    const closed = await w.manager.reconcile(id, [left, right, newer], w.now++);
    expect(closed.results.map((r) => r.result)).toEqual(['observed-correct', 'observed-incorrect', 'observed-incorrect', 'observed-correct', 'observed-correct', 'observed-correct']);
    expect(await code(w.manager.reconcile(id, newer, w.now++))).toBe('INVALID_TRANSITION');
  });

  it('several uncertain attempts on distinct zones: each closes with a read of its own zone, the others stay reserved', async () => {
    const zoneA = row(0, 0, 3);
    const zoneB = row(3, 5, 8);
    const w = await damagedWorld([zoneA, zoneB]);
    const [idA, idB] = w.ids as [never, never];
    const readA = read(2_500, 0, 0, 3, 1);
    expect(await code(w.manager.reconcile(idB, readA, w.now++))).toBe('INCOMPLETE_OBSERVATION');
    await w.manager.reconcile(idA, readA, w.now++);
    expect([...w.manager.inFlight()].sort()).toEqual(zoneB.map(([x, y]) => `${x},${y}`).sort());
    await w.manager.reconcile(idB, read(2_600, 5, 3, 3, 1), w.now++);
    expect(w.manager.inFlight().size).toBe(0);
  });

  it('a stale read never counts, and unknown values in a complete read keep the attempt open', async () => {
    const w = await damagedWorld([row(1, 0, 4)]);
    const id = w.ids[0]! as never;
    expect(await code(w.manager.reconcile(id, [read(2_500), read(1_500)], w.now++))).toBe('STALE_SNAPSHOT');
    expect(await code(w.manager.reconcile(id, read(2_500, 0, 0, W, H, (x) => (x === 1 ? UNKNOWN : RED)), w.now++))).toBe('INCOMPLETE_OBSERVATION');
    expect(w.manager.open()).toHaveLength(1);
  });

  it('a pixel changed on the canvas after its reconciliation is planned and leased again with new evidence', async () => {
    const zone = row(0, 0, 2);
    const w = await damagedWorld([zone]);
    await w.manager.reconcile(w.ids[0]! as never, read(2_500, 0, 0, W, H, () => RED), w.now++);
    w.resources.observe(observation({ agent: A, observedAt: 2_900, energy: 10, unlockedColors: [RED] })); // spending of the reconciled attempt unknown
    w.now = 3_001;
    // Another actor erased (1,0): a later read shows it empty; the lease of that pixel is accepted with that read.
    const later = read(3_000, 0, 0, W, H, (x, y) => (x === 1 && y === 0 ? TRANSPARENT : RED));
    expect(await code(lease(w, [[1, 0]], later, 'again'))).toBe('resolved');
  });
});

describe('damage persists and replays conservatively', () => {
  it('survives a compaction and a restart; is never lifted by a later read', async () => {
    const w = await damagedWorld([row(0, 0, 2)]);
    await w.manager.reconcile(w.ids[0]! as never, read(2_500), w.now++);
    // A fresh manager over the plain journal (not damaged any more), with the damage event journaled.
    const manager = createAttemptManager({ journal: w.journal, history: createMemoryHistory(), resources: w.resources, newAttemptId: () => 'c-1' as never });
    const report = await manager.recover(3_000);
    expect(report).toMatchObject({ damaged: false, damage: { at: 2_000 } });
    await manager.compact(3_001);
    expect(w.journal.checkpoint?.damage).toEqual({ at: 2_000, reason: 'recovered from a damaged journal' });
    const again = createAttemptManager({ journal: w.journal, history: createMemoryHistory(), resources: w.resources, newAttemptId: () => 'c-2' as never });
    expect(await again.recover(3_100)).toMatchObject({ damage: { at: 2_000 } });
  });

  it('a "canvas-verified" event of Phase 1B.7 has no effect; a schema-1 checkpoint requirement becomes damage', () => {
    const events: { event: JournalEvent; seq: number }[] = [
      { event: { type: 'canvas-read-required', at: 10, reason: 'r' }, seq: 1 },
      { event: { type: 'canvas-verified', at: 11, observedAt: 11 }, seq: 2 },
    ];
    const { state, inconsistent } = replayJournal(null, events);
    expect(inconsistent).toBe(0);
    expect(state.damage).toEqual({ at: 10, reason: 'r' });
    const v1 = { ...new JournalStateBuilder().toState(), schemaVersion: 1, canvasReadRequiredAfter: 42 } as unknown;
    delete (v1 as { damage?: unknown }).damage;
    expect(upgradeJournalState(v1)).toMatchObject({ schemaVersion: 2, damage: { at: 42 } });
    const clean = { ...(v1 as object), canvasReadRequiredAfter: null };
    expect(upgradeJournalState(clean)).toMatchObject({ damage: null });
    expect(upgradeJournalState({ ...(clean as object), schemaVersion: 3 })).toBeNull();
    const asState = upgradeJournalState(v1) as JournalState;
    expect(JournalStateBuilder.from(asState).damage).toEqual({ at: 42, reason: 'canvas read required (checkpoint of Phase 1B.7)' });
  });
});
