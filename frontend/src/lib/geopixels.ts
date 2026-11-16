/**
 * Preparation of a ghost image for GeoPixels (Phase 1C.1). Local only: GeoPlacer produces a PNG
 * that the user imports BY HAND in the native ghost image tool of GeoPixels. Nothing here talks to
 * GeoPixels (no request, no account).
 */

export interface GhostInfo {
  templateId: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  totalPixels: number;
  retainedPixels: number;
  paintablePixels: number;
  transparentPixels: number;
  colors: { hex: string; pixels: number }[];
  palette: string[];
  /** Top-left corner as typed by the user (GeoPixels coordinates, not converted). */
  topLeft: { x: number; y: number };
  alphaThreshold: number;
  filename: string;
  updatedAt: number;
}

export { MAX_GHOST_COLORS, parsePaletteText } from './ghost-palettes';
import { MAX_GHOST_COLORS } from './ghost-palettes';

/** The distinct opaque colors of an image file (alpha >= threshold), or null beyond `max` colors. */
export async function imageColors(file: File, alphaThreshold = 128, max = MAX_GHOST_COLORS): Promise<string[] | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < alphaThreshold) continue;
      seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
      if (seen.size > max) return null;
    }
    return [...seen].map((c) => `#${c.toString(16).padStart(6, '0')}`);
  } finally {
    bitmap.close();
  }
}

export const exportUrl = (g: Pick<GhostInfo, 'templateId' | 'revision'>): string => `/api/v1/geopixels/templates/${g.templateId}/export.png?r=${g.revision}`;
