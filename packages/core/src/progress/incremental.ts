/**
 * Incremental progress (Phase 1B.10 prototype, measured).
 *
 * computeProgress classifies every eligible pixel at every call (about half
 * of a scheduler cycle on a 2000 x 2000 template). This calculator keeps the
 * observed values of the previous call and the counters per color: each call
 * reads the eligible rows (a copy), compares them with the previous values
 * (a tight integer loop) and reclassifies ONLY the pixels that changed,
 * whoever changed them (the agent, an outside actor): nothing is assumed
 * about the cause of a change, so outside modifications are still seen.
 *
 * Safety:
 * - same classification as the full computation (classifyValue);
 * - rebuilt from scratch on any change of template, revision, image,
 *   placement, coordinate system or snapshot rectangle, after `invalidate()`
 *   (restore, new world), and every `rebuildEvery` calls;
 * - every `verifyEvery` calls, the result is compared with the full
 *   computeProgress: on any difference the full result is used, the state
 *   is rebuilt and the mismatch is counted (never a stale counter);
 * - snapshots without readRow (point reads, possibly non-integer values)
 *   always use the full computation.
 */

import type { CanvasSnapshot, ProgressOptions, ProgressSnapshot, ProgressTemplate, Timestamp } from '../contracts/index.js';
import { TRANSPARENT_U32, UNKNOWN } from '../contracts/index.js';
import { placementTransform } from '../geometry/projection.js';
import { eligibleRegion } from '../strategy/common.js';
import { PixelState, classifyValue } from './classify.js';
import { assembleProgress, computeProgress } from './progress.js';

export interface IncrementalProgressOptions {
  readonly options?: ProgressOptions;
  /** Compare with the full computation every this many incremental calls (default 10; 0: never). */
  readonly verifyEvery?: number;
  /** Rebuild from scratch every this many calls (default 100). */
  readonly rebuildEvery?: number;
}

export interface IncrementalProgressStats {
  readonly full: number;
  readonly incremental: number;
  readonly verified: number;
  readonly mismatches: number;
  /** Pixels reclassified by the last incremental call. */
  readonly lastChanged: number;
}

export interface IncrementalProgress {
  compute(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp): ProgressSnapshot;
  /** Forget everything (restore, new world): the next call is a full rebuild. */
  invalidate(): void;
  readonly stats: IncrementalProgressStats;
}

/** Counter index of a state: total is 0; correct 1, wrongColor 2, missing 3, unknown (and invalid) 4. */
const COUNTER = [0, 1, 2, 3, 4, 4];

interface State {
  readonly key: string;
  readonly template: ProgressTemplate;
  readonly region: { readonly ix: number; readonly iy: number; readonly width: number; readonly height: number };
  readonly x0: number;
  readonly yOf: (iy: number) => number;
  values: Int32Array;
  readonly slotOf: Int32Array;
  readonly colors: number[];
  readonly counters: Float64Array;
  invalid: number;
  readonly transparent: number;
}

function keyOf(template: ProgressTemplate, snapshot: CanvasSnapshot): string {
  const p = template.placement;
  const r = snapshot.rect;
  return `${template.id}|${template.revision}|${template.image.width}x${template.image.height}|${p.topLeft.x},${p.topLeft.y}|${template.coordinateSystem.yAxis}|${snapshot.coordinateSystem.yAxis}|${r.minX},${r.minY},${r.width},${r.height}`;
}

/** Reads the eligible region's observed values (UNKNOWN outside the snapshot rectangle), row-major. */
function readEligible(snapshot: CanvasSnapshot, region: State['region'], x0: number, yOf: (iy: number) => number, out: Int32Array): void {
  const readRow = snapshot.readRow!.bind(snapshot);
  const { minX: rx0, minY: ry0 } = snapshot.rect;
  const rx1 = rx0 + snapshot.rect.width;
  const ry1 = ry0 + snapshot.rect.height;
  const kFrom = Math.max(0, Math.min(region.width, rx0 - x0));
  const kTo = Math.max(kFrom, Math.min(region.width, rx1 - x0));
  out.fill(UNKNOWN);
  for (let r = 0; r < region.height; r++) {
    const y = yOf(region.iy + r);
    if (y < ry0 || y >= ry1 || kTo <= kFrom) continue;
    const row = r * region.width;
    readRow(y, x0 + kFrom, x0 + kTo, out.subarray(row + kFrom, row + kTo));
  }
}

export function createIncrementalProgress(config: IncrementalProgressOptions = {}): IncrementalProgress {
  const options = config.options ?? {};
  const verifyEvery = config.verifyEvery ?? 10;
  const rebuildEvery = config.rebuildEvery ?? 100;
  let state: State | null = null;
  let sinceRebuild = 0;
  let sinceVerify = 0;
  const stats = { full: 0, incremental: 0, verified: 0, mismatches: 0, lastChanged: 0 };

  function rebuild(template: ProgressTemplate, snapshot: CanvasSnapshot): State {
    const { image, placement, coordinateSystem } = template;
    const region = eligibleRegion(image, placement, coordinateSystem);
    const t = placementTransform(placement, coordinateSystem);
    const yOf = (iy: number): number => t.originY + t.yStep * iy;
    const x0 = t.originX + region.ix;
    const values = new Int32Array(region.width * region.height);
    readEligible(snapshot, region, x0, yOf, values);
    const slotOf = new Int32Array(region.width * region.height).fill(-1);
    const colors: number[] = [];
    const slots = new Map<number, number>();
    for (let r = 0; r < region.height; r++) {
      const base = (region.iy + r) * image.width + region.ix;
      for (let k = 0; k < region.width; k++) {
        const expected = image.pixels[base + k]!;
        if (expected === TRANSPARENT_U32) continue;
        let slot = slots.get(expected);
        if (slot === undefined) {
          slot = colors.length;
          slots.set(expected, slot);
          colors.push(expected);
        }
        slotOf[r * region.width + k] = slot;
      }
    }
    const counters = new Float64Array(colors.length * 5);
    let invalid = 0;
    for (let i = 0; i < values.length; i++) {
      const slot = slotOf[i]!;
      if (slot < 0) continue;
      const s = classifyValue(colors[slot]!, values[i]!);
      counters[slot * 5]! += 1;
      counters[slot * 5 + COUNTER[s]!]! += 1;
      if (s === PixelState.INVALID) invalid++;
    }
    let transparent = 0;
    for (let i = 0; i < image.pixels.length; i++) if (image.pixels[i] === TRANSPARENT_U32) transparent++;
    sinceRebuild = 0;
    return { key: keyOf(template, snapshot), template, region, x0, yOf, values, slotOf, colors, counters, invalid, transparent };
  }

  function update(s: State, snapshot: CanvasSnapshot): void {
    const next = new Int32Array(s.values.length);
    readEligible(snapshot, s.region, s.x0, s.yOf, next);
    const prev = s.values;
    let changed = 0;
    for (let i = 0; i < next.length; i++) {
      const v = next[i]!;
      const old = prev[i]!;
      if (v === old) continue;
      const slot = s.slotOf[i]!;
      if (slot < 0) continue;
      changed++;
      const expected = s.colors[slot]!;
      const before = classifyValue(expected, old);
      const after = classifyValue(expected, v);
      if (before === after) continue;
      s.counters[slot * 5 + COUNTER[before]!]! -= 1;
      s.counters[slot * 5 + COUNTER[after]!]! += 1;
      if (before === PixelState.INVALID) s.invalid--;
      if (after === PixelState.INVALID) s.invalid++;
    }
    s.values = next;
    stats.lastChanged = changed;
  }

  const sameResult = (a: ProgressSnapshot, b: ProgressSnapshot): boolean =>
    a.total === b.total &&
    a.correct === b.correct &&
    a.wrongColor === b.wrongColor &&
    a.missing === b.missing &&
    a.unknown === b.unknown &&
    a.invalidObservations === b.invalidObservations &&
    a.completion === b.completion &&
    JSON.stringify(a.byColor) === JSON.stringify(b.byColor);

  return {
    get stats() {
      return { ...stats };
    },
    invalidate() {
      state = null;
    },
    compute(template, snapshot, now) {
      if (snapshot.readRow === undefined) {
        stats.full++;
        state = null;
        return computeProgress(template, snapshot, now, options);
      }
      const key = keyOf(template, snapshot);
      const reuse = state !== null && state.key === key && state.template.image === template.image && sinceRebuild < rebuildEvery;
      if (!reuse) {
        // Full computation: the authority; the state is rebuilt for the next calls.
        const full = computeProgress(template, snapshot, now, options);
        state = rebuild(template, snapshot);
        stats.full++;
        sinceVerify = 0;
        return full;
      }
      const s = state!;
      update(s, snapshot);
      sinceRebuild++;
      stats.incremental++;
      const result = assembleProgress(template, snapshot, now, options, s.colors, s.counters, s.invalid, s.transparent);
      if (verifyEvery > 0 && ++sinceVerify >= verifyEvery) {
        sinceVerify = 0;
        const full = computeProgress(template, snapshot, now, options);
        stats.verified++;
        if (!sameResult(result, full)) {
          stats.mismatches++;
          state = rebuild(template, snapshot);
          return full;
        }
      }
      return result;
    },
  };
}
