/**
 * Child process of the process-kill test: mutates one template forever
 * through the real filesystem adapters until the parent kills it.
 * argv: <storage root> [templateId]
 */

import { asProjectId, rgb, type TemplateId } from '@geoplacer/core';
import { createNodeTemplateManager } from '../../src/index.js';

const [root, existing] = process.argv.slice(2);
if (root === undefined) throw new Error('usage: kill-child <root> [templateId]');
const manager = createNodeTemplateManager(root);
const projectId = asProjectId('projet-kill');

async function main(): Promise<void> {
  let templateId = existing as TemplateId | undefined;
  if (templateId === undefined) {
    const { pngjsCodec } = await import('../../src/png-codec.js');
    const rgba = new Uint8Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const sourcePng = await pngjsCodec.encode({ width: 32, height: 32, rgba });
    const palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(200, 30, 30) }, { rgb: rgb(30, 200, 30) }] };
    const t = await manager.create({ projectId, name: 'Kill', sourcePng, palette, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } });
    templateId = t.id;
  }
  process.stdout.write(`ready ${templateId}\n`);
  const ref = { projectId, templateId };
  for (let i = 1; ; i++) {
    if (i % 3 === 0) await manager.revise(ref, { alphaThreshold: 1 + (i % 250) });
    else if (i % 3 === 1) await manager.revise(ref, { placement: { topLeft: { x: i, y: -i } } });
    else await manager.updateSettings(ref, { priority: i });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
