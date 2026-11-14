/**
 * WorkPlanner (Phase 1B.6): the next pixels to paint, in strategy order,
 * without generating the full order and without one object per pixel.
 *
 * prepareTemplate builds the order keys once per revision and strategy
 * (the random strategy through the verified order cache). nextBatch then:
 * 1. refuses stale or future snapshots, a foreign coordinate system,
 *    invalid, stale or uncertain resources, an unavailable agent;
 * 2. budget k = min(maxBatch, floor((energy - committed) / costPerPixel));
 * 3. scans the eligible region with the shared classification
 *    (progress/classify): a candidate is an incorrect pixel (wrong color or
 *    empty), or an unknown one if the policy says 'include', whose color the
 *    agent has unlocked and whose canvas point is not in flight;
 * 4. keeps the k candidates with the smallest order keys (bounded max-heap
 *    in typed arrays), sorted: exactly the first k of the strategy order
 *    filtered by the candidate rule. Task ids are built for those k only.
 */

import type {
  CanvasPointKey,
  Hasher,
  OrderCacheStore,
  PixelWrite,
  PlanRefusalCode,
  PlanRequest,
  PlanResult,
  PreparedTemplate,
  ProgressBasis,
  Rgb,
  TaskId,
  Template,
  WorkPlanner,
} from '../contracts/index.js';
import { canvasToImage, placementTransform } from '../geometry/projection.js';
import { PixelState, scanEligibleRows } from '../progress/classify.js';
import { snapshotFreshness } from '../progress/progress.js';
import { timeUntilEnergy } from '../resources/energy.js';
import { validateState } from '../resources/state.js';
import { prepareOrderKeys, type OrderKeys } from '../strategy/keys.js';
import { loadRandomOrder } from '../strategy/order-cache.js';
import { random } from '../strategy/center-random.js';

export const canvasPointKey = (x: number, y: number): CanvasPointKey => `${x},${y}`;

/** Deterministic task id: template, revision, canvas point, color. */
export const taskIdOf = (template: Pick<Template, 'projectId' | 'id' | 'revision'>, x: number, y: number, color: number): TaskId =>
  `${template.projectId}/${template.id}@${template.revision}:${x},${y}:#${color.toString(16).padStart(6, '0')}` as TaskId;

interface Prepared extends PreparedTemplate {
  readonly keys: OrderKeys;
}

/** Order keys of a revision, built once (random: through the optional verified cache). */
export async function prepareTemplate(template: Template, deps: { readonly hasher: Hasher; readonly orderCache?: OrderCacheStore }): Promise<PreparedTemplate> {
  const config = template.strategy;
  if (config.id !== 'random') {
    const keys = prepareOrderKeys(template.image, config);
    return { template, keySource: 'computed', keyProblem: null, keyBytes: keys.bytes, keys } as Prepared;
  }
  const cached = await loadRandomOrder(
    template.image,
    config,
    {
      projectId: template.projectId,
      templateId: template.id,
      revision: template.revision,
      strategy: 'random',
      strategyVersion: random.version,
      seed: config.seed ?? 0,
      quantizedImageHash: template.quantizedImageHash,
      format: 1,
    },
    { hasher: deps.hasher, ...(deps.orderCache === undefined ? {} : { store: deps.orderCache }) }
  );
  const keys = prepareOrderKeys(template.image, config, { randomOrder: cached.order });
  return { template, keySource: cached.source, keyProblem: cached.problem, keyBytes: keys.bytes, keys } as Prepared;
}

/** Synchronous preparation without cache (tests, small templates). */
export function prepareTemplateSync(template: Template): PreparedTemplate {
  const keys = prepareOrderKeys(template.image, template.strategy);
  return { template, keySource: template.strategy.id === 'random' ? 'generated' : 'computed', keyProblem: null, keyBytes: keys.bytes, keys } as Prepared;
}

function sameSystem(a: Template['coordinateSystem'], b: PlanRequest['snapshot']['coordinateSystem']): boolean {
  if (a.yAxis !== b.yAxis) return false;
  if (a.bounds === undefined || b.bounds === undefined) return a.bounds === b.bounds;
  return a.bounds.minX === b.bounds.minX && a.bounds.minY === b.bounds.minY && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

export function nextBatch(prepared: PreparedTemplate, request: PlanRequest): PlanResult {
  const { template } = prepared;
  const { keys } = prepared as Prepared;
  const { snapshot, resources, rules, now } = request;
  const refusals: { code: PlanRefusalCode; message: string }[] = [];
  const warnings: string[] = [];
  const empty = (status: PlanResult['status'], basis: ProgressBasis | null, extra: Partial<PlanResult> = {}): PlanResult => ({
    status,
    writes: [],
    refusals,
    candidates: 0,
    unavailableColors: [],
    skippedInFlight: 0,
    skippedUnknown: 0,
    budget: 0,
    waitMs: null,
    warnings,
    basis,
    ...extra,
  });

  // 1. Refusals.
  if (!isInt(now) || !isInt(request.maxBatch, 0) || !isInt(request.committedEnergy, 0) || keys === undefined) {
    refusals.push({ code: 'INVALID_REQUEST', message: 'now, maxBatch and committedEnergy must be non-negative integers, on a prepared template' });
    return empty('refused', null);
  }
  if (!sameSystem(template.coordinateSystem, snapshot.coordinateSystem)) {
    refusals.push({ code: 'COORDINATE_SYSTEM_MISMATCH', message: 'the snapshot is not in the template coordinate system' });
    return empty('refused', null);
  }
  const freshness = snapshotFreshness(snapshot, now, { ...(request.freshness === undefined ? {} : { freshness: request.freshness }) });
  const basis: ProgressBasis = { source: snapshot.source, kind: snapshot.source === 'simulated' ? 'simulation' : 'imported-observation', observedAt: snapshot.observedAt, freshness };
  if (freshness.status === 'stale') refusals.push({ code: 'STALE_SNAPSHOT', message: `the snapshot is ${freshness.ageMs} ms old, beyond the ${String(freshness.maxAgeMs)} ms policy: not the current canvas` });
  if (freshness.status === 'future') refusals.push({ code: 'FUTURE_SNAPSHOT', message: 'the snapshot is dated after now (inconsistent clocks)' });
  if (freshness.status === 'not-evaluated') warnings.push(`FRESHNESS_NOT_EVALUATED: snapshot ${freshness.ageMs} ms old, no policy for ${snapshot.source}`);
  try {
    validateState(rules, resources);
  } catch (error) {
    refusals.push({ code: 'INVALID_RESOURCES', message: error instanceof Error ? error.message : String(error) });
  }
  if (refusals.length === 0) {
    if (resources.agent !== request.agent) refusals.push({ code: 'INVALID_RESOURCES', message: 'the resource state belongs to another agent' });
    const age = now - resources.observedAt;
    if (request.maxResourceAgeMs !== undefined && age > request.maxResourceAgeMs) {
      refusals.push({ code: 'STALE_RESOURCES', message: `the resource observation is ${age} ms old, beyond ${request.maxResourceAgeMs} ms` });
    } else if (request.maxResourceAgeMs === undefined && age > 0) warnings.push(`RESOURCE_AGE_NOT_EVALUATED: resource observation ${age} ms old`);
    const uncertain = request.resourcesUncertainSince ?? null;
    if (uncertain !== null && resources.observedAt <= uncertain) {
      refusals.push({ code: 'RESOURCES_UNCERTAIN', message: 'an attempt ended with an unknown energy spending: a newer resource observation is required' });
    }
    const availability = resources.availability;
    if (availability.status === 'unavailable' && (availability.until === null || availability.until > now)) {
      refusals.push({ code: 'AGENT_UNAVAILABLE', message: `agent unavailable${availability.until === null ? '' : ` until ${availability.until}`}` });
    }
  }
  if (refusals.length > 0) return empty('refused', basis);

  // 2. Budget.
  const cost = rules.energy.costPerPixel;
  const budget = Math.floor(Math.max(0, resources.energy - request.committedEnergy) / cost);
  const k = Math.min(request.maxBatch, budget);

  // In-flight points as image indices (any template or revision: by canvas point).
  const { width } = template.image;
  const inFlight = new Set<number>();
  for (const key of request.inFlight) {
    const comma = key.indexOf(',');
    const point = canvasToImage({ x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) }, template.placement, template.coordinateSystem);
    if (point.ix >= 0 && point.iy >= 0 && point.ix < width && point.iy < template.image.height) inFlight.add(point.iy * width + point.ix);
  }
  const palette = new Set<number>(resources.unlockedColors);
  const missingColors = new Map<number, number>();
  const includeUnknown = request.unknownPixels === 'include';

  // 3-4. Scan and keep the k smallest keys (max-heap on the key).
  const heapKeys = new Float64Array(Math.max(1, k));
  const heapIdx = new Uint32Array(Math.max(1, k));
  let size = 0;
  const siftDown = (start: number): void => {
    let i = start;
    const key = heapKeys[i]!;
    const idx = heapIdx[i]!;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && heapKeys[child + 1]! > heapKeys[child]!) child++;
      if (heapKeys[child]! <= key) break;
      heapKeys[i] = heapKeys[child]!;
      heapIdx[i] = heapIdx[child]!;
      i = child;
    }
    heapKeys[i] = key;
    heapIdx[i] = idx;
  };
  const siftUp = (start: number): void => {
    let i = start;
    const key = heapKeys[i]!;
    const idx = heapIdx[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKeys[parent]! >= key) break;
      heapKeys[i] = heapKeys[parent]!;
      heapIdx[i] = heapIdx[parent]!;
      i = parent;
    }
    heapKeys[i] = key;
    heapIdx[i] = idx;
  };
  let candidates = 0;
  let skippedInFlight = 0;
  let skippedUnknown = 0;
  const pixels = template.image.pixels;
  scanEligibleRows(template, snapshot, (row) => {
    const base = row.iy * width + row.ix0;
    for (let c = 0; c < row.count; c++) {
      const state = row.states[c]!;
      if (state === PixelState.TRANSPARENT || state === PixelState.CORRECT) continue;
      if ((state === PixelState.UNKNOWN || state === PixelState.INVALID) && !includeUnknown) {
        skippedUnknown++;
        continue;
      }
      const index = base + c;
      const color = pixels[index]!;
      if (!palette.has(color)) {
        missingColors.set(color, (missingColors.get(color) ?? 0) + 1);
        continue;
      }
      if (inFlight.has(index)) {
        skippedInFlight++;
        continue;
      }
      candidates++;
      if (k === 0) continue;
      const key = keys.key(index);
      if (size < k) {
        heapKeys[size] = key;
        heapIdx[size] = index;
        siftUp(size++);
      } else if (key < heapKeys[0]!) {
        heapKeys[0] = key;
        heapIdx[0] = index;
        siftDown(0);
      }
    }
  });
  const unavailableColors = [...missingColors.entries()].sort((a, b) => a[0] - b[0]).map(([color, count]) => ({ color: color as Rgb, pixels: count }));
  const stats = { candidates, unavailableColors, skippedInFlight, skippedUnknown, budget };
  if (candidates === 0) return empty('nothing-to-do', basis, stats);
  if (k === 0) {
    return empty('waiting', basis, { ...stats, waitMs: timeUntilEnergy(rules, resources, request.committedEnergy + cost) });
  }
  // Selected pixels in key order (keys are distinct: total order).
  const chosen = Array.from({ length: size }, (_, i) => i).sort((a, b) => heapKeys[a]! - heapKeys[b]!);
  const t = placementTransform(template.placement, template.coordinateSystem);
  const writes: PixelWrite[] = chosen.map((h) => {
    const index = heapIdx[h]!;
    const iy = Math.floor(index / width);
    const ix = index - iy * width;
    const x = t.originX + ix;
    const y = t.originY + t.yStep * iy;
    const color = pixels[index]!;
    return { taskId: taskIdOf(template, x, y, color), point: { x, y }, color: color as Rgb };
  });
  return { status: 'ok', writes, refusals, ...stats, waitMs: null, warnings, basis };
}

export function createWorkPlanner(): WorkPlanner {
  return { nextBatch };
}
