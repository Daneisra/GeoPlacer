/** Local palette data, never an assertion about a GeoPixels account's unlocked colors. */
export const MAX_GHOST_COLORS = 256;

export const PERSONAL_GEOPIXELS_PALETTE = Object.freeze([
  '#ffffff', '#f4f59f', '#ffca3a', '#ff595e', '#e71d36', '#f3bbc2', '#ff85a1',
  '#bd637d', '#cdb4db', '#6a4c93', '#4d194d', '#a8d0dc', '#2ec4b6', '#1a535c',
  '#6d9dcd', '#1982c4', '#a1c181', '#8ac926', '#a0a0a0', '#6b4226', '#505050',
  '#cfd078', '#145a7a', '#8b1d24', '#c07f7a', '#c49a6c', '#5b7b1c', '#000000',
]);

/** Lospec / Manako, consulted 2026-11-16; community submission, not official. */
export const COMMUNITY_GEOPIXELS_PALETTE = Object.freeze([
  '#000000', '#4d194d', '#8b1d24', '#1a535c', '#6b4226', '#e71d36', '#145a7a',
  '#505050', '#6a4c93', '#5b7b1c', '#1982c4', '#bd637d', '#ff595e', '#c07f7a',
  '#6d9dcd', '#c49a6c', '#a0a0a0', '#ff85a1', '#2ec4b6', '#ff9f1c', '#8ac926',
  '#a1c181', '#cdb4db', '#f3bbc2', '#a8d0dc', '#cfd078', '#ffca3a', '#ffff00',
  '#f4f59f', '#ffffff',
]);

export type PaletteMode = 'personal28' | 'community30' | 'custom' | 'image' | 'account';
export interface PalettePreferences {
  mode: PaletteMode;
  customText: string;
}
export const PALETTE_STORAGE_KEY = 'geoplacer.geopixels.palette.v1';
const isMode = (mode: unknown): mode is PaletteMode => ['personal28', 'community30', 'custom', 'image', 'account'].includes(String(mode));

/** Six RGB digits only; alpha is an image property, not a palette color. Order is stable. */
export function parsePaletteText(text: string): { colors: string[]; invalid: string[]; duplicates: string[] } {
  const colors = new Set<string>();
  const invalid: string[] = [];
  const duplicates = new Set<string>();
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const match = /^#?([0-9a-f]{6})$/i.exec(token);
    if (match === null) invalid.push(token);
    else {
      const hex = `#${match[1]!.toLowerCase()}`;
      if (colors.has(hex)) duplicates.add(hex);
      colors.add(hex);
    }
  }
  return { colors: [...colors], invalid, duplicates: [...duplicates] };
}

/** Derive the actual quantization input from the selected mode; no second active palette cache. */
export function paletteTextFor(preferences: PalettePreferences, image: readonly string[] | null | undefined): string {
  switch (preferences.mode) {
    case 'personal28': return PERSONAL_GEOPIXELS_PALETTE.join('\n');
    case 'community30': return COMMUNITY_GEOPIXELS_PALETTE.join('\n');
    case 'custom': return preferences.customText;
    case 'image': return image?.join('\n') ?? '';
    case 'account': return preferences.customText.trim() || PERSONAL_GEOPIXELS_PALETTE.join('\n');
  }
}

export function loadPalettePreferences(storage: Pick<StorageLike, 'getItem'>): PalettePreferences {
  const defaults: PalettePreferences = { mode: 'personal28', customText: '' };
  try {
    const saved: unknown = JSON.parse(storage.getItem(PALETTE_STORAGE_KEY) ?? 'null');
    if (saved === null || typeof saved !== 'object') return defaults;
    const p = saved as Record<string, unknown>;
    return { mode: isMode(p.mode) ? p.mode : defaults.mode, customText: typeof p.customText === 'string' ? p.customText : '' };
  } catch { return defaults; }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function savePalettePreferences(storage: Pick<StorageLike, 'setItem'>, preferences: PalettePreferences): boolean {
  try {
    storage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch { return false; }
}
