/** Execute the pure frontend palette module, without a DOM or another test runner. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

interface Preferences { mode: 'personal28' | 'community30' | 'custom' | 'image'; customText: string }
interface Parsed { colors: string[]; invalid: string[]; duplicates: string[] }
interface Api {
  PERSONAL_GEOPIXELS_PALETTE: string[];
  COMMUNITY_GEOPIXELS_PALETTE: string[];
  MAX_GHOST_COLORS: number;
  PALETTE_STORAGE_KEY: string;
  parsePaletteText(text: string): Parsed;
  paletteTextFor(p: Preferences, image: string[] | null | undefined): string;
  loadPalettePreferences(storage: { getItem(key: string): string | null }): Preferences;
  savePalettePreferences(storage: { setItem(key: string, value: string): void }, p: Preferences): boolean;
}
const source = readFileSync(path.resolve(__dirname, '../../frontend/src/lib/ghost-palettes.ts'), 'utf8');
const sandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const api = sandbox.exports as Api;

describe('GeoPixels local palette choices', () => {
  it('preserves the 28 user colors exactly and in order, with six-digit white', () => {
    expect(api.PERSONAL_GEOPIXELS_PALETTE).toEqual([
      '#ffffff', '#f4f59f', '#ffca3a', '#ff595e', '#e71d36', '#f3bbc2', '#ff85a1',
      '#bd637d', '#cdb4db', '#6a4c93', '#4d194d', '#a8d0dc', '#2ec4b6', '#1a535c',
      '#6d9dcd', '#1982c4', '#a1c181', '#8ac926', '#a0a0a0', '#6b4226', '#505050',
      '#cfd078', '#145a7a', '#8b1d24', '#c07f7a', '#c49a6c', '#5b7b1c', '#000000',
    ]);
    expect(Object.isFrozen(api.PERSONAL_GEOPIXELS_PALETTE)).toBe(true);
  });
  it('keeps the Lospec 30-color list separate, adding only orange and yellow', () => {
    const community = api.COMMUNITY_GEOPIXELS_PALETTE;
    expect(community).toHaveLength(30);
    expect(new Set(community).size).toBe(30);
    expect(community.filter((c) => !api.PERSONAL_GEOPIXELS_PALETTE.includes(c))).toEqual(['#ff9f1c', '#ffff00']);
    expect(api.PERSONAL_GEOPIXELS_PALETTE.every((c) => community.includes(c))).toBe(true);
  });
  it('normalizes case and accepts spaces, commas, semicolons and line breaks', () => {
    expect(api.parsePaletteText('  #FFFFFF,000000\r\n#FfCa3A; #1a535c\t')).toEqual({ colors: ['#ffffff', '#000000', '#ffca3a', '#1a535c'], invalid: [], duplicates: [] });
  });
  it('reports duplicates while retaining the first occurrence and treating black as opaque', () => {
    expect(api.parsePaletteText('#000000 #FFFFFF #000000 ffffff #ffffff')).toEqual({ colors: ['#000000', '#ffffff'], invalid: [], duplicates: ['#000000', '#ffffff'] });
  });
  it.each(['#fffff', '#fff', '#gg0000', '#00000000', 'transparent', '#ffffff!', 'rgb(0,0,0)'])(
    'rejects invalid or alpha-bearing input %s', (text) => {
      const result = api.parsePaletteText(text);
      expect(result.invalid.length).toBeGreaterThan(0);
      expect(result.colors).toEqual([]);
    }
  );
  it('distinguishes empty, exactly 256 and too many colors', () => {
    expect(api.parsePaletteText(' ,\n\t').colors).toEqual([]);
    const colors = Array.from({ length: 257 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`);
    expect(api.parsePaletteText(colors.slice(0, 256).join('\n')).colors).toHaveLength(api.MAX_GHOST_COLORS);
    expect(api.parsePaletteText(colors.join('\n')).colors.length).toBeGreaterThan(api.MAX_GHOST_COLORS);
  });
  it('derives the quantization palette from each mode without losing the saved custom text', () => {
    const p: Preferences = { mode: 'custom', customText: '#123456\n#000000' };
    expect(api.paletteTextFor(p, undefined)).toBe(p.customText);
    expect(api.parsePaletteText(api.paletteTextFor({ ...p, mode: 'personal28' }, null)).colors).toEqual(api.PERSONAL_GEOPIXELS_PALETTE);
    expect(api.parsePaletteText(api.paletteTextFor({ ...p, mode: 'community30' }, null)).colors).toHaveLength(30);
    expect(api.paletteTextFor({ ...p, mode: 'image' }, ['#abcdef'])).toBe('#abcdef');
    expect(api.paletteTextFor({ ...p, mode: 'image' }, null)).toBe('');
    expect(api.paletteTextFor(p, undefined)).toBe('#123456\n#000000');
  });
  it('persists the choice together with the independent custom palette and survives blocked storage', () => {
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const p: Preferences = { mode: 'community30', customText: '#123456' };
    expect(api.savePalettePreferences(storage, p)).toBe(true);
    expect(api.loadPalettePreferences(storage)).toEqual(p);
    saved = '{broken';
    expect(api.loadPalettePreferences(storage)).toEqual({ mode: 'personal28', customText: '' });
    saved = '{"mode":"unknown","customText":12}';
    expect(api.loadPalettePreferences(storage)).toEqual({ mode: 'personal28', customText: '' });
    expect(api.loadPalettePreferences({ getItem: () => { throw new Error('blocked'); } }).mode).toBe('personal28');
    expect(api.savePalettePreferences({ setItem: () => { throw new Error('blocked'); } }, p)).toBe(false);
  });
});
