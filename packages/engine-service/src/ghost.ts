/**
 * GeoPixels ghost image export (Phase 1C.1): prepare a template in GeoPlacer, export a standard
 * PNG, import it BY HAND in the native ghost image tool of GeoPixels (« Upload Image », « Place on
 * Map »). Nothing here talks to GeoPixels: no request, no account, no cookie, no token.
 *
 * What is reused, not rewritten:
 * - the TemplateManager (its own project `geopixels`, invisible to the simulation): PNG checks and
 *   limits, palette, alpha threshold, nearest color in OKLab, revisions, durable storage;
 * - readPngHeader and assertWithinLimits BEFORE any decoding (an image announcing huge sizes is
 *   refused before it is decompressed);
 * - quantizedToRgba for the export (alpha 0 or 255 only, transparent pixels black and invisible).
 * The only new image algorithm is the optional resizing (core resizeRgba), applied BEFORE the
 * import, so that the colors are reduced by the usual single path.
 *
 * The palette is the player's: a list of hex colors entered by the user (GeoPixels publishes no
 * fixed palette; each player unlocks colors). The coordinates are the top-left corner as the user
 * types it, kept as is: GeoPixels does not document its axes, so nothing is converted.
 */

import type { PngCodec, Rgb, Template, TemplateManager } from '@geoplacer/core';
import { TRANSPARENT_U32, TemplateError, asProjectId, assertWithinLimits, proportionalSize, quantizedToRgba, readPngHeader, resizeRgba } from '@geoplacer/core';

/** Ghost templates live in their own TemplateManager project. */
export const GHOST_PROJECT = 'geopixels';
export const MAX_GHOST_COLORS = 256;

export interface GhostImportInput {
  readonly name: string;
  readonly png: Uint8Array;
  /** The player's colors, '#RRGGBB' or 'RRGGBB' (case ignored, duplicates removed). */
  readonly palette: readonly string[];
  /** Target size; one side only keeps the proportions; none keeps the image size. */
  readonly width?: number;
  readonly height?: number;
  /** Alpha below it is transparent (default 128). */
  readonly alphaThreshold?: number;
  /** Top-left corner as typed by the user (GeoPixels coordinates, not converted; default 0, 0). */
  readonly x?: number;
  readonly y?: number;
}

export interface GhostInfo {
  readonly templateId: string;
  readonly name: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly paintablePixels: number;
  readonly transparentPixels: number;
  /** Colors used, most used first. */
  readonly colors: readonly { readonly hex: string; readonly pixels: number }[];
  /** The palette given at the import. */
  readonly palette: readonly string[];
  /** Top-left corner as typed (not converted). */
  readonly topLeft: { readonly x: number; readonly y: number };
  readonly alphaThreshold: number;
  readonly filename: string;
  readonly updatedAt: number;
}

export const hexOf = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;

/** The player's palette, validated: 1 to 256 distinct colors. */
export function parsePalette(hexes: readonly string[]): Rgb[] {
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const raw of hexes) {
    const m = /^#?([0-9a-f]{6})$/i.exec(raw.trim());
    if (m === null) throw new TemplateError('INVALID_INPUT', `invalid color ${JSON.stringify(raw)}: expected #RRGGBB`);
    const rgb = Number.parseInt(m[1]!, 16);
    if (!seen.has(rgb)) {
      seen.add(rgb);
      out.push(rgb as Rgb);
    }
  }
  if (out.length === 0) throw new TemplateError('INVALID_INPUT', 'the palette is empty: give at least one color');
  if (out.length > MAX_GHOST_COLORS) throw new TemplateError('INVALID_INPUT', `at most ${MAX_GHOST_COLORS} colors`);
  return out;
}

/** An ASCII file name, safe in a Content-Disposition header (never a quote, a slash or a line break). */
export function ghostFilename(name: string, width: number, height: number, x: number, y: number): string {
  const slug =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'modele';
  return `geopixels-${slug}-${width}x${height}-x${x}-y${y}.png`;
}

/** Creates the ghost template (resized first when asked). */
export async function importGhost(templates: TemplateManager, codec: PngCodec, input: GhostImportInput): Promise<Template> {
  const colors = parsePalette(input.palette);
  let png = input.png;
  if (input.width !== undefined || input.height !== undefined) {
    const header = readPngHeader(png);
    assertWithinLimits(header.width, header.height);
    const size = proportionalSize(header.width, header.height, { ...(input.width === undefined ? {} : { width: input.width }), ...(input.height === undefined ? {} : { height: input.height }) });
    if (size.width !== header.width || size.height !== header.height) {
      const decoded = await codec.decode(png);
      png = await codec.encode(resizeRgba(decoded, size.width, size.height));
    }
  }
  return templates.create({
    projectId: asProjectId(GHOST_PROJECT),
    name: input.name,
    sourcePng: png,
    palette: { id: 'geopixels-joueur', colors: colors.map((rgb) => ({ rgb })) },
    placement: { topLeft: { x: input.x ?? 0, y: input.y ?? 0 } },
    // The image's own orientation (row 0 at the top): what an image upload shows. No conversion.
    coordinateSystem: { yAxis: 'down' },
    ...(input.alphaThreshold === undefined ? {} : { alphaThreshold: input.alphaThreshold }),
  });
}

export function ghostInfo(t: Template): GhostInfo {
  const counts = new Map<number, number>();
  let transparent = 0;
  for (const p of t.image.pixels) {
    if (p === TRANSPARENT_U32) transparent++;
    else counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([rgb, pixels]) => ({ hex: hexOf(rgb), pixels }));
  const { x, y } = t.placement.topLeft;
  return {
    templateId: t.id,
    name: t.name,
    revision: t.revision,
    width: t.image.width,
    height: t.image.height,
    paintablePixels: t.image.pixels.length - transparent,
    transparentPixels: transparent,
    colors,
    palette: t.palette.colors.map((c) => hexOf(c.rgb)),
    topLeft: { x, y },
    alphaThreshold: t.alphaThreshold,
    filename: ghostFilename(t.name, t.image.width, t.image.height, x, y),
    updatedAt: t.updatedAt,
  };
}

/** The export: the quantized template as an 8-bit RGBA PNG (alpha 0 or 255 only). */
export function exportGhostPng(codec: PngCodec, t: Template): Promise<Uint8Array> {
  return codec.encode({ width: t.image.width, height: t.image.height, rgba: quantizedToRgba(t.image) });
}
