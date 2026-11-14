/**
 * Phase 1B.5 benchmark: resource computations (SYNTHETIC rules).
 *
 *   npm run bench:resources
 *
 * - advance: one regeneration computation;
 * - stateAt with a ledger of N recorded spends: after the last spend (O(1),
 *   from the ledger head) and at the middle of the ledger (replay, O(N));
 * - upgrade planner: every option of one agent (3 level upgrades + 8
 *   unlockable colors), each with an ETA before / after, 3 agents, 32
 *   colors of work.
 * Median of 7 runs after a warm-up.
 */

import type { AgentId, ColorProgress, ProgressSnapshot, ResourceRules, Rgb, TemplateId } from '../src/index.js';
import { advance, createResourceManager, estimateEta, etaAgentsFrom, proposeUpgrades, stateFromObservation } from '../src/index.js';

const colors = Array.from({ length: 40 }, (_, i) => (((i * 2654435761) >>> 8) & 0xffffff) as Rgb);
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'bench-simulated',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 100, capacityLimit: 400, regenAmount: 1, regenIntervalMs: 30_000, aboveCapacity: 'keep' },
  palette: { initialColors: colors.slice(0, 32), unlockable: colors.slice(32).map((color, i) => ({ color, cost: 100 + i })) },
  upgrades: {
    maxEnergy: [{ cost: 200, capacityBonus: 50 }, { cost: 400, capacityBonus: 100 }],
    regenSpeed: [{ cost: 300, regenIntervalMs: 20_000 }, { cost: 600, regenIntervalMs: 10_000 }],
    energyPack: { cost: 50, energy: 30 },
  },
  currency: {},
};
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
function measure(label: string, fn: () => unknown, extra: Record<string, unknown> = {}): void {
  fn();
  const times: number[] = [];
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  console.log(JSON.stringify({ label, ms: +median(times).toFixed(3), ...extra }));
}

const state = stateFromObservation(rules, {
  type: 'resource-observation',
  agent: 'a0' as AgentId,
  observedAt: 0,
  energy: 10,
  currency: 1000,
  unlockedColors: colors.slice(0, 32),
  upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
  availability: { status: 'available' },
});
measure('advance x 100 000', () => {
  for (let k = 0; k < 100_000; k++) advance(rules, state, 1000 * k, 1000 * k);
});

for (const spends of [10, 1000, 10_000]) {
  const m = createResourceManager(rules);
  m.observe({ type: 'resource-observation', agent: 'a0' as AgentId, observedAt: 0, energy: 100, currency: 0, unlockedColors: colors.slice(0, 32), upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 }, availability: { status: 'available' } });
  for (let k = 1; k <= spends; k++) m.recordSpend('a0' as AgentId, { operationId: `s${k}`, energy: 1, at: k * 30_000 }, k * 30_000);
  measure(`stateAt after ${spends} recorded spends`, () => m.stateAt('a0' as AgentId, spends * 30_000 + 1, spends * 30_000 + 1));
  measure(`stateAt in the middle of ${spends} recorded spends (replay)`, () => m.stateAt('a0' as AgentId, (spends / 2) * 30_000 + 1, spends * 30_000 + 1));
}

const byColor: ColorProgress[] = colors.slice(0, 32).map((color, i) => ({ color, total: 2000 + i, correct: 1000, incorrect: 1000 + i, wrongColor: 1000 + i, missing: 0, unknown: 0 }));
const total = byColor.reduce((n, c) => n + c.total, 0);
const incorrect = byColor.reduce((n, c) => n + c.incorrect, 0);
const progress: ProgressSnapshot = {
  templateId: 'b' as TemplateId,
  revision: 1,
  basis: { source: 'simulated', kind: 'simulation', observedAt: 0, freshness: { status: 'fresh', ageMs: 0, maxAgeMs: 1 } },
  total,
  correct: total - incorrect,
  incorrect,
  wrongColor: incorrect,
  missing: 0,
  unknown: 0,
  invalidObservations: 0,
  excluded: { transparent: 0, outsideCanvas: 0 },
  conformityPercent: ((total - incorrect) * 100) / total,
  coveragePercent: 100,
  completion: 'incomplete',
  byColor,
  computedAt: 0,
};
const manager = createResourceManager(rules);
for (let k = 0; k < 3; k++) {
  manager.observe({ type: 'resource-observation', agent: `a${k}` as AgentId, observedAt: 0, energy: 10 * k, currency: 1000, unlockedColors: colors.slice(0, 32 - 8 * k), upgrades: { maxEnergy: 0, regenSpeed: k, energyPacks: 0 }, availability: { status: 'available' } });
}
const agents = etaAgentsFrom(manager, 1);
const parameters = { rules, msPerPixel: 500, minCoveragePercent: 90 };
measure('ETA, 3 agents, 32 colors', () => estimateEta(progress, agents, parameters, 1));
measure('upgrade planner: every option, each with an ETA before / after', () => proposeUpgrades({ agent: 'a0' as AgentId, agents, progress, parameters, now: 1 }), {
  options: proposeUpgrades({ agent: 'a0' as AgentId, agents, progress, parameters, now: 1 }).length,
});
