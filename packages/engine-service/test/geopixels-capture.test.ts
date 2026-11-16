import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

type Capture = {
  readRegion: (p: unknown, r: unknown, c: Map<string, unknown>, f: () => unknown) => number[];
  resources: (s: unknown, c: unknown) => Record<string, unknown>;
  tileAt: (x: number, y: number) => unknown;
};
async function library(): Promise<Capture> {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../../../browser/geopixels-capture.js', import.meta.url), 'utf8'), context);
  return context.GeoPlacerCapture as Capture;
}
describe('Browser contract fixture: current GeoPixelsFront cache, no service calls', () => {
  it('reads only loaded color bitmaps, Y as native bitmap row, across negative tile edges', async () => {
    const capture = await library();
    const bitmap = { width: 1000, height: 1000 };
    const cache = new Map([['-1000,0', { colorBitmap: bitmap }]]);
    const bytes = new Uint8Array(1000 * 1000 * 4);
    const index = (999 * 1000 + 999) * 4;
    bytes.set([255, 0, 0, 255], index);
    const canvas = () => ({ getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: bytes }) }) });
    const result = capture.readRegion(
      { gridX: -1, gridY: 1000, width: 2, height: 2 },
      { x: -1, y: 999, width: 2, height: 2 },
      cache,
      canvas
    );
    expect(result).toEqual([0xff0000, -2, -2, -2]);
  });
  it('distinguishes transparent, partial alpha, missing and merging tiles', async () => {
    const capture = await library();
    const bytes = new Uint8Array(1000 * 1000 * 4);
    bytes.set([1, 2, 3, 128], 4);
    const cache = new Map([
      ['0,0', { colorBitmap: { width: 1000, height: 1000 } }],
      ['1000,0', { colorBitmap: null }],
    ]);
    const canvas = () => ({ getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: bytes }) }) });
    expect(capture.readRegion({ gridX: 0, gridY: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 2, height: 1 }, cache, canvas)).toEqual([
      -1, -2,
    ]);
    expect(
      capture.readRegion({ gridX: 1000, gridY: 0, width: 1, height: 1 }, { x: 1000, y: 0, width: 1, height: 1 }, cache, canvas)
    ).toEqual([-2]);
  });
  it('whitelists numeric resource fields and never copies authentication or profile fields', async () => {
    const capture = await library();
    const resources = capture.resources(
      { energy: 5, maxEnergy: 30, pixels: 50, energyRate: 60, checkedTick: 1000, tokenUser: 'secret', subject: 'secret', email: 'private' },
      ['#000000', '#ffffff', '#00000000']
    );
    expect(resources).toEqual({
      observedAt: 1_000_000,
      energy: 5,
      capacity: 30,
      currency: 50,
      regenIntervalMs: 60_000,
      colors: [0, 0xffffff],
    });
    expect(JSON.stringify(resources)).not.toContain('secret');
    expect(capture.resources(null, [])).toBeNull();
  });
  it('keeps generated reader bundle deterministic and has no service writer or network interception', async () => {
    const [capture, client, bundle] = await Promise.all(
      ['../../../browser/geopixels-capture.js', '../../../browser/geopixels-client.js', '../../../public/geopixels-connector.user.js'].map(
        (p) => readFile(new URL(p, import.meta.url), 'utf8')
      )
    );
    expect(bundle!.replace(/\r\n/g, '\n').endsWith(capture!.replace(/\r\n/g, '\n') + '\n' + client!.replace(/\r\n/g, '\n'))).toBe(true);
    expect(capture! + client!).not.toMatch(/tokenUser|document\.cookie|PlacePixels|MakePurchase|window\.fetch|localStorage/);
    new vm.Script(bundle!);
  });
});
