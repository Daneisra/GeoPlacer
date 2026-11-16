/**
 * ProgressCalculator: compares a template revision with a canvas snapshot.
 *
 * For every eligible pixel (non-transparent, inside the canvas bounds):
 *   correct     the snapshot has the expected color
 *   wrongColor  the snapshot has another 24-bit color        } incorrect
 *   missing     the snapshot pixel is empty (TRANSPARENT)    }
 *   unknown     outside the snapshot, UNKNOWN, or an invalid value
 * total = correct + incorrect + unknown, globally and for every color.
 *
 * Pure and independent of the drawing strategy, the pixel order, the seed
 * and the agents: one scan of the eligible region in image order. No object
 * per pixel: counters in typed arrays, one reused point for snapshot.get.
 */

import type {
  CanvasSnapshot,
  ColorProgress,
  CompletionState,
  FreshnessPolicy,
  ProgressBasis,
  ProgressCalculator,
  ProgressOptions,
  ProgressSnapshot,
  ProgressTemplate,
  Rgb,
  SnapshotFreshness,
  Timestamp,
} from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { assertRect } from '../geometry/validate.js';
import { assertImage } from '../strategy/common.js';
import { PixelState, scanEligibleRowsSliced } from './classify.js';
import { runSliced, unsliced, type SliceBudget, type Sliced } from './slices.js';

export type ProgressErrorCode =
  /** now / observedAt not a non-negative safe integer, malformed rect, image or policy. */
  | 'INVALID_INPUT'
  /** The snapshot is not in the template's coordinate system (convert explicitly). */
  | 'COORDINATE_SYSTEM_MISMATCH';

export class ProgressError extends Error {
  readonly code: ProgressErrorCode;

  constructor(code: ProgressErrorCode, message: string) {
    super(message);
    this.name = 'ProgressError';
    this.code = code;
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProgressError('INVALID_INPUT', `${name} must be a non-negative integer timestamp`);
}

function assertPolicies(options: ProgressOptions): void {
  for (const [source, policy] of Object.entries(options.freshness ?? {})) {
    const max = (policy as FreshnessPolicy | undefined)?.maxAgeMs;
    if (max === undefined || !Number.isSafeInteger(max) || max < 0) {
      throw new ProgressError('INVALID_INPUT', `freshness policy of ${source}: maxAgeMs must be a non-negative integer`);
    }
  }
}

/** Age of a snapshot against the policy of its source (no policy: not evaluated). */
export function snapshotFreshness(snapshot: Pick<CanvasSnapshot, 'source' | 'observedAt'>, now: Timestamp, options: ProgressOptions = {}): SnapshotFreshness {
  const ageMs = now - snapshot.observedAt;
  const maxAgeMs = options.freshness?.[snapshot.source]?.maxAgeMs ?? null;
  if (ageMs < 0) return { status: 'future', ageMs, maxAgeMs };
  if (maxAgeMs === null) return { status: 'not-evaluated', ageMs, maxAgeMs };
  return { status: ageMs > maxAgeMs ? 'stale' : 'fresh', ageMs, maxAgeMs };
}

function sameSystem(a: ProgressTemplate['coordinateSystem'], b: CanvasSnapshot['coordinateSystem']): boolean {
  if (a.yAxis !== b.yAxis) return false;
  if (a.bounds === undefined || b.bounds === undefined) return a.bounds === b.bounds;
  return a.bounds.minX === b.bounds.minX && a.bounds.minY === b.bounds.minY && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

const percent = (part: number, total: number): number | null => (total === 0 ? null : (part * 100) / total);

export function computeProgress(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp, options: ProgressOptions = {}): ProgressSnapshot {
  return runSliced(computeProgressSliced(template, snapshot, now, options, unsliced()));
}

/** computeProgress cut into slices of `budget` pixels (Phase 1C.0): same result. */
export function* computeProgressSliced(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp, options: ProgressOptions, budget: SliceBudget): Sliced<ProgressSnapshot> {
  assertTimestamp(now, 'now');
  assertTimestamp(snapshot.observedAt, 'snapshot.observedAt');
  assertPolicies(options);
  try {
    assertImage(template.image);
    assertRect(snapshot.rect, 'snapshot.rect');
  } catch (error) {
    throw new ProgressError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
  if (!sameSystem(template.coordinateSystem, snapshot.coordinateSystem)) {
    throw new ProgressError('COORDINATE_SYSTEM_MISMATCH', 'the snapshot is not in the template coordinate system: convert it explicitly first');
  }
  const { pixels } = template.image;
  // Color slots: dense ids in order of first appearance, counters per slot.
  const slotOf = new Map<number, number>();
  const colors: number[] = [];
  let capacity = 16;
  let counters = new Float64Array(capacity * 5); // total, correct, wrongColor, missing, unknown
  let invalid = 0;
  let lastColor = TRANSPARENT_U32;
  let slot = -1;
  // The shared classification (also used by the work planner).
  yield* scanEligibleRowsSliced(template, snapshot, (row) => {
    const base = row.iy * template.image.width + row.ix0;
    for (let k = 0; k < row.count; k++) {
      const state = row.states[k]!;
      if (state === PixelState.TRANSPARENT) continue;
      const expected = pixels[base + k]!;
      if (expected !== lastColor) {
        lastColor = expected;
        let found = slotOf.get(expected);
        if (found === undefined) {
          found = colors.length;
          slotOf.set(expected, found);
          colors.push(expected);
          if (found >= capacity) {
            const grown = new Float64Array(capacity * 2 * 5);
            grown.set(counters);
            counters = grown;
            capacity *= 2;
          }
        }
        slot = found * 5;
      }
      counters[slot]! += 1;
      if (state === PixelState.CORRECT) counters[slot + 1]! += 1;
      else if (state === PixelState.WRONG_COLOR) counters[slot + 2]! += 1;
      else if (state === PixelState.MISSING) counters[slot + 3]! += 1;
      else {
        counters[slot + 4]! += 1;
        if (state === PixelState.INVALID) invalid++;
      }
    }
  }, false, budget);

  // Excluded pixels, over the whole image (by rows, a slice boundary between rows).
  let transparent = 0;
  const imageWidth = template.image.width;
  for (let row = 0; row < pixels.length; row += imageWidth) {
    const end = Math.min(pixels.length, row + imageWidth);
    for (let i = row; i < end; i++) if (pixels[i] === TRANSPARENT_U32) transparent++;
    if (budget.add(end - row)) yield;
  }
  return assembleProgress(template, snapshot, now, options, colors, counters, invalid, transparent);
}

/**
 * The progress snapshot from the counters per color slot (total, correct,
 * wrongColor, missing, unknown; 5 per slot), shared by the full and the
 * incremental computations (Phase 1B.10).
 */
export function assembleProgress(
  template: ProgressTemplate,
  snapshot: CanvasSnapshot,
  now: Timestamp,
  options: ProgressOptions,
  colors: readonly number[],
  counters: Float64Array,
  invalid: number,
  transparent: number
): ProgressSnapshot {
  const { pixels } = template.image;
  const byColor: ColorProgress[] = colors
    .map((color, k) => {
      const total = counters[k * 5]!;
      const correct = counters[k * 5 + 1]!;
      const wrongColor = counters[k * 5 + 2]!;
      const missing = counters[k * 5 + 3]!;
      const unknown = counters[k * 5 + 4]!;
      return { color: color as Rgb, total, correct, incorrect: wrongColor + missing, wrongColor, missing, unknown };
    })
    .sort((a, b) => a.color - b.color);
  const sum = (key: keyof Omit<ColorProgress, 'color'>): number => byColor.reduce((n, c) => n + c[key], 0);
  const total = sum('total');
  const correct = sum('correct');
  const wrongColor = sum('wrongColor');
  const missing = sum('missing');
  const unknown = sum('unknown');
  const incorrect = wrongColor + missing;
  const completion: CompletionState = total === 0 ? 'no-eligible-pixels' : incorrect > 0 ? 'incomplete' : unknown > 0 ? 'undetermined' : 'complete';
  const basis: ProgressBasis = {
    source: snapshot.source,
    kind: snapshot.source === 'simulated' ? 'simulation' : 'imported-observation',
    observedAt: snapshot.observedAt,
    freshness: snapshotFreshness(snapshot, now, options),
  };
  return {
    templateId: template.id,
    revision: template.revision,
    basis,
    total,
    correct,
    incorrect,
    wrongColor,
    missing,
    unknown,
    invalidObservations: invalid,
    excluded: { transparent, outsideCanvas: pixels.length - transparent - total },
    conformityPercent: percent(correct, total),
    coveragePercent: percent(correct + incorrect, total),
    completion,
    byColor,
    computedAt: now,
  };
}

export function createProgressCalculator(options: ProgressOptions = {}): ProgressCalculator {
  assertPolicies(options);
  return { compute: (template, snapshot, now) => computeProgress(template, snapshot, now, options) };
}
