/**
 * Converts Phase 1B.4 ETA inputs (one energy model per agent) into Phase
 * 1B.5 inputs (one rule set, agents differing by upgrade levels and state).
 * Used by the equivalence test against the frozen 1B.4 estimator and to
 * keep the 1B.4 test cases unchanged. SYNTHETIC rules: test only.
 */

import type { AgentId, EtaAgent, EtaParameters, ResourceRules, Rgb, Timestamp } from '../../src/index.js';
import { stateFromObservation } from '../../src/index.js';
import type { EtaAgent as LegacyAgent, EtaParameters as LegacyParameters } from './eta-1b4-reference.js';

export type { LegacyAgent, LegacyParameters };

export function convertLegacy(
  agents: readonly LegacyAgent[],
  parameters: LegacyParameters,
  now: Timestamp,
  options: { readonly colors?: readonly Rgb[]; readonly regenAmount?: number } = {}
): { readonly agents: EtaAgent[]; readonly parameters: EtaParameters; readonly rules: ResourceRules } {
  const capacities = [...new Set(agents.map((a) => a.maxEnergy))].sort((a, b) => a - b);
  const intervals = [...new Set(agents.map((a) => a.regenIntervalMs))].sort((a, b) => b - a);
  const colors = [...new Set([...(options.colors ?? []), ...agents.flatMap((a) => [...a.unlockedColors])])];
  const rules: ResourceRules = {
    schemaVersion: 1,
    id: 'test-eta-legacy-conversion',
    version: 1,
    energy: {
      costPerPixel: parameters.energyPerPixel,
      baseCapacity: capacities[0] ?? 0,
      regenAmount: options.regenAmount ?? 1,
      regenIntervalMs: intervals[0] ?? 1000,
      aboveCapacity: 'keep',
    },
    palette: { initialColors: colors, unlockable: [] },
    upgrades: {
      maxEnergy: capacities.slice(1).map((c, i) => ({ cost: 0, capacityBonus: c - capacities[i]! })),
      regenSpeed: intervals.slice(1).map((r) => ({ cost: 0, regenIntervalMs: r })),
    },
    currency: {},
  };
  const converted = agents.map(
    (a): EtaAgent => ({
      id: a.id,
      state: stateFromObservation(rules, {
        type: 'resource-observation',
        agent: a.id,
        observedAt: a.observedAt,
        energy: a.energy,
        currency: 0,
        unlockedColors: [...a.unlockedColors],
        upgrades: { maxEnergy: capacities.indexOf(a.maxEnergy), regenSpeed: intervals.indexOf(a.regenIntervalMs), energyPacks: 0 },
        availability: a.availableFrom !== undefined && a.availableFrom > now ? { status: 'unavailable', until: a.availableFrom } : { status: 'available' },
      }),
    })
  );
  // The energy cost per pixel now lives in the rules (costPerPixel above).
  const converted_parameters: EtaParameters = {
    rules,
    msPerPixel: parameters.msPerPixel,
    minCoveragePercent: parameters.minCoveragePercent,
    ...(parameters.pauses === undefined ? {} : { pauses: parameters.pauses }),
  };
  return { agents: converted, parameters: converted_parameters, rules };
}

export const asAgentId = (id: string): AgentId => id as AgentId;
