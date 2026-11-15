/**
 * Child process of the template crash tests: mutates one template forever
 * through the real filesystem adapters and KILLS ITSELF at the named
 * storage step (Phase 1B.8: explicit synchronisation, no timer).
 * argv: <storage root> <templateId or -> <step>
 * It prints "ready <templateId>" once the template exists (steps are
 * counted from then on), and "reached <step>" just before dying.
 */

import { asProjectId, rgb, type TemplateId } from '@geoplacer/core';
import { openNodeTemplateManager } from '../../src/index.js';
import { stepKiller } from './step-kill.js';

const [root, existing, step] = process.argv.slice(2);
if (root === undefined || existing === undefined || step === undefined) throw new Error('usage: kill-child <root> <templateId|-> <step>');
const killer = stepKiller(step);
const { manager } = await openNodeTemplateManager(root, { storage: { onStep: killer.onStep } });
const projectId = asProjectId('projet-kill');

async function main(): Promise<void> {
  let templateId = existing === '-' ? undefined : (existing as TemplateId);
  if (templateId === undefined) {
    const { pngjsCodec } = await import('../../src/png-codec.js');
    const rgba = new Uint8Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const sourcePng = await pngjsCodec.encode({ width: 32, height: 32, rgba });
    const palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(200, 30, 30) }, { rgb: rgb(30, 200, 30) }] };
    const t = await manager.create({ projectId, name: 'Kill', sourcePng, palette, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } });
    templateId = t.id;
  }
  process.stdout.write(`ready ${templateId}\n`);
  killer.arm();
  const ref = { projectId, templateId };
  const { pngjsCodec } = await import('../../src/png-codec.js');
  for (let i = 1; i < 200; i++) {
    if (i % 5 === 4) {
      // A new source image: a new quantized blob is written (crash points on .png files).
      const rgba = new Uint8Array(16 * 16 * 4).map((_, k) => (k % 4 === 3 ? 255 : (k * 13 + i * 7) % 256));
      await manager.revise(ref, { sourcePng: await pngjsCodec.encode({ width: 16, height: 16, rgba }) });
    } else if (i % 3 === 0) await manager.revise(ref, { alphaThreshold: 1 + (i % 250) });
    else if (i % 3 === 1) await manager.revise(ref, { placement: { topLeft: { x: i, y: -i } } });
    else await manager.updateSettings(ref, { priority: i });
  }
  process.stdout.write('done without reaching the step\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
