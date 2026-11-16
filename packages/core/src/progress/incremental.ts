/**
 * Incremental progress (Phase 1B.10 prototype, measured; sliced and atomic in Phase 1C.0).
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
 *   (restore, new world), and every `rebuildEvery` calls; the result of such
 *   a call is the full computation itself (the authority);
 * - every `verifyEvery` calls, the result is compared with the full
 *   computeProgress: on any difference the full result is used, the state
 *   is rebuilt and the mismatch is counted (never a stale counter);
 * - snapshots without readRow (point reads, possibly non-integer values)
 *   always use the full computation.
 *
 * Phase 1C.0:
 * - computeSliced cuts every pass (reading, comparison, rebuild,
 *   verification) into slices of the caller's budget; compute runs the same
 *   code without stopping. All slices of one call work on the same snapshot
 *   (the caller's copy) and the same template revision.
 * - ATOMIC: the state (values, counters, cycle counts) is replaced only when
 *   a call finishes. A call abandoned between two slices (pause, stop, an
 *   error) leaves the previous state untouched: never half-applied counters.
 * - The template-only part of the state (which color each eligible pixel
 *   expects, as a dense slot) is kept while the key and the image are the
 *   same: a periodic rebuild only re-reads and recounts the values.
 * - Two value buffers are swapped instead of allocating one per call.
 */

import type { CanvasSnapshot, ProgressOptions, ProgressSnapshot, ProgressTemplate, Timestamp } from '../contracts/index.js';
import { TRANSPARENT_U32, UNKNOWN } from '../contracts/index.js';
import { placementTransform } from '../geometry/projection.js';
import { eligibleRegion } from '../strategy/common.js';
import { PixelState, classifyValue } from './classify.js';
import { assembleProgress, computeProgressSliced } from './progress.js';
import { runSliced, unsliced, type SliceBudget, type Sliced } from './slices.js';

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
  /** Phase 1C.0: the same computation, yielding between slices of `budget` pixels. */
  computeSliced(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp, budget: SliceBudget): Sliced<ProgressSnapshot>;
  /** Forget everything (restore, new world): the next call is a full rebuild. */
  invalidate(): void;
  readonly stats: IncrementalProgressStats;
}

/** Counter index of a state: total is 0; correct 1, wrongColor 2, missing 3, unknown (and invalid) 4. */
const COUNTER = [0, 1, 2, 3, 4, 4];

/** What depends on the template and the snapshot rectangle only (kept between rebuilds). */
interface Layout {
  readonly key: string;
  readonly image: ProgressTemplate['image'];
  readonly region: { readonly ix: number; readonly iy: number; readonly width: number; readonly height: number };
  readonly x0: number;
  readonly yOf: (iy: number) => number;
  /** Dense color slot of every eligible pixel (-1: transparent). */
  readonly slotOf: Int32Array;
  readonly colors: readonly number[];
  readonly transparent: number;
}

/** What depends on the observed values (replaced as a whole at the end of a call). */
interface Observed {
  readonly values: Int32Array;
  readonly counters: Float64Array;
  readonly invalid: number;
}

function keyOf(template: ProgressTemplate, snapshot: CanvasSnapshot): string {
  const p = template.placement;
  const r = snapshot.rect;
  return `${template.id}|${template.revision}|${template.image.width}x${template.image.height}|${p.topLeft.x},${p.topLeft.y}|${template.coordinateSystem.yAxis}|${snapshot.coordinateSystem.yAxis}|${r.minX},${r.minY},${r.width},${r.height}`;
}

/** Reads the eligible region's observed values (UNKNOWN outside the snapshot rectangle), row-major. */
function* readEligible(snapshot: CanvasSnapshot, layout: Layout, out: Int32Array, budget: SliceBudget): Sliced<void> {
  const { region, x0, yOf } = layout;
  const readRow = snapshot.readRow!.bind(snapshot);
  const { minX: rx0, minY: ry0 } = snapshot.rect;
  const rx1 = rx0 + snapshot.rect.width;
  const ry1 = ry0 + snapshot.rect.height;
  const kFrom = Math.max(0, Math.min(region.width, rx0 - x0));
  const kTo = Math.max(kFrom, Math.min(region.width, rx1 - x0));
  for (let r = 0; r < region.height; r++) {
    const row = r * region.width;
    out.fill(UNKNOWN, row, row + region.width);
    const y = yOf(region.iy + r);
    if (y >= ry0 && y < ry1 && kTo > kFrom) readRow(y, x0 + kFrom, x0 + kTo, out.subarray(row + kFrom, row + kTo));
    if (budget.add(region.width)) yield;
  }
}

/** The template-only layout, by rows (slices between rows). */
function* buildLayout(key: string, template: ProgressTemplate, budget: SliceBudget): Sliced<Layout> {
  const { image, placement, coordinateSystem } = template;
  const region = eligibleRegion(image, placement, coordinateSystem);
  const t = placementTransform(placement, coordinateSystem);
  const yOf = (iy: number): number => t.originY + t.yStep * iy;
  const slotOf = new Int32Array(region.width * region.height).fill(-1);
  const colors: number[] = [];
  const slots = new Map<number, number>();
  let lastColor = TRANSPARENT_U32;
  let lastSlot = -1;
  for (let r = 0; r < region.height; r++) {
    const base = (region.iy + r) * image.width + region.ix;
    for (let k = 0; k < region.width; k++) {
      const expected = image.pixels[base + k]!;
      if (expected === TRANSPARENT_U32) continue;
      if (expected !== lastColor) {
        // Runs of one color are common: the map is only asked when the color changes.
        let slot = slots.get(expected);
        if (slot === undefined) {
          slot = colors.length;
          slots.set(expected, slot);
          colors.push(expected);
        }
        lastColor = expected;
        lastSlot = slot;
      }
      slotOf[r * region.width + k] = lastSlot;
    }
    if (budget.add(region.width)) yield;
  }
  let transparent = 0;
  for (let row = 0; row < image.pixels.length; row += image.width) {
    const end = Math.min(image.pixels.length, row + image.width);
    for (let i = row; i < end; i++) if (image.pixels[i] === TRANSPARENT_U32) transparent++;
    if (budget.add(end - row)) yield;
  }
  return { key, image, region, x0: t.originX + region.ix, yOf, slotOf, colors, transparent };
}

/** Classifies `values` from scratch against the layout (by rows). */
function* countAll(layout: Layout, values: Int32Array, budget: SliceBudget): Sliced<{ counters: Float64Array; invalid: number }> {
  const { slotOf, colors, region } = layout;
  const counters = new Float64Array(colors.length * 5);
  let invalid = 0;
  for (let row = 0; row < values.length; row += region.width) {
    const end = row + region.width;
    for (let i = row; i < end; i++) {
      const slot = slotOf[i]!;
      if (slot < 0) continue;
      const s = classifyValue(colors[slot]!, values[i]!);
      counters[slot * 5]! += 1;
      counters[slot * 5 + COUNTER[s]!]! += 1;
      if (s === PixelState.INVALID) invalid++;
    }
    if (budget.add(region.width)) yield;
  }
  return { counters, invalid };
}

export function createIncrementalProgress(config: IncrementalProgressOptions = {}): IncrementalProgress {
  const options = config.options ?? {};
  const verifyEvery = config.verifyEvery ?? 10;
  const rebuildEvery = config.rebuildEvery ?? 100;
  let layout: Layout | null = null;
  let observed: Observed | null = null;
  /** The other value buffer (same size as observed.values), or null. */
  let spare: Int32Array | null = null;
  let sinceRebuild = 0;
  let sinceVerify = 0;
  /** Bumped by invalidate(): a call that began before must not commit its (older) state. */
  let epoch = 0;
  const stats = { full: 0, incremental: 0, verified: 0, mismatches: 0, lastChanged: 0 };

  const sameResult = (a: ProgressSnapshot, b: ProgressSnapshot): boolean =>
    a.total === b.total &&
    a.correct === b.correct &&
    a.wrongColor === b.wrongColor &&
    a.missing === b.missing &&
    a.unknown === b.unknown &&
    a.invalidObservations === b.invalidObservations &&
    a.completion === b.completion &&
    JSON.stringify(a.byColor) === JSON.stringify(b.byColor);

  /** A buffer for the values, never the one in use. */
  const freeBuffer = (size: number): Int32Array => (spare !== null && spare.length === size && spare !== observed?.values ? spare : new Int32Array(size));

  /** The observed state rebuilt from the snapshot (not yet committed). */
  function* rebuildObserved(l: Layout, snapshot: CanvasSnapshot, budget: SliceBudget): Sliced<Observed> {
    const values = freeBuffer(l.slotOf.length);
    yield* readEligible(snapshot, l, values, budget);
    const { counters, invalid } = yield* countAll(l, values, budget);
    return { values, counters, invalid };
  }

  /** Replaces the state as a whole (the only place it changes); false when invalidated meanwhile. */
  function commit(startEpoch: number, l: Layout, o: Observed, rebuilt: boolean): boolean {
    if (startEpoch !== epoch) return false;
    if (observed !== null && observed.values !== o.values && observed.values.length === o.values.length) spare = observed.values;
    else if (rebuilt && (observed === null || observed.values.length !== o.values.length)) spare = null;
    layout = l;
    observed = o;
    if (rebuilt) sinceRebuild = 0;
    return true;
  }

  function* computeSliced(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp, budget: SliceBudget): Sliced<ProgressSnapshot> {
    const startEpoch = epoch;
    if (snapshot.readRow === undefined) {
      const full = yield* computeProgressSliced(template, snapshot, now, options, budget);
      layout = null;
      observed = null;
      spare = null;
      stats.full++;
      return full;
    }
    const key = keyOf(template, snapshot);
    const sameLayout = layout !== null && layout.key === key && layout.image === template.image;
    const reuse = sameLayout && observed !== null && sinceRebuild < rebuildEvery;
    if (!reuse) {
      // Full computation: the authority; the state is rebuilt for the next calls.
      const full = yield* computeProgressSliced(template, snapshot, now, options, budget);
      const l = sameLayout ? layout! : yield* buildLayout(key, template, budget);
      const o = yield* rebuildObserved(l, snapshot, budget);
      if (commit(startEpoch, l, o, true)) sinceVerify = 0;
      stats.full++;
      return full;
    }
    const l = layout!;
    const prev = observed!;
    // Incremental: read into the other buffer, count the differences into a copy of the counters.
    const next = freeBuffer(prev.values.length);
    yield* readEligible(snapshot, l, next, budget);
    const counters = prev.counters.slice();
    let invalid = prev.invalid;
    let changed = 0;
    const { slotOf, colors, region } = l;
    for (let row = 0; row < next.length; row += region.width) {
      const end = row + region.width;
      for (let i = row; i < end; i++) {
        const v = next[i]!;
        const old = prev.values[i]!;
        if (v === old) continue;
        const slot = slotOf[i]!;
        if (slot < 0) continue;
        changed++;
        const expected = colors[slot]!;
        const before = classifyValue(expected, old);
        const after = classifyValue(expected, v);
        if (before === after) continue;
        counters[slot * 5 + COUNTER[before]!]! -= 1;
        counters[slot * 5 + COUNTER[after]!]! += 1;
        if (before === PixelState.INVALID) invalid--;
        if (after === PixelState.INVALID) invalid++;
      }
      if (budget.add(region.width)) yield;
    }
    const o: Observed = { values: next, counters, invalid };
    const result = assembleProgress(template, snapshot, now, options, l.colors, counters, invalid, l.transparent);
    if (verifyEvery > 0 && sinceVerify + 1 >= verifyEvery) {
      const full = yield* computeProgressSliced(template, snapshot, now, options, budget);
      stats.verified++;
      if (!sameResult(result, full)) {
        stats.mismatches++;
        const rebuilt = yield* rebuildObserved(l, snapshot, budget);
        if (commit(startEpoch, l, rebuilt, true)) sinceVerify = 0;
        return full;
      }
    }
    if (commit(startEpoch, l, o, false)) {
      sinceVerify = verifyEvery > 0 && sinceVerify + 1 >= verifyEvery ? 0 : sinceVerify + 1;
      sinceRebuild++;
    }
    stats.incremental++;
    stats.lastChanged = changed;
    return result;
  }

  return {
    get stats() {
      return { ...stats };
    },
    invalidate() {
      epoch++;
      layout = null;
      observed = null;
      spare = null;
    },
    compute(template, snapshot, now) {
      return runSliced(computeSliced(template, snapshot, now, unsliced()));
    },
    computeSliced,
  };
}
