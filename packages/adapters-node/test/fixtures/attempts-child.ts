/**
 * Child process of the attempt-journal kill test: recovers the journal of
 * the data directory, reconciles what is uncertain, then runs attempt
 * cycles forever (lease, start, finish or fail, some left open) through the
 * real file journal and history, until the parent kills it.
 *
 * Everything is local and simulated: the "canvas" is a Map in this
 * process, the resource rules are synthetic test values (not a real
 * service). argv: <data root> <base time>
 */

import { randomUUID } from 'node:crypto';
import type { AgentId, ProjectId, ResourceRules, Rgb, TaskId, TemplateId } from '@geoplacer/core';
import { createArraySnapshot, createAttemptManager, createResourceManager } from '@geoplacer/core';
import { FileAttemptJournal, FileHistoryStore, acquireDataDirectoryLock } from '../../src/index.js';

const [root, baseArg] = process.argv.slice(2);
if (root === undefined || baseArg === undefined) throw new Error('usage: attempts-child <root> <base time>');
let now = Number(baseArg);
const tick = (): number => ++now;

// SYNTHETIC rules (test only).
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'test-simulated-child',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 1000, capacityLimit: 1000, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [0xff0000 as Rgb], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};
const RED = 0xff0000 as Rgb;
const agent = 'agent-1' as AgentId;
const W = 64;

const lock = await acquireDataDirectoryLock(root);
const journal = new FileAttemptJournal(lock);
const history = new FileHistoryStore(lock);
const resources = createResourceManager(rules);
const manager = createAttemptManager({ journal, history, resources, newAttemptId: () => randomUUID() as never });
const observe = (): void => {
  resources.observe({ type: 'resource-observation', agent, observedAt: tick(), energy: 1000, currency: 0, unlockedColors: [RED], upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
};

async function main(): Promise<void> {
  const report = await manager.recover(tick());
  // Nothing was painted by the children: the canvas is empty (all observed-incorrect).
  const empty = createArraySnapshot({ rect: { minX: 0, minY: 0, width: W, height: W }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: tick(), pixels: new Int32Array(W * W).fill(-1) });
  for (const id of report.toReconcile) await manager.reconcile(id, empty, tick());
  process.stdout.write(`ready ${JSON.stringify(report)}\n`);
  observe();
  for (let i = 0; ; i++) {
    const x = i % W;
    const y = Math.floor(i / W) % W;
    const writes = [{ taskId: `projet/m@1:${x},${y}:#ff0000` as TaskId, point: { x, y }, color: RED }];
    if (manager.inFlight().has(`${x},${y}`)) continue;
    const leased = await manager.lease({ agent, projectId: 'projet' as ProjectId, templateId: 'm' as TemplateId, revision: 1, writes, now: tick(), ttlMs: 1_000_000 });
    if (i % 7 === 3) continue; // left leased
    await manager.start(leased.attemptId, tick());
    if (i % 11 === 5) continue; // left started (result unknown)
    if (i % 5 === 0) await manager.fail(leased.attemptId, 'simulated rejection', [{ taskId: writes[0]!.taskId, status: 'rejected', reason: 'other' }], tick());
    else await manager.finish(leased.attemptId, [{ taskId: writes[0]!.taskId, status: 'already-correct' }], tick());
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
