/**
 * Phase 1B.10: display of large templates (up to 4096 x 4096): the viewer
 * geometry (frontend/src/lib/viewport.ts, pure) and the sampled reads of the
 * service (canvas and template overlay, aligned), consistent with the
 * engine's counters.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineService } from '../src/index.js';
import { cleanup, decodeRegion, demoPng, openFast, tempDir, waitFor } from './helpers.js';

interface Rect {
  minX: number;
  minY: number;
  width: number;
  height: number;
}
interface View {
  zoom: number;
  cx: number;
  cy: number;
}
interface Viewport {
  BOX: number;
  MAX_ZOOM: number;
  fitZoom(area: Rect): number;
  fitView(area: Rect): View;
  clampView(area: Rect, view: View): View;
  visibleRect(area: Rect, view: View): Rect;
  scaleFor(zoom: number): number;
  zoomBy(area: Rect, view: View, factor: number, focus?: { x: number; y: number }): View;
  panBy(area: Rect, view: View, dx: number, dy: number, yAxis?: 'down' | 'up'): View;
  displayIndex(canvasIndex: number, canvasWidth: number, s: { rect: Rect; scale: number; width: number; height: number; yAxis: 'down' | 'up' }): number;
  wholeAreaVisible(area: Rect, visible: Rect): boolean;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vp = (await import(pathToFileURL(path.join(repo, 'frontend', 'src', 'lib', 'viewport.ts')).href)) as Viewport;

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});

describe('viewer geometry', () => {
  const sizes: [number, number][] = [
    [256, 256],
    [1000, 1000],
    [2000, 2000],
    [4096, 4096],
    [1000, 300],
    [120, 2000],
  ];
  it.each(sizes)('a %i x %i template is shown WHOLE at the fit zoom, with proportions kept and a bounded read', (w, h) => {
    const area = { minX: 7, minY: 11, width: w, height: h };
    const view = vp.fitView(area);
    const visible = vp.visibleRect(area, view);
    expect(vp.wholeAreaVisible(area, visible)).toBe(true);
    // Proportions: the same zoom on both axes, the longer side fills the box.
    expect(Math.max(w, h) * view.zoom).toBeCloseTo(vp.BOX, 6);
    // The read stays near the box size whatever the template.
    const s = vp.scaleFor(view.zoom);
    expect(Math.ceil(w / s) * Math.ceil(h / s)).toBeLessThanOrEqual(4 * vp.BOX * vp.BOX);
    // Sampled from twice the box on (below, the browser scales a read at most 4 x BOX²).
    if (Math.max(w, h) >= 2 * vp.BOX) expect(s).toBeGreaterThan(1);
    else expect(s).toBe(1);
  });

  it('zooms around a point, pans within the template, never beyond it', () => {
    const area = { minX: 0, minY: 0, width: 4096, height: 4096 };
    let view = vp.fitView(area);
    view = vp.zoomBy(area, view, 64, { x: 100, y: 200 });
    expect(view.zoom).toBeCloseTo(vp.fitZoom(area) * 64, 6);
    let visible = vp.visibleRect(area, view);
    expect(vp.wholeAreaVisible(area, visible)).toBe(false);
    expect(visible.width).toBe(Math.ceil(vp.BOX / view.zoom));
    // The focus stays inside the visible part.
    expect(100).toBeGreaterThanOrEqual(visible.minX);
    expect(100).toBeLessThan(visible.minX + visible.width);
    // Pan far left/up: clamped to the template.
    view = vp.panBy(area, view, 1e6, 1e6);
    visible = vp.visibleRect(area, view);
    expect(visible).toMatchObject({ minX: 0, minY: 0 });
    view = vp.panBy(area, view, -1e7, -1e7);
    visible = vp.visibleRect(area, view);
    expect(visible.minX + visible.width).toBe(4096);
    expect(visible.minY + visible.height).toBe(4096);
    // Zoom bounds.
    expect(vp.clampView(area, { zoom: 1e9, cx: 0, cy: 0 }).zoom).toBe(vp.MAX_ZOOM);
    expect(vp.clampView(area, { zoom: 1e-9, cx: 0, cy: 0 }).zoom).toBe(vp.fitZoom(area));
  });

  it('maps a changed canvas pixel to the displayed sample (or none), rows flipped for a y axis going up', () => {
    const region = { rect: { minX: 10, minY: 20, width: 100, height: 50 }, scale: 4, width: 25, height: 13, yAxis: 'down' as const };
    const W = 500;
    const at = (x: number, y: number) => y * W + x;
    expect(vp.displayIndex(at(10, 20), W, region)).toBe(0);
    expect(vp.displayIndex(at(14, 24), W, region)).toBe(1 * 25 + 1);
    expect(vp.displayIndex(at(11, 20), W, region)).toBe(-1); // not a sample
    expect(vp.displayIndex(at(9, 20), W, region)).toBe(-1); // outside
    expect(vp.displayIndex(at(10, 70), W, region)).toBe(-1); // outside (below)
    expect(vp.displayIndex(at(10, 20), W, { ...region, yAxis: 'up' })).toBe(12 * 25);
    expect(vp.displayIndex(at(10, 68), W, { ...region, yAxis: 'up' })).toBe(0);
  });
});

describe('sampled reads of the service', () => {
  it('a 4096 x 4096 canvas is read whole at the smallest fitting scale, each sample exact', async () => {
    const root = await tempDir();
    const { service } = await openFast(root);
    opened.push(service);
    await service.configure({ simulator: { width: 4096, height: 4096 }, resetWorld: true });
    // Known pixels on the sampling grid of scale 2 and of scale 8, and one off-grid.
    const marks: { point: { x: number; y: number }; color: number }[] = [
      { point: { x: 0, y: 0 }, color: 0xff0000 },
      { point: { x: 4088, y: 4088 }, color: 0x00ff00 },
      { point: { x: 1024, y: 2048 }, color: 0x0000ff },
      { point: { x: 3, y: 3 }, color: 0x123456 },
    ];
    // editExternal is the simulated outside actor: allowed while stopped.
    await (service as unknown as { world: { canvas: { editExternal(c: typeof marks): Promise<unknown> } } }).world.canvas.editExternal(marks);
    const whole = await service.canvasRegion();
    expect(whole).toMatchObject({ scale: 2, width: 2048, height: 2048, yAxis: 'down', rect: { minX: 0, minY: 0, width: 4096, height: 4096 } });
    const v = decodeRegion(whole.data);
    expect(v[0]).toBe(0xff0000);
    expect(v[2044 * 2048 + 2044]).toBe(0x00ff00);
    expect(v[1024 * 2048 + 512]).toBe(0x0000ff);
    expect(v.filter((x) => x === 0x123456).length).toBe(0); // off the grid: not a sample
    const coarse = await service.canvasRegion({ minX: 0, minY: 0, width: 4096, height: 4096 }, 8);
    expect(coarse).toMatchObject({ width: 512, height: 512 });
    expect(decodeRegion(coarse.data)[511 * 512 + 511]).toBe(0x00ff00);
    // A read too large for its scale, or a bad scale, is refused.
    await expect(service.canvasRegion({ minX: 0, minY: 0, width: 4096, height: 4096 }, 1)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.canvasRegion({ minX: 0, minY: 0, width: 16, height: 16 }, 0)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('a non-square template: overlay aligned with the canvas at every scale; displayed pixels match the engine counters', { timeout: 180_000 }, async () => {
    const root = await tempDir();
    const { service } = await openFast(root);
    opened.push(service);
    await service.configure({ simulator: { width: 600, height: 400, capacity: 1_000_000 }, agent: { startEnergy: 1_000_000 }, run: { maxBatchSize: 1000 }, resetWorld: true });
    const t = await service.importTemplate({ name: 'Large', png: await demoPng(400, 240, (x, y) => ((x * 7 + y * 3) % 11 === 0 ? null : ((x >> 4) + (y >> 4)) % 8)), x: 150, y: 60, strategy: 'top-to-bottom' });
    await service.selectTemplate(t.templateId);
    await service.start();
    const done = await waitFor(service, (s) => s.state === 'completed', 120_000);
    expect(done.scheduler?.correct).toBe(t.paintablePixels);
    expect(done.scheduler?.incorrect).toBe(0);
    for (const scale of [1, 3, 7]) {
      const rect = { minX: 150, minY: 60, width: 400, height: 240 };
      const canvas = decodeRegion((await service.canvasRegion(rect, scale)).data);
      const img = await service.templateImage(t.templateId, rect, scale);
      const want = decodeRegion(img.data);
      expect(canvas.length).toBe(want.length);
      // Every displayed sample: the template color where paintable, the canvas holds it.
      let painted = 0;
      for (let i = 0; i < want.length; i++) {
        if (want[i] === -1) continue;
        painted++;
        expect(canvas[i]).toBe(want[i]);
      }
      if (scale === 1) expect(painted).toBe(t.paintablePixels); // same count as the engine
    }
    // Default read of a large template: whole, scaled to fit one read.
    const def = await service.canvasRegion();
    expect(def.rect).toMatchObject({ minX: 150, minY: 60, width: 400, height: 240 });
    expect(def.scale).toBe(1);
  });

  it('a template partly outside the canvas is refused (never shown truncated without notice)', async () => {
    const root = await tempDir();
    const { service } = await openFast(root);
    opened.push(service);
    await expect(service.importTemplate({ name: 'Débord', png: await demoPng(40, 40, () => 1), x: 50, y: 50, strategy: 'random' }).then((t) => service.selectTemplate(t.templateId))).rejects.toMatchObject({
      code: 'TEMPLATE_OUTSIDE_CANVAS',
    });
  });
});
