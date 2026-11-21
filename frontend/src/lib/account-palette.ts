export type AccountPalette = {
  state: 'fresh' | 'stale' | 'unknown';
  source: 'native-worker-response' | 'native-user-response' | null;
  capturedAt: number | null;
  colors: number[];
};

export const colorHex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`;

// Initial public, anonymous palette (opaque entries only). Availability always requires account evidence.
// https://github.com/AntCDev/GeoPixelsFront/blob/74783afc5b7e3064a43eed20b0f6638007853324/wwwroot/js/index.js#L155-L159
export const PUBLIC_BASE_COLORS = new Set([
  '#ffffff', '#ffca3a', '#ff595e', '#f3bbc2', '#bd637d', '#6a4c93', '#a8d0dc', '#1a535c',
  '#1982c4', '#8ac926', '#6b4226', '#cfd078', '#8b1d24', '#c49a6c', '#000000',
]);

export function accountColors(sample?: AccountPalette | null): string[] {
  return sample?.colors.map(colorHex) ?? [];
}
