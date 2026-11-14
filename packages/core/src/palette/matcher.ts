/**
 * Nearest-color matching against one list of colors (typically one agent's
 * palette: palettes are never assumed to be shared between agents).
 *
 * Tie rule (deterministic, documented): colors are scanned in list order and
 * a candidate replaces the best one only when its distance is strictly
 * smaller. On equal distances, the color that comes first wins.
 */

import type { ColorDistance, Palette, Rgb } from '../contracts/index.js';
import { ColorError } from '../color/errors.js';
import { isRgb } from '../color/rgb.js';

export interface PaletteMatcher {
  /** Deduplicated colors, in their original order (first occurrence kept). */
  readonly colors: readonly Rgb[];
  readonly distanceId: string;
  nearest(color: Rgb): Rgb;
  /** Index of the nearest color in `colors`. */
  nearestIndex(color: Rgb): number;
  /** True when the color belongs to the list (distance 0). */
  isExact(color: Rgb): boolean;
}

/** Bounded memo: cleared when full, so huge photo-like images cannot exhaust memory. */
export const DEFAULT_MATCH_CACHE_SIZE = 262_144;

/**
 * Index of the nearest color. Both paths scan in palette order and keep the
 * first strictly smaller value, so ties go to the first color.
 * - Euclidean-space distances (OKLab, RGB): palette projected once, the
 *   source projected once, squared distances compared (same ordering).
 * - Any other distance: distance(color, candidate) for each candidate.
 */
function createSearch(colors: readonly Rgb[], distance: ColorDistance): (color: Rgb) => number {
  const space = distance.euclideanSpace;
  if (space === undefined) {
    return (color) => {
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < colors.length; i++) {
        const d = distance.distance(color, colors[i] as Rgb);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return best;
    };
  }

  const dims = space.dimensions;
  const coords = new Float64Array(colors.length * dims);
  colors.forEach((c, i) => space.project(c, coords, i * dims));
  const probe = new Float64Array(dims);
  return (color) => {
    space.project(color, probe, 0);
    let best = 0;
    let bestSquared = Infinity;
    for (let i = 0, base = 0; i < colors.length; i++, base += dims) {
      let squared = 0;
      for (let d = 0; d < dims; d++) {
        const diff = (probe[d] ?? 0) - (coords[base + d] ?? 0);
        squared += diff * diff;
      }
      if (squared < bestSquared) {
        bestSquared = squared;
        best = i;
      }
    }
    return best;
  };
}

export function createPaletteMatcher(
  colors: readonly Rgb[],
  distance: ColorDistance,
  maxCachedColors = DEFAULT_MATCH_CACHE_SIZE
): PaletteMatcher {
  const unique: Rgb[] = [];
  const positions = new Map<Rgb, number>();
  for (const color of colors) {
    if (!isRgb(color)) throw new ColorError('INVALID_RGB', `palette contains an invalid color: ${String(color)}`);
    if (!positions.has(color)) {
      positions.set(color, unique.length);
      unique.push(color);
    }
  }
  if (unique.length === 0) throw new ColorError('EMPTY_PALETTE', 'cannot match colors against an empty palette');

  const search = createSearch(unique, distance);
  const memo = new Map<number, number>();

  const nearestIndex = (color: Rgb): number => {
    // Rejects TRANSPARENT_U32, TRANSPARENT and anything outside 24 bits:
    // transparency must never be matched to a color.
    if (!isRgb(color)) throw new ColorError('INVALID_RGB', `cannot match a non-color value: ${String(color)}`);
    const exact = positions.get(color);
    if (exact !== undefined) return exact;
    const cached = memo.get(color);
    if (cached !== undefined) return cached;

    const best = search(color);
    if (maxCachedColors > 0) {
      if (memo.size >= maxCachedColors) memo.clear();
      memo.set(color, best);
    }
    return best;
  };

  return {
    colors: unique,
    distanceId: distance.id,
    nearestIndex,
    nearest: (color) => unique[nearestIndex(color)] as Rgb,
    isExact: (color) => positions.has(color),
  };
}

/**
 * The colors one agent can paint, in a deterministic order: catalog colors
 * the agent has unlocked (catalog order), then unlocked colors absent from
 * the catalog (ascending numeric order). The order matters for tie-breaking.
 */
export function agentColors(catalog: Palette, unlocked: ReadonlySet<Rgb>): readonly Rgb[] {
  const inCatalog = new Set<Rgb>();
  const result: Rgb[] = [];
  for (const entry of catalog.colors) {
    if (unlocked.has(entry.rgb) && !inCatalog.has(entry.rgb)) {
      inCatalog.add(entry.rgb);
      result.push(entry.rgb);
    }
  }
  const extra = [...unlocked].filter((c) => !inCatalog.has(c)).sort((a, b) => a - b);
  return [...result, ...extra];
}
