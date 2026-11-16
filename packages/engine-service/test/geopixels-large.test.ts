import { describe, expect, it } from 'vitest';
import { computeProgress, TRANSPARENT_U32, type Template } from '@geoplacer/core';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';

describe('Full native slab observations and existing progress engine', () => {
  it.each([
    [64, 64],
    [595, 894],
    [2000, 2000],
  ])('compares every eligible pixel at %i x %i', async (width, height) => {
    const start = performance.now(),
      now = Date.now();
    const p = new GeoPixelsProvider(() => now);
    p.connect('local-fake', () => {});
    const expected = (x: number, y: number) => ((x + y) % 13 === 0 ? -1 : (x * 7 + y * 3) % 2 === 0 ? 0 : 0xffffff);
    const image = new Uint32Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const c = expected(x, y);
        image[y * width + x] = c === -1 ? TRANSPARENT_U32 : c;
      }
    const project = { id: 'large', generation: '1', width, height, gridX: -1001, gridY: 1001, layer: 'base' };
    let sequence = 0;
    for (let row = 0; row < height;) {
      const h = Math.min(height - row, Math.floor(65536 / width));
      const pixels: number[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < width; x++) pixels.push(expected(x, row + h - 1 - y));
      p.observe({
        type: 'observation',
        sequence: ++sequence,
        session: 'large-browser',
        project,
        capturedAt: now,
        observedAt: now,
        rect: { x: project.gridX, y: project.gridY - row - h + 1, width, height: h },
        pixels,
        resources: null,
      });
      row += h;
    }
    const t = {
      id: 'model',
      revision: 1,
      image: { width, height, pixels: image },
      coordinateSystem: { yAxis: 'down' },
      placement: { topLeft: { x: 0, y: 0 } },
    } as unknown as Template;
    p.bind(t);
    const captured = performance.now();
    const s = await p.reader.readRegion({ minX: 0, minY: 0, width, height });
    const copied = performance.now();
    const progress = computeProgress(t, s, now);
    const end = performance.now();
    expect(progress.incorrect).toBe(0);
    expect(progress.unknown).toBe(0);
    expect(progress.correct + progress.excluded.transparent).toBe(width * height);
    expect(progress.coveragePercent).toBe(100);
    expect(progress.basis.kind).toBe('simulation');
    console.log(
      JSON.stringify({
        fixture: `${width}x${height}`,
        ingestMs: Math.round(captured - start),
        readMs: Math.round(copied - captured),
        progressMs: Math.round(end - copied),
        correct: progress.correct,
        transparent: progress.excluded.transparent,
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      })
    );
    p.close();
  });
});
