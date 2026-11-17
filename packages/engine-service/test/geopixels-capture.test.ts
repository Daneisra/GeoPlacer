import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

type Capture = {
  readRegion: (p: unknown, r: unknown, c: Map<string, unknown>, f: () => unknown, report?: (reason: string) => void, decoded?: Map<string, unknown>) => number[];
  resources: (s: unknown, c: unknown) => Record<string, unknown>;
  tileAt: (x: number, y: number) => unknown;
};
async function library(): Promise<Capture> {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../../../browser/geopixels-capture.js', import.meta.url), 'utf8'), context);
  return context.GeoPlacerCapture as Capture;
}
describe('Browser contract fixture: current GeoPixelsFront cache, no service calls', () => {
  it('reuses only immutable bitmap identities, bounds memory and invalidates replaced or missing tiles',async()=>{
    class Bitmap {width=1000;height=1000;}
    const context=vm.createContext({ImageBitmap:Bitmap});
    vm.runInContext(await readFile(new URL('../../../browser/geopixels-capture.js',import.meta.url),'utf8'),context);
    const capture=context.GeoPlacerCapture,decoded=capture.createReadCache(4_000_000),source=new Map([['0,0',{colorBitmap:new Bitmap()}]]);
    let calls=0;
    const canvas=()=>({getContext:()=>({drawImage:()=>{},getImageData:()=>{calls++;return{data:new Uint8Array(4_000_000)};}})});
    const p={gridX:0,gridY:0,width:1,height:1},r={x:0,y:0,width:1,height:1};
    for(let i=0;i<2;i++){decoded.begin(source);capture.readRegion(p,r,source,canvas,undefined,decoded);}
    expect(calls).toBe(1);expect(decoded.bytes()).toBe(4_000_000);
    source.set('0,0',{colorBitmap:new Bitmap()});decoded.begin(source);capture.readRegion(p,r,source,canvas,undefined,decoded);expect(calls).toBe(2);
    source.get('0,0')!.colorBitmap.width=0;decoded.begin(source);expect(capture.readRegion(p,r,source,canvas,undefined,decoded)).toEqual([-2]);
    source.clear();decoded.begin(source);expect(decoded.bytes()).toBe(0);
    const mutable={width:1000,height:1000};source.set('0,0',{colorBitmap:mutable});
    for(let i=0;i<2;i++){decoded.begin(source);capture.readRegion(p,r,source,canvas,undefined,decoded);}
    expect(calls).toBe(4);
  });
  it('decodes once per capture and rereads the same bitmap on the next capture', async () => {
    const capture=await library(), bitmap={width:1000,height:1000}, cache=new Map([['0,0',{colorBitmap:bitmap}]]);
    let decodes=0,color=1;
    const canvas=()=>({getContext:()=>({drawImage:()=>{},getImageData:()=>{
      decodes++;const data=new Uint8Array(4_000_000);data.set([0,0,color,255]);return{data};
    }})});
    const p={gridX:0,gridY:0,width:1,height:1},r={x:0,y:0,width:1,height:1}, cycle=new Map();
    expect(capture.readRegion(p,r,cache,canvas,undefined,cycle)).toEqual([1]);
    color=2;expect(capture.readRegion(p,r,cache,canvas,undefined,cycle)).toEqual([1]);expect(decodes).toBe(1);
    expect(capture.readRegion(p,r,cache,canvas,undefined,new Map())).toEqual([2]);expect(decodes).toBe(2);
    bitmap.width=0;expect(capture.readRegion(p,r,cache,canvas,undefined,cycle)).toEqual([-2]);
  });
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
  it('reports a closed or unreadable bitmap while keeping its pixels unknown', async () => {
    const capture = await library(), issues: string[] = [];
    const bitmap = { width: 1000, height: 1000 };
    const canvas = () => ({ getContext: () => ({ drawImage: () => { const e = new Error(); e.name = 'InvalidStateError'; throw e; } }) });
    const p = { gridX: 0, gridY: 0, width: 1, height: 1 }, r = { x: 0, y: 0, width: 1, height: 1 };
    expect(capture.readRegion(p, r, new Map([['0,0', { colorBitmap: bitmap }]]), canvas, (v) => issues.push(v))).toEqual([-2]);
    expect(issues).toContain('decode-error:InvalidStateError');
  });
  it('refuses an incompatible bitmap size without guessing its scale', async () => {
    const capture = await library(), issues: string[] = [];
    expect(capture.readRegion({ gridX: 0, gridY: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }, new Map([['0,0', {colorBitmap: {width: 2000, height: 2000}}]]), () => { throw new Error('must not decode'); }, (v) => issues.push(v))).toEqual([-2]);
    expect(issues).toContain('invalid-bitmap-size');
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
    const paths = ['geopixels-capture.js', 'geopixels-reader.js', 'geopixels-http-transport.js', 'geopixels-client.js'];
    const sources = await Promise.all(paths.map((p) => readFile(new URL('../../../browser/' + p, import.meta.url), 'utf8')));
    const bundle = await readFile(new URL('../../../public/geopixels-connector.user.js', import.meta.url), 'utf8');
    const version = bundle.match(/@version\s+([^\s]+)/)![1]!;
    const expected = '(() => {\nconst GeoPlacerReaderVersion = ' + JSON.stringify(version) + ';\n' + sources.map((s) => s.replace(/\r\n/g, '\n')).join('\n') + '\n})();\n';
    expect(bundle.replace(/\r\n/g, '\n').endsWith(expected)).toBe(true);
    expect(sources.join('\n')).not.toMatch(/tokenUser|document\.cookie|PlacePixels|MakePurchase|window\.fetch|localStorage/);
    expect(bundle).toContain('// @grant        GM_xmlhttpRequest');
    expect(bundle).toContain('// @connect      127.0.0.1');
    expect(bundle).not.toMatch(/@connect\s+(?:\*|self|geopixels)/);
    new vm.Script(bundle!);
  });
});
