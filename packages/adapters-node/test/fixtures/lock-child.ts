/**
 * Child process of the two-process lock tests: opens a template manager on a
 * data directory, writes one template, holds the directory for `holdMs`,
 * then closes and exits 0. A refused instance prints its error code and the
 * owner's pid, then exits 3.
 * argv: <root> <mechanism> <holdMs>
 */

import { asProjectId, rgb } from '@geoplacer/core';
import { DataDirectoryLockedError, acquireInstanceGuard, openNodeTemplateManager, pngjsCodec, type LockMechanism } from '../../src/index.js';

const [root, mechanism, holdMs] = process.argv.slice(2);
if (root === undefined || mechanism === undefined) throw new Error('usage: lock-child <root> <mechanism> <holdMs>');

async function main(): Promise<void> {
  if (mechanism === 'guard-only') {
    // Phase 1B.9: only the named pipe guard (no lock inside the directory).
    try {
      const guard = await acquireInstanceGuard(root as string);
      process.stdout.write(`guard ${guard.status.status}\n`);
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs ?? 0)));
      await guard.release();
      return;
    } catch (error) {
      if (error instanceof DataDirectoryLockedError) {
        process.stdout.write(`refused ${error.code} ${String(error.owner?.pid ?? 'unknown')}\n`);
        process.exit(3);
      }
      throw error;
    }
  }
  let handle;
  try {
    handle = await openNodeTemplateManager(root as string, { lockMechanism: mechanism as LockMechanism });
  } catch (error) {
    if (error instanceof DataDirectoryLockedError) {
      process.stdout.write(`refused ${error.code} ${String(error.owner?.pid ?? 'unknown')}\n`);
      process.exit(3);
    }
    throw error;
  }
  const sourcePng = await pngjsCodec.encode({ width: 2, height: 2, rgba: new Uint8Array(16).fill(255) });
  const t = await handle.manager.create({
    projectId: asProjectId('projet-lock'),
    name: `pid ${process.pid}`,
    sourcePng,
    palette: { id: 'p', colors: [{ rgb: rgb(255, 255, 255) }] },
    placement: { topLeft: { x: 0, y: 0 } },
    coordinateSystem: { yAxis: 'down' },
  });
  process.stdout.write(`acquired ${process.pid} ${t.id} guard=${handle.lock.guard.status}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs ?? 0)));
  await handle.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
