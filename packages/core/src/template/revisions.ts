/**
 * Revision rules (pure).
 *
 * A new, immutable revision is created when the content that determines
 * the painted result or its position changes:
 *   source image (hash), palette (any change), alpha threshold,
 *   quantization method, placement, coordinate system.
 * Placement and coordinate system count because TaskIds use image
 * coordinates: a revision must map to exactly one set of canvas pixels.
 *
 * Never a new revision: name, drawing strategy, priority, status (settings).
 * A change that differs in nothing is a no-op: no revision is created.
 *
 * Re-quantization is needed only when the source, the palette COLORS
 * (ordered RGB list: the order breaks ties), the alpha threshold or the
 * quantization method change. A placement-only revision, or a palette
 * change limited to names/costs, reuses the stored blobs.
 */

import type { Palette, RevisionChange, RevisionReason, RevisionRecordV1 } from '../contracts/index.js';

/** Deterministic JSON for deep equality (object keys sorted). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Same colors in the same order (names and costs ignored). */
export function samePaletteColors(a: Palette, b: Palette): boolean {
  return a.colors.length === b.colors.length && a.colors.every((c, i) => c.rgb === b.colors[i]?.rgb);
}

export interface RevisionDiff {
  readonly reasons: readonly RevisionReason[];
  readonly requantize: boolean;
}

/**
 * Compares a requested change with the current revision.
 * `newSourceHash` is the SHA-256 of change.sourcePng when one is given.
 */
export function diffRevision(current: RevisionRecordV1, change: RevisionChange, newSourceHash?: string): RevisionDiff {
  const reasons: RevisionReason[] = [];
  let requantize = false;

  if (change.sourcePng !== undefined && newSourceHash !== current.sourceImageHash) {
    reasons.push('source-image');
    requantize = true;
  }
  if (change.palette !== undefined && !deepEqual(change.palette, current.palette)) {
    reasons.push('palette');
    if (!samePaletteColors(change.palette, current.palette)) requantize = true;
  }
  if (change.alphaThreshold !== undefined && change.alphaThreshold !== current.alphaThreshold) {
    reasons.push('alpha-threshold');
    requantize = true;
  }
  if (change.quantization !== undefined && !deepEqual(change.quantization, current.quantizationMethod)) {
    reasons.push('quantization');
    requantize = true;
  }
  if (change.placement !== undefined && !deepEqual(change.placement, current.placement)) reasons.push('placement');
  if (change.coordinateSystem !== undefined && !deepEqual(change.coordinateSystem, current.coordinateSystem)) {
    reasons.push('coordinate-system');
  }
  return { reasons, requantize };
}
