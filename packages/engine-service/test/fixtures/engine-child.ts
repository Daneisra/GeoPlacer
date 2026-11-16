/**
 * Crash child of the service tests (Phase 1B.9). argv: <dir> <step>.
 *
 * Opens the engine on <dir> with fast synthetic settings, imports and
 * selects a 16 x 16 template, starts the simulation and kills itself at
 * the named step `<world store step>#<n>` (counted from the start): explicit
 * synchronisation, no timer. Prints "ready <templateId> <paintable>".
 */

import { writeSync } from 'node:fs';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { DEMO_COLORS, EngineService, type WorldStoreStep } from '../../src/index.js';

const [dir, step] = process.argv.slice(2);
if (dir === undefined || step === undefined) throw new Error('usage: engine-child <dir> <step>');
const [kind, occurrence] = step.split('#');
const target = Number(occurrence);
let armed = false;
let seen = 0;

const service = await EngineService.open({
  dataDir: dir,
  // A low threshold puts automatic world checkpoints inside the run (GP_WORLD_CHECKPOINT).
  worldCheckpointRecords: Number(process.env.GP_WORLD_CHECKPOINT ?? 2000),
  // Phase 1C.0: GP_COOPERATIVE=0 runs the scheduler without yields (the timing before 1C.0).
  ...(process.env.GP_COOPERATIVE === '0' ? { cooperative: false as const } : {}),
  worldStore: {
    onStep: (s: WorldStoreStep) => {
      if (!armed || s !== kind) return;
      if (++seen === target) {
        writeSync(1, `reached ${step}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  },
});
await service.configure({
  simulator: { width: 64, height: 64, costPerPixel: 1, capacity: 1000, regenIntervalMs: 3_600_000, writeLatencyMs: 1 },
  agent: { startEnergy: 1000, startCurrency: 0 },
  run: { maxBatchSize: 7, minBatchSize: 1 },
  resetWorld: true,
});
const w = 16;
const rgba = new Uint8Array(w * w * 4);
for (let i = 0; i < w * w; i++) {
  if (i % 5 === 0) continue;
  const c = DEMO_COLORS[i % 3 === 0 ? 4 : 9]!;
  rgba.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 255], i * 4);
}
const t = await service.importTemplate({ name: 'Crash', png: await pngjsCodec.encode({ width: w, height: w, rgba }), x: 3, y: 4, strategy: 'random' });
await service.selectTemplate(t.templateId);
writeSync(1, `ready ${t.templateId} ${t.paintablePixels}\n`);
armed = true;
await service.start();
await service.done();
writeSync(1, 'completed without reaching the step\n');
await service.close();
