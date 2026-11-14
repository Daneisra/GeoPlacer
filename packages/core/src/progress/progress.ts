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
  CanvasPixel,
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
import { TRANSPARENT, TRANSPARENT_U32, UNKNOWN } from '../contracts/index.js';
import { placementTransform } from '../geometry/projection.js';
import { assertRect } from '../geometry/validate.js';
import { assertImage, eligibleRegion } from '../strategy/common.js';

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
  const { image, placement, coordinateSystem } = template;
  const { width, pixels } = image;
  const region = eligibleRegion(image, placement, coordinateSystem);
  const t = placementTransform(placement, coordinateSystem);
  const { minX: rx0, minY: ry0 } = snapshot.rect;
  const rx1 = rx0 + snapshot.rect.width;
  const ry1 = ry0 + snapshot.rect.height;

  // Color slots: dense ids in order of first appearance, counters per slot.
  const slotOf = new Map<number, number>();
  const colors: number[] = [];
  let capacity = 16;
  let counters = new Float64Array(capacity * 5); // total, correct, wrongColor, missing, unknown
  let invalid = 0;
  let lastColor = TRANSPARENT_U32;
  let slot = -1;
  const point = { x: 0, y: 0 };

  for (let iy = region.iy; iy < region.iy + region.height; iy++) {
    const y = t.originY + t.yStep * iy;
    const rowObserved = y >= ry0 && y < ry1;
    point.y = y;
    const base = iy * width;
    for (let ix = region.ix; ix < region.ix + region.width; ix++) {
      const expected = pixels[base + ix]!;
      if (expected === TRANSPARENT_U32) continue;
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
      const x = t.originX + ix;
      if (!rowObserved || x < rx0 || x >= rx1) {
        counters[slot + 4]! += 1;
        continue;
      }
      point.x = x;
      const seen: CanvasPixel = snapshot.get(point);
      if (seen === expected) counters[slot + 1]! += 1;
      else if (seen === UNKNOWN) counters[slot + 4]! += 1;
      else if (seen === TRANSPARENT) counters[slot + 3]! += 1;
      else if (Number.isInteger(seen) && seen >= 0 && seen <= 0xffffff) counters[slot + 2]! += 1;
      else {
        counters[slot + 4]! += 1;
        invalid++;
      }
    }
  }

  // Excluded pixels, over the whole image.
  let transparent = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] === TRANSPARENT_U32) transparent++;

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
