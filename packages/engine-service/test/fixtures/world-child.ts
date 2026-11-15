/**
 * Crash child of the world store tests (Phase 1B.9). argv: <dir> <step>.
 *
 * Opens (or creates) a durable simulated world, then runs a deterministic
 * sequence: write k paints pixel k (row-major) with color k + 1, for the
 * agent, and every 4 writes a checkpoint. After each acknowledged write it
 * prints "acked <k>". It kills itself at the named step `<step>#<n>` (the
 * n-th time the store reaches it): explicit synchronisation, no timer.
 */

import { writeSync } from 'node:fs';
import type { AgentId, AttemptId, ResourceRules, Rgb, TaskId } from '@geoplacer/core';
import { TRANSPARENT } from '@geoplacer/core';
import { SimulatedCanvasProvider } from '@geoplacer/simulator';
import { FileWorldStore, type WorldIdentity, type WorldStoreStep } from '../../src/index.js';

const [dir, step] = process.argv.slice(2);
if (dir === undefined || step === undefined) throw new Error('usage: world-child <dir> <step>');
const [kind, occurrence] = step.split('#');
const target = Number(occurrence);
let seen = 0;
let armed = false;
const onStep = (s: WorldStoreStep): void => {
  if (!armed || s !== kind) return;
  if (++seen === target) {
    writeSync(1, `reached ${step}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
};

const A = 'agent-1' as AgentId;
const colors = Array.from({ length: 64 }, (_, k) => (k + 1) as Rgb);
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'world-child',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 1000, capacityLimit: 1000, regenAmount: 1, regenIntervalMs: 3_600_000_000, aboveCapacity: 'keep' },
  palette: { initialColors: colors, unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};
const identity: WorldIdentity = { bounds: { minX: 0, minY: 0, width: 8, height: 8 }, coordinateSystem: { yAxis: 'down' }, rules: { id: rules.id, version: rules.version } };
let now = 1_000_000;
const clock = { now: () => now };

const opened = await FileWorldStore.open(dir, identity, { onStep });
let store: FileWorldStore;
let canvas: SimulatedCanvasProvider;
const commit = (c: Parameters<FileWorldStore['append']>[0]) => store.append(c);
if (opened.kind === 'fresh') {
  canvas = new SimulatedCanvasProvider({ bounds: identity.bounds, coordinateSystem: identity.coordinateSystem, rules, clock, commit, trackEvents: false });
  store = await canvas.withWorld((view) => FileWorldStore.create(dir, identity, view, { onStep }));
  await canvas.setAgent({ agent: A, energy: 1000, unlockedColors: colors });
} else {
  store = opened.store;
  // The clock of a restarted process never goes back before the saved world.
  now = Math.max(now, ...opened.world.agents.map((a) => a.at)) + 1000;
  canvas = new SimulatedCanvasProvider({ bounds: identity.bounds, coordinateSystem: identity.coordinateSystem, rules, clock, commit, trackEvents: false, initial: opened.world });
}
// Continue after what the world already holds.
let first = 0;
while (first < 64 && canvas.at({ x: first % 8, y: Math.floor(first / 8) }) !== TRANSPARENT) first++;
writeSync(1, `ready ${first}\n`);
armed = true;
for (let k = first; k < 64; k++) {
  now += 1000;
  const result = await canvas.writer.applyPixels(A, [{ taskId: `t${k}` as TaskId, point: { x: k % 8, y: Math.floor(k / 8) }, color: (k + 1) as Rgb }], { attemptId: `a${k}` as AttemptId });
  if (result.outcomes[0]?.status !== 'applied') throw new Error(`write ${k}: ${JSON.stringify(result.outcomes)}`);
  writeSync(1, `acked ${k}\n`);
  if (k % 4 === 3) await canvas.withWorld((view) => store.checkpoint(view));
}
await store.close();
writeSync(1, 'done\n');
