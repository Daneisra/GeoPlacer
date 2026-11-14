/**
 * Large-template benchmark with the real adapters (filesystem, pngjs, SHA-256).
 *
 *   npm run bench:templates            -> every scenario, one child process each
 *   node --import tsx templates.bench.ts <size> <kind>   -> one scenario
 *
 * Each scenario runs in a fresh process so that the reported peak RSS
 * (process.resourceUsage().maxRSS) belongs to that scenario alone.
 * Measured: create (header check, decode, quantize, encode, round-trip
 * check, hashes, blob writes, manifest), load (read, hashes, decode,
 * canonical check; never re-quantizes), placement-only revision and
 * verify. Fixture generation (source PNG encoding) is not measured.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asProjectId, rgb, type Palette } from '@geoplacer/core';
import { openNodeTemplateManager, pngjsCodec } from '../src/index.js';

const SCENARIOS: Array<[number, 'noise' | 'pixel-art']> = [
  [2000, 'pixel-art'],
  [2000, 'noise'],
  [4096, 'pixel-art'],
  [4096, 'noise'],
];

/** 32 colors spread over the RGB cube (a GeoPixels-sized palette). */
const palette: Palette = {
  id: 'bench-32',
  colors: Array.from({ length: 32 }, (_, i) => ({ rgb: rgb((i * 97) % 256, (i * 53 + 40) % 256, (i * 29 + 90) % 256) })),
};

function makeRgba(size: number, kind: 'noise' | 'pixel-art'): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (kind === 'noise') {
        const v = random();
        rgba[i] = v & 0xff;
        rgba[i + 1] = (v >>> 8) & 0xff;
        rgba[i + 2] = (v >>> 16) & 0xff;
        rgba[i + 3] = (v >>> 24) & 0x80 ? 255 : 0;
      } else {
        // 16x16 blocks of palette colors, 1 block in 8 transparent.
        const block = ((x >> 4) * 31 + (y >> 4) * 17) % 33;
        const color = palette.colors[block % 32]?.rgb ?? 0;
        rgba[i] = (color >> 16) & 0xff;
        rgba[i + 1] = (color >> 8) & 0xff;
        rgba[i + 2] = color & 0xff;
        rgba[i + 3] = block === 32 ? 0 : 255;
      }
    }
  }
  return rgba;
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, performance.now() - start];
}

async function runOne(size: number, kind: 'noise' | 'pixel-art'): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'geoplacer-bench-'));
  try {
    const sourcePng = await pngjsCodec.encode({ width: size, height: size, rgba: makeRgba(size, kind) });
    const first = await openNodeTemplateManager(root);
    const projectId = asProjectId('bench');
    const [t, createMs] = await time(() =>
      first.manager.create({ projectId, name: 'bench', sourcePng, palette, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } })
    );
    await first.close();
    // Load through a fresh instance (nothing cached), as after a restart.
    const { manager, close } = await openNodeTemplateManager(root);
    const ref = { projectId, templateId: t.id };
    const [, loadMs] = await time(() => manager.load(ref));
    const [, reviseMs] = await time(() => manager.revise(ref, { placement: { topLeft: { x: 1, y: 1 } } }));
    const [, verifyMs] = await time(() => manager.verify(ref));
    await close();
    const peakMb = process.resourceUsage().maxRSS / 1024;
    console.log(
      JSON.stringify({ size: `${size}x${size}`, kind, sourcePngMb: +(sourcePng.length / 1e6).toFixed(1), createMs: Math.round(createMs), loadMs: Math.round(loadMs), placementReviseMs: Math.round(reviseMs), verify2RevisionsMs: Math.round(verifyMs), peakRssMb: Math.round(peakMb) })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const [sizeArg, kindArg] = process.argv.slice(2);
if (sizeArg !== undefined && (kindArg === 'noise' || kindArg === 'pixel-art')) {
  await runOne(Number(sizeArg), kindArg);
} else {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}; one process per scenario`);
  const self = fileURLToPath(import.meta.url);
  for (const [size, kind] of SCENARIOS) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', self, String(size), kind], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = 1;
  }
}
