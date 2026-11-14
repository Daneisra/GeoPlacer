/**
 * SYNTHETIC resource rules for tests and simulated scenarios only. These
 * values are invented; they do not describe GeoPixels, Wplace or any real
 * service, and must never be used as defaults.
 */

import type { AgentId, ResourceObservation, ResourceRules, Rgb } from '../../src/index.js';

export const RED = 0xff0000 as Rgb;
export const GREEN = 0x00ff00 as Rgb;
export const BLUE = 0x0000ff as Rgb;
export const GOLD = 0xffd700 as Rgb;

export const SIMULATED_RULES: ResourceRules = {
  schemaVersion: 1,
  id: 'test-simulated-scenario',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 10, capacityLimit: 40, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED, GREEN], unlockable: [{ color: BLUE, cost: 50 }, { color: GOLD, cost: 500 }] },
  upgrades: {
    maxEnergy: [
      { cost: 100, capacityBonus: 10 },
      { cost: 200, capacityBonus: 10 },
      { cost: 400, capacityBonus: 20 },
    ],
    regenSpeed: [
      { cost: 150, regenIntervalMs: 800 },
      { cost: 300, regenIntervalMs: 500 },
    ],
    energyPack: { cost: 30, energy: 15, maxPurchases: 5 },
  },
  currency: { maxSpendPerOperation: 1000 },
};

/** Free-form copy of the rules, to break them on purpose in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawRules = Record<string, any>;

/** Rules with one field replaced (deep paths by hand in tests). */
export function rulesWith(patch: (r: RawRules) => void): ResourceRules {
  const copy = JSON.parse(JSON.stringify(SIMULATED_RULES)) as RawRules;
  patch(copy);
  return copy as unknown as ResourceRules;
}

export function observation(extra: Partial<ResourceObservation> = {}): ResourceObservation {
  return {
    type: 'resource-observation',
    agent: 'agent-1' as AgentId,
    observedAt: 1_000_000,
    energy: 4,
    currency: 120,
    unlockedColors: [GREEN, RED],
    upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
    availability: { status: 'available' },
    ...extra,
  };
}
