/**
 * Phase 1C.1: GeoPixels ghost image export, on the real service. The exported PNG must BE the
 * template GeoPlacer shows (same pixels, transparency kept, the player's colors only, no flip),
 * be importable again unchanged, carry no color-altering chunk, stay separate from the simulation,
 * and be produced without any network connection or GeoPixels account.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { TemplateError, asProjectId, asTemplateId, rgbaToQuantized } from '@geoplacer/core';
import { EngineService, EngineServiceError, GHOST_PROJECT, ghostFilename, parsePalette } from '../src/index.js';
import { cleanup, openFast, tempDir } from './helpers.js';

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});
const engine = async () => {
  const { service } = await openFast(await tempDir());
  opened.push(service);
  return service;
};

const RED = [255, 0, 0];
const GREEN = [0, 200, 0];
const BLUE = [0, 0, 255];
const PALETTE = ['#ff0000', '#00c800', '#0000ff'];

/** An RGBA image as PNG bytes. */
async function png(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(px(x, y), (y * width + x) * 4);
  return pngjsCodec.encode({ width, height, rgba });
}

const chunks = (bytes: Uint8Array): string[] => {
  const b = Buffer.from(bytes);
  const out: string[] = [];
  for (let i = 8; i < b.length; i += 12 + b.readUInt32BE(i)) out.push(b.toString('ascii', i + 4, i + 8));
  return out;
};

async function templateOf(service: EngineService, id: string) {
  return (await service.templates.load({ projectId: asProjectId(GHOST_PROJECT), templateId: asTemplateId(id) })).template;
}

describe('GeoPixels ghost image export (Phase 1C.1)', () => {
  it('a transparent, non-square image: the export IS the template, transparency and orientation kept, palette colors only', async () => {
    const service = await engine();
    // 37 x 13; a red block top-left, a blue block bottom-right, a transparent band, near-colors elsewhere.
    const source = await png(37, 13, (x, y) =>
      x < 5 && y < 3 ? [255, 0, 0, 255] : x > 31 && y > 9 ? [0, 0, 255, 255] : y === 6 ? [10, 10, 10, 0] : x % 3 === 0 ? [240, 20, 20, 200] : [20, 190, 30, 255]
    );
    const info = await service.importGhost({ name: 'Essai transparent', png: source, palette: PALETTE });
    expect({ w: info.width, h: info.height }).toEqual({ w: 37, h: 13 });
    expect(info.transparentPixels).toBe(37);
    expect(info.paintablePixels).toBe(37 * 12);
    const exported = await service.exportGhost(info.templateId);
    expect(chunks(exported.png)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const decoded = await pngjsCodec.decode(exported.png);
    expect({ w: decoded.width, h: decoded.height }).toEqual({ w: 37, h: 13 });
    const t = await templateOf(service, info.templateId);
    // Same pixels as the template GeoPlacer keeps (and shows).
    expect([...rgbaToQuantized(decoded.width, decoded.height, decoded.rgba).pixels]).toEqual([...t.image.pixels]);
    const px = (x: number, y: number) => [...decoded.rgba.subarray((y * 37 + x) * 4, (y * 37 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([...RED, 255]); // top-left stays top-left: no flip
    expect(px(36, 12)).toEqual([...BLUE, 255]);
    expect(px(10, 6)).toEqual([0, 0, 0, 0]); // transparent, alpha exactly 0
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      const a = decoded.rgba[i + 3]!;
      expect(a === 0 || a === 255).toBe(true);
      if (a === 255) expect(PALETTE).toContain(`#${[...decoded.rgba.subarray(i, i + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    }
    expect(px(3, 4)).toEqual([...RED, 255]); // (240, 20, 20) -> the nearest player color
    expect(px(4, 4)).toEqual([...GREEN, 255]);
  });

  it('re-importing the exported PNG with the same palette gives the same template', async () => {
    const service = await engine();
    const source = await png(20, 11, (x, y) => [(x * 13) % 256, (y * 23) % 256, ((x + y) * 7) % 256, x === y ? 0 : 255]);
    const first = await service.importGhost({ name: 'Original', png: source, palette: PALETTE });
    const again = await service.importGhost({ name: 'Réimport', png: (await service.exportGhost(first.templateId)).png, palette: PALETTE });
    expect([...(await templateOf(service, again.templateId)).image.pixels]).toEqual([...(await templateOf(service, first.templateId)).image.pixels]);
    expect(again.colors).toEqual(first.colors);
  });

  it('large images and resizing: 3000 x 2000 reduced to 1500 wide (proportions kept), 4096 x 4096 kept', async () => {
    const service = await engine();
    const big = await png(3000, 2000, (x, y) => (x < 1500 ? [250, 5, 5, 255] : y < 1000 ? [5, 5, 250, 255] : [0, 0, 0, 0]));
    const info = await service.importGhost({ name: 'Grande', png: big, palette: PALETTE, width: 1500 });
    expect({ w: info.width, h: info.height }).toEqual({ w: 1500, h: 1000 });
    const decoded = await pngjsCodec.decode((await service.exportGhost(info.templateId)).png);
    const px = (x: number, y: number) => [...decoded.rgba.subarray((y * 1500 + x) * 4, (y * 1500 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([...RED, 255]);
    expect(px(1499, 0)).toEqual([...BLUE, 255]);
    expect(px(1499, 999)).toEqual([0, 0, 0, 0]);
    const max = await png(4096, 4096, (x) => (x % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const m = await service.importGhost({ name: 'Maximum', png: max, palette: PALETTE });
    expect({ w: m.width, h: m.height, painted: m.paintablePixels }).toEqual({ w: 4096, h: 4096, painted: 4096 * 4096 });
    await expect(service.importGhost({ name: 'Trop', png: max, palette: PALETTE, width: 4097, height: 10 })).rejects.toBeInstanceOf(TemplateError);
  }, 180_000);

  it('GeoPixels coordinates are kept as typed (large values, negative ones), in the info and the file name', async () => {
    const service = await engine();
    const source = await png(4, 3, () => [255, 0, 0, 255]);
    const at = await service.importGhost({ name: 'Point d’apparition', png: source, palette: PALETTE, x: 107958, y: 196137 });
    expect(at.topLeft).toEqual({ x: 107958, y: 196137 });
    expect(at.filename).toBe('geopixels-point-d-apparition-4x3-x107958-y196137.png');
    const neg = await service.importGhost({ name: 'Négatif', png: source, palette: PALETTE, x: -12, y: -7 });
    expect(neg.topLeft).toEqual({ x: -12, y: -7 });
    // The coordinates never change the pixels.
    expect((await service.exportGhost(at.templateId)).png).toEqual((await service.exportGhost(neg.templateId)).png);
  });

  it('the palette is validated: hex colors, duplicates removed, 1 to 256 colors', async () => {
    expect(parsePalette(['#FF0000', 'ff0000', ' #00ff00 '])).toEqual([0xff0000, 0x00ff00]);
    for (const bad of [[], ['red'], ['#ff00'], ['#ff0000zz'], Array.from({ length: 257 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`)]) {
      expect(() => parsePalette(bad)).toThrow(TemplateError);
    }
    expect(ghostFilename('Évasion "x"\r\n/../secret', 2, 3, 0, 0)).toBe('geopixels-evasion-x-secret-2x3-x0-y0.png');
    expect(ghostFilename('***', 1, 1, 5, 6)).toBe('geopixels-modele-1x1-x5-y6.png');
  });

  it('stays separate from the simulation: never listed, selectable or started; the demonstration stays available', async () => {
    const service = await engine();
    const g = await service.importGhost({ name: 'Fantôme', png: await png(3, 3, () => [0, 0, 255, 255]), palette: PALETTE });
    expect((await service.listTemplates()).templates).toEqual([]);
    await expect(service.selectTemplate(g.templateId)).rejects.toBeInstanceOf(EngineServiceError);
    expect((await service.demoAvailability()).available).toBe(true);
    expect((await service.listGhosts()).templates.map((t) => t.templateId)).toEqual([g.templateId]);
    await service.deleteGhost(g.templateId);
    expect((await service.listGhosts()).templates).toEqual([]);
    await expect(service.exportGhost(g.templateId)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    await expect(service.ghostInfoOf('../../x')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('import, export and delete open no network connection (no GeoPixels account, nothing sent)', async () => {
    const service = await engine();
    const net = await import('node:net');
    const original = net.Socket.prototype.connect;
    const attempts: unknown[] = [];
    net.Socket.prototype.connect = function (this: unknown, ...args: unknown[]) {
      attempts.push(args[0]);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      const g = await service.importGhost({ name: 'Hors ligne', png: await png(16, 9, (x) => [x * 16, 0, 0, 255]), palette: PALETTE, width: 8 });
      await service.exportGhost(g.templateId);
      await service.listGhosts();
      await service.deleteGhost(g.templateId);
    } finally {
      net.Socket.prototype.connect = original;
    }
    expect(attempts).toEqual([]);
  });
});
