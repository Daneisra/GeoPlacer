import { describe, expect, it } from 'vitest';
import type { AgentId, CanvasSnapshot, CoordinateSystem, PlanRequest, ProjectId, StrategyConfig, Template, TemplateId, TemplateImage } from '../src/index.js';
import {
  DRAWING_STRATEGIES,
  TRANSPARENT,
  TRANSPARENT_U32,
  UNKNOWN,
  createArraySnapshot,
  imageToCanvas,
  nextBatch,
  prepareTemplate,
  prepareTemplateSync,
  stateFromObservation,
} from '../src/index.js';
import { testHasher } from './helpers/ports.js';
import { BLUE, GOLD, GREEN, RED, SIMULATED_RULES as R, observation } from './helpers/resources.js';
import { image, testRandom } from './helpers/strategy.js';

const NOW = 1_000_000;
const AGENT = 'agent-1' as AgentId;
const COLORS = [RED, GREEN, BLUE, GOLD];

function template(img: TemplateImage, strategy: StrategyConfig = { id: 'top-to-bottom' }, x = 0, y = 0, system: CoordinateSystem = { yAxis: 'down' }, revision = 1): Template {
  return {
    id: 'modele' as TemplateId,
    projectId: 'projet' as ProjectId,
    name: 'm',
    revision,
    image: img,
    placement: { topLeft: { x, y } },
    coordinateSystem: system,
    palette: { id: 'p', colors: COLORS.map((rgb) => ({ rgb })) },
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

/** Canvas covering the template: `paint(ix, iy, expected)` returns what is observed there. */
function canvas(t: Template, paint: (ix: number, iy: number, expected: number) => number, extra: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  const { width, height } = t.image;
  const corners = [imageToCanvas({ ix: 0, iy: 0 }, t.placement, t.coordinateSystem), imageToCanvas({ ix: width - 1, iy: height - 1 }, t.placement, t.coordinateSystem)];
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const rect = { minX, minY, width, height };
  const pixels = new Int32Array(width * height).fill(TRANSPARENT);
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const p = imageToCanvas({ ix, iy }, t.placement, t.coordinateSystem);
      const e = t.image.pixels[iy * width + ix]!;
      pixels[(p.y - minY) * width + (p.x - minX)] = paint(ix, iy, e === TRANSPARENT_U32 ? TRANSPARENT : e);
    }
  }
  return { ...createArraySnapshot({ rect, coordinateSystem: t.coordinateSystem, source: 'simulated', observedAt: NOW, pixels }), ...extra };
}

function request(snapshot: CanvasSnapshot, extra: Partial<PlanRequest> = {}, obs: Parameters<typeof observation>[0] = {}): PlanRequest {
  const resources = stateFromObservation(R, observation({ agent: AGENT, observedAt: NOW, energy: 10, unlockedColors: [RED, GREEN, BLUE], ...obs }));
  return { agent: AGENT, snapshot, resources, rules: R, maxBatch: 1000, inFlight: new Set(), committedEnergy: 0, unknownPixels: 'skip', freshness: { simulated: { maxAgeMs: 60_000 } }, maxResourceAgeMs: 60_000, now: NOW, ...extra };
}

const art = (rows: string[]): TemplateImage =>
  image(rows[0]!.length, rows.length, (x, y) => ({ r: RED, g: GREEN, b: BLUE, o: GOLD } as Record<string, number>)[rows[y]![x]!] ?? null);

describe('WorkPlanner: candidates', () => {
  const t = template(art(['rgb', 'r.g']));

  it('proposes nothing on a fully correct canvas, the incorrect pixels otherwise, in strategy order', () => {
    expect(nextBatch(prepareTemplateSync(t), request(canvas(t, (_x, _y, e) => e)))).toMatchObject({ status: 'nothing-to-do', writes: [], candidates: 0 });
    const plan = nextBatch(prepareTemplateSync(t), request(canvas(t, () => TRANSPARENT)));
    expect(plan.status).toBe('ok');
    expect(plan.writes.map((w) => [w.point.x, w.point.y])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]]);
    expect(plan.writes[0]).toEqual({ taskId: 'projet/modele@1:0,0:#ff0000', point: { x: 0, y: 0 }, color: RED });
  });

  it('finds the last pixel of a nearly finished template, and a pixel that became incorrect again', () => {
    const nearly = canvas(t, (x, y, e) => (x === 2 && y === 1 ? RED : e));
    expect(nextBatch(prepareTemplateSync(t), request(nearly)).writes.map((w) => w.point)).toEqual([{ x: 2, y: 1 }]);
    // Painted correctly once, damaged later: offered again from the new snapshot.
    const damaged = canvas(t, (x, y, e) => (x === 0 && y === 0 ? BLUE : e));
    expect(nextBatch(prepareTemplateSync(t), request(damaged)).writes.map((w) => w.point)).toEqual([{ x: 0, y: 0 }]);
  });

  it('skips unknown pixels by default and paints them only with the explicit include policy', () => {
    const unknown = canvas(t, (x, _y, e) => (x === 1 ? UNKNOWN : e));
    expect(nextBatch(prepareTemplateSync(t), request(unknown))).toMatchObject({ status: 'nothing-to-do', skippedUnknown: 1 });
    expect(nextBatch(prepareTemplateSync(t), request(unknown, { unknownPixels: 'include' })).writes.map((w) => w.point)).toEqual([{ x: 1, y: 0 }]);
  });

  it('reports colors the agent cannot paint, and skips points already in flight', () => {
    const gold = template(art(['oor', 'rro']));
    const plan = nextBatch(prepareTemplateSync(gold), request(canvas(gold, () => TRANSPARENT)));
    expect(plan.unavailableColors).toEqual([{ color: GOLD, pixels: 3 }]);
    expect(plan.writes.map((w) => w.color)).toEqual([RED, RED, RED]);
    const busy = nextBatch(prepareTemplateSync(t), request(canvas(t, () => TRANSPARENT), { inFlight: new Set(['0,0', '2,1', '99,99']) }));
    expect(busy.skippedInFlight).toBe(2);
    expect(busy.writes.map((w) => `${w.point.x},${w.point.y}`)).toEqual(['1,0', '2,0', '0,1']);
  });

  it('limits the batch to the affordable energy, minus the energy already committed', () => {
    const s = canvas(t, () => TRANSPARENT);
    expect(nextBatch(prepareTemplateSync(t), request(s, {}, { energy: 3 })).writes.length).toBe(3);
    expect(nextBatch(prepareTemplateSync(t), request(s, { committedEnergy: 2 }, { energy: 3 })).writes.length).toBe(1);
    const waiting = nextBatch(prepareTemplateSync(t), request(s, { committedEnergy: 3 }, { energy: 3, regenProgressMs: 400 }));
    expect(waiting).toMatchObject({ status: 'waiting', writes: [], budget: 0, candidates: 5, waitMs: 600 });
    expect(nextBatch(prepareTemplateSync(t), request(s, { maxBatch: 2 })).writes.length).toBe(2);
  });
});

describe('WorkPlanner: refusals (never a stale or uncertain state taken as current)', () => {
  const t = template(art(['rg']));
  const s = canvas(t, () => TRANSPARENT);
  const codes = (r: PlanRequest) => nextBatch(prepareTemplateSync(t), r).refusals.map((x) => x.code);

  it('refuses stale or future snapshots, a foreign coordinate system, stale, uncertain or unavailable resources', () => {
    expect(codes(request(s, { now: NOW + 120_000 }, { observedAt: NOW + 120_000 }))).toEqual(['STALE_SNAPSHOT']);
    expect(codes(request(canvas(t, () => TRANSPARENT, { observedAt: NOW + 5 })))).toEqual(['FUTURE_SNAPSHOT']);
    expect(codes(request({ ...s, coordinateSystem: { yAxis: 'up' } }))).toEqual(['COORDINATE_SYSTEM_MISMATCH']);
    expect(codes(request(s, { now: NOW + 70_000, freshness: {} }))).toEqual(['STALE_RESOURCES']);
    expect(codes(request(s, { resourcesUncertainSince: NOW }))).toEqual(['RESOURCES_UNCERTAIN']);
    expect(codes(request(s, { resourcesUncertainSince: NOW - 1 }))).toEqual([]);
    expect(codes(request(s, {}, { availability: { status: 'unavailable', until: NOW + 10 } }))).toEqual(['AGENT_UNAVAILABLE']);
    expect(codes(request(s, { resources: { ...request(s).resources, energy: -1 } }))).toEqual(['INVALID_RESOURCES']);
    expect(nextBatch(prepareTemplateSync(t), request(s, { freshness: {}, maxResourceAgeMs: undefined as never })).warnings[0]).toMatch(/FRESHNESS_NOT_EVALUATED/);
  });

  it('gives new task ids to a new revision, while in-flight points of the old one stay excluded', () => {
    const v1 = nextBatch(prepareTemplateSync(t), request(s)).writes;
    const t2 = template(art(['rg']), { id: 'top-to-bottom' }, 0, 0, { yAxis: 'down' }, 2);
    const v2 = nextBatch(prepareTemplateSync(t2), request(s, { inFlight: new Set(v1.slice(0, 1).map((w) => `${w.point.x},${w.point.y}`)) })).writes;
    expect(v2.map((w) => w.taskId)).toEqual(['projet/modele@2:1,0:#00ff00']);
  });
});

describe('WorkPlanner: properties', () => {
  it('equals the first k entries of the strategy order filtered by the candidate rule (8 strategies)', () => {
    const pick = testRandom(919);
    const strategies = Object.values(DRAWING_STRATEGIES);
    for (let n = 0; n < 160; n++) {
      const img = image(1 + pick(18), 1 + pick(18), () => (pick(5) === 0 ? null : COLORS[pick(4)]!));
      const s = strategies[pick(strategies.length)]!;
      const config: StrategyConfig = s.id === 'random' ? { id: 'random', seed: pick(500) } : { id: s.id };
      const yAxis = pick(2) === 0 ? 'down' : 'up';
      const bounded = pick(2) === 0;
      const system: CoordinateSystem = bounded ? { yAxis, bounds: { minX: 0, minY: -40, width: 30, height: 80 } } : { yAxis };
      const t = template(img, config, pick(20), pick(20) - 10, system);
      const states = [TRANSPARENT, UNKNOWN, RED, GREEN, BLUE, GOLD, 0x1000000];
      const observed = new Map<number, number>();
      const snap = canvas(t, (ix, iy, e) => {
        const v = pick(3) === 0 ? e : states[pick(states.length)]!;
        observed.set(iy * img.width + ix, v);
        return v;
      });
      const include = pick(2) === 0;
      const palette = COLORS.filter(() => pick(4) !== 0);
      const inFlightIdx = new Set<number>();
      const inFlight = new Set<string>();
      for (let f = 0; f < 3; f++) {
        const i = pick(img.width * img.height);
        inFlightIdx.add(i);
        const p = imageToCanvas({ ix: i % img.width, iy: Math.floor(i / img.width) }, t.placement, t.coordinateSystem);
        inFlight.add(`${p.x},${p.y}`);
      }
      const energy = pick(12);
      const maxBatch = 1 + pick(8);
      const req = request(snap, { inFlight, unknownPixels: include ? 'include' : 'skip', maxBatch }, { energy: Math.min(energy, 10), unlockedColors: palette.filter((c) => c !== GOLD), ...(palette.includes(GOLD) ? { currency: 0 } : {}) });
      const plan = nextBatch(prepareTemplateSync(t), req);
      // Reference: the strategy order over the eligible region, filtered by the candidate rule.
      const unlocked = new Set<number>(req.resources.unlockedColors);
      const region = { ix: 0, iy: 0, width: img.width, height: img.height };
      const eligible = (i: number) => {
        const p = imageToCanvas({ ix: i % img.width, iy: Math.floor(i / img.width) }, t.placement, t.coordinateSystem);
        return !bounded || (p.x >= 0 && p.x < 30 && p.y >= -40 && p.y < 40);
      };
      const candidate = (i: number) => {
        const e = img.pixels[i]!;
        const v = observed.get(i)!;
        const unknown = v === UNKNOWN || !(v === TRANSPARENT || (Number.isInteger(v) && v >= 0 && v <= 0xffffff));
        const incorrect = v !== e && !unknown;
        return eligible(i) && (incorrect || (unknown && include)) && unlocked.has(e) && !inFlightIdx.has(i);
      };
      const reference = [...s.order(img, config, region)].filter(candidate);
      const k = Math.min(maxBatch, Math.min(energy, 10));
      const expected = reference.slice(0, k).map((i) => {
        const p = imageToCanvas({ ix: i % img.width, iy: Math.floor(i / img.width) }, t.placement, t.coordinateSystem);
        return `${p.x},${p.y}`;
      });
      expect(plan.writes.map((w) => `${w.point.x},${w.point.y}`), `${s.id} #${n}`).toEqual(expected);
      expect(plan.candidates).toBe(reference.length);
      expect(new Set(plan.writes.map((w) => w.taskId)).size).toBe(plan.writes.length);
      // Deterministic.
      expect(nextBatch(prepareTemplateSync(t), req).writes).toEqual(plan.writes);
    }
  });

  it('plans the random strategy identically with and without the order cache', async () => {
    const img = image(30, 20, (x, y) => ((x + y) % 6 === 0 ? null : COLORS[(x * y) % 3]!));
    const t = template(img, { id: 'random', seed: 12 });
    const s = canvas(t, () => TRANSPARENT);
    const prepared = await prepareTemplate(t, { hasher: testHasher });
    expect(prepared.keySource).toBe('generated');
    expect(nextBatch(prepared, request(s)).writes).toEqual(nextBatch(prepareTemplateSync(t), request(s)).writes);
  });
});
