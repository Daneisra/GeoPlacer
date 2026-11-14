/**
 * Phase 1B.6: cost of the number reservations on disk. Every publication
 * lists the template's reservations directory, which grows by one or two
 * files per write. Measured with 100, 1 000 and 10 000 records: listing
 * (reservations), one exclusive creation (reserve, with fsync), and a full
 * settings write (reserve + publish).
 *
 *   npm run bench:reservations
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asProjectId, rgb, type TemplateId } from '@geoplacer/core';
import { NodeTemplateStorage, acquireDataDirectoryLock, openNodeTemplateManager, pngjsCodec } from '../src/index.js';

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const P = asProjectId('bench');

const root = mkdtempSync(path.join(tmpdir(), 'geoplacer-reservations-'));
try {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
  let id: TemplateId;
  {
    const { manager, close } = await openNodeTemplateManager(root);
    const sourcePng = await pngjsCodec.encode({ width: 4, height: 4, rgba: new Uint8Array(64).fill(255) });
    const t = await manager.create({ projectId: P, name: 'bench', sourcePng, palette: { id: 'p', colors: [{ rgb: rgb(255, 255, 255) }] }, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } });
    id = t.id;
    await close();
  }
  let count = 1;
  for (const target of [100, 1000, 10_000]) {
    const lock = await acquireDataDirectoryLock(root);
    const storage = new NodeTemplateStorage(lock);
    // Fill with old revision records (as left by many past writes), far below the live numbers.
    const fillStart = performance.now();
    for (; count < target; count++) await storage.reserve(P, id, 'revision', 1_000_000 + count);
    const fillMs = performance.now() - fillStart;
    const list: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      await storage.reservations(P, id);
      list.push(performance.now() - t);
    }
    const reserveTimes: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      await storage.reserve(P, id, 'generation', 5_000_000 + target * 10 + k);
      reserveTimes.push(performance.now() - t);
    }
    await lock.release();
    const { manager, close } = await openNodeTemplateManager(root);
    const writes: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      await manager.updateSettings({ projectId: P, templateId: id }, { priority: target + k });
      writes.push(performance.now() - t);
    }
    await close();
    console.log(
      JSON.stringify({
        records: target,
        listMs: +median(list).toFixed(2),
        reserveMs: +median(reserveTimes).toFixed(2),
        settingsWriteMs: +median(writes).toFixed(2),
        fillMsPerRecord: +(fillMs / Math.max(1, target - 1)).toFixed(3),
      })
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
