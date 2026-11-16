/**
 * Phase 1C.1: GeoPixels ghost image export, on the real service. The exported PNG must BE the
 * template GeoPlacer shows (same pixels, transparency kept, the player's colors only, no flip),
 * be importable again unchanged, carry no color-altering chunk, stay separate from the simulation,
 * and be produced without any network connection or GeoPixels account.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { TemplateError, asProjectId, asTemplateId, rgbaToQuantized } from '@geoplacer/core';
import path from 'node:path';
import { EngineService, EngineServiceError, GHOST_PROJECT, createBackup, ghostFilename, parsePalette, restoreBackup } from '../src/index.js';
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
    const exportedMax = await pngjsCodec.decode((await service.exportGhost(m.templateId)).png);
    const gotMax = rgbaToQuantized(exportedMax.width, exportedMax.height, exportedMax.rgba).pixels;
    const expectedMax = (await templateOf(service, m.templateId)).image.pixels;
    expect(Buffer.from(gotMax.buffer, gotMax.byteOffset, gotMax.byteLength).equals(Buffer.from(expectedMax.buffer, expectedMax.byteOffset, expectedMax.byteLength))).toBe(true);
    await expect(service.importGhost({ name: 'Trop', png: max, palette: PALETTE, width: 4097, height: 10 })).rejects.toBeInstanceOf(TemplateError);
  }, 180_000);

  it('595 × 894 separates surface, opaque/retained pixels and transparency; PNG matches the core', async () => {
    const service = await engine();
    const source = await png(595, 894, (x, y) => y * 595 + x < 294_647 ? (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]) : [255, 159, 28, 0]);
    const info = await service.importGhost({ name: 'Fixture 595 × 894', png: source, palette: ['#ffffff', '#000000'] });
    expect({ total: info.totalPixels, opaque: info.paintablePixels, retained: info.retainedPixels, transparent: info.transparentPixels }).toEqual({ total: 531_930, opaque: 294_647, retained: 294_647, transparent: 237_283 });
    expect(info.palette).toEqual(['#ffffff', '#000000']);
    const decoded = await pngjsCodec.decode((await service.exportGhost(info.templateId)).png);
    const got = rgbaToQuantized(decoded.width, decoded.height, decoded.rgba).pixels;
    const wanted = (await templateOf(service, info.templateId)).image.pixels;
    expect(Buffer.from(got.buffer).equals(Buffer.from(wanted.buffer))).toBe(true);
    // Synthetic fixture with the reported counts, not the user's original image.
  });

  it('all-transparent and partially transparent images use the existing alpha filter, never an alpha palette color', async () => {
    const service = await engine();
    const transparent = await png(4, 3, () => [1, 2, 3, 0]);
    const empty = await service.importGhost({ name: 'Transparent', png: transparent, palette: ['#ffffff', '#000000'] });
    expect([empty.totalPixels, empty.paintablePixels, empty.retainedPixels, empty.transparentPixels, empty.colors.length]).toEqual([12, 0, 0, 12, 0]);
    const bytes = await pngjsCodec.decode((await service.exportGhost(empty.templateId)).png);
    expect(bytes.rgba.every((value) => value === 0)).toBe(true);
    const partial = await png(3, 1, (x) => [0, 0, 0, [0, 127, 128][x]!]);
    const kept = await service.importGhost({ name: 'Seuil', png: partial, palette: ['#ffffff', '#000000'], alphaThreshold: 128 });
    expect([kept.totalPixels, kept.paintablePixels, kept.retainedPixels, kept.transparentPixels]).toEqual([3, 1, 1, 2]);
    expect(kept.colors).toEqual([{ hex: '#000000', pixels: 1 }]);
  });

  it('more than 256 source colors are reduced by the existing quantizer; a new palette does not mutate an earlier model', async () => {
    const service = await engine();
    const source = await png(257, 1, (x) => [x & 255, x >> 8, 80, 255]);
    const first = await service.importGhost({ name: 'Noir et blanc', png: source, palette: ['#000000', '#ffffff'] });
    const before = (await service.exportGhost(first.templateId)).png;
    const second = await service.importGhost({ name: 'Nouvelle palette', png: source, palette: ['#ff0000'] });
    expect(second.colors).toEqual([{ hex: '#ff0000', pixels: 257 }]);
    expect((await service.exportGhost(first.templateId)).png).toEqual(before);
    expect((await service.exportGhost(second.templateId)).png).not.toEqual(before);
    expect(first.colors.length).toBeLessThanOrEqual(2);
  });

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

  it('prepared ghost images are in the backups: restored elsewhere, the same export', async () => {
    const root = await tempDir();
    const data = path.join(root, 'engine');
    const { service } = await openFast(data);
    const g = await service.importGhost({ name: 'Sauvegardée', png: await png(9, 5, (x, y) => (x === y ? [0, 0, 0, 0] : [255, 0, 0, 255])), palette: PALETTE, x: 3, y: 4 });
    const before = await service.exportGhost(g.templateId);
    await service.close();
    const { dir } = await createBackup(data, await tempDir());
    const target = path.join(await tempDir(), 'engine');
    await restoreBackup(dir, target);
    const restored = await EngineService.open({ dataDir: target });
    opened.push(restored);
    expect((await restored.listGhosts()).templates.map((t) => t.templateId)).toEqual([g.templateId]);
    expect(await restored.exportGhost(g.templateId)).toEqual(before);
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
