import { describe, expect, it } from 'vitest';
import type { ResourceRules } from '../src/index.js';
import {
  ResourceError,
  capacityOf,
  parseResourceState,
  regenIntervalOf,
  serializeResourceState,
  stateFromObservation,
  validateRules,
  validateState,
} from '../src/index.js';
import { BLUE, GOLD, GREEN, RED, SIMULATED_RULES, observation, rulesWith, type RawRules } from './helpers/resources.js';

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(ResourceError);
  expect((error as ResourceError).code).toBe(code);
}

describe('resource rules', () => {
  it('accepts an explicit, complete rule set and derives capacity and regeneration per level', () => {
    expect(validateRules(SIMULATED_RULES)).toBe(SIMULATED_RULES);
    expect([0, 1, 2, 3].map((maxEnergy) => capacityOf(SIMULATED_RULES, { maxEnergy }))).toEqual([10, 20, 30, 40]);
    // The configured limit wins over the bonuses.
    const limited = rulesWith((r) => (r.energy.capacityLimit = 25));
    expect(capacityOf(limited, { maxEnergy: 3 })).toBe(25);
    expect([0, 1, 2].map((regenSpeed) => regenIntervalOf(SIMULATED_RULES, { regenSpeed }))).toEqual([1000, 800, 500]);
    // Optional sections may be absent: then the upgrade is simply not available.
    expect(validateRules(rulesWith((r) => (r.upgrades = {})))).toBeDefined();
  });

  it('rejects incomplete, invalid or inconsistent rules', () => {
    const cases: Array<[string, (r: RawRules) => void]> = [
      ['schema 2', (r) => (r.schemaVersion = 2)],
      ['unknown field', (r) => (r.extra = 1)],
      ['empty id', (r) => (r.id = '')],
      ['version 0', (r) => (r.version = 0)],
      ['cost 0', (r) => (r.energy.costPerPixel = 0)],
      ['fractional cost', (r) => (r.energy.costPerPixel = 1.5)],
      ['negative capacity', (r) => (r.energy.baseCapacity = -1)],
      ['limit below base', (r) => (r.energy.capacityLimit = 5)],
      ['regen amount 0', (r) => (r.energy.regenAmount = 0)],
      ['regen interval 0', (r) => (r.energy.regenIntervalMs = 0)],
      ['missing regen interval', (r) => delete r.energy.regenIntervalMs],
      ['bad overflow rule', (r) => (r.energy.aboveCapacity = 'drop')],
      ['duplicate initial color', (r) => (r.palette.initialColors = [RED, RED])],
      ['unlockable already initial', (r) => (r.palette.unlockable = [{ color: RED, cost: 1 }])],
      ['negative unlock cost', (r) => (r.palette.unlockable[0].cost = -5)],
      ['color above 24 bits', (r) => (r.palette.initialColors = [0x1000000])],
      ['capacity bonus 0', (r) => (r.upgrades.maxEnergy[0].capacityBonus = 0)],
      ['regen intervals not decreasing', (r) => (r.upgrades.regenSpeed[1].regenIntervalMs = 900)],
      ['regen level slower than base', (r) => (r.upgrades.regenSpeed[0].regenIntervalMs = 1000)],
      ['pack energy 0', (r) => (r.upgrades.energyPack.energy = 0)],
      ['negative spending limit', (r) => (r.currency.maxSpendPerOperation = -1)],
      ['unknown upgrade', (r) => (r.upgrades.turbo = {})],
    ];
    for (const [label, edit] of cases) {
      let error: unknown = null;
      try {
        validateRules(rulesWith(edit));
      } catch (e) {
        error = e;
      }
      expect((error as ResourceError | null)?.code, label).toBe('INVALID_RULES');
    }
  });
});

describe('agent state from an observation', () => {
  it('creates an observed state; an unreported regeneration phase is a pessimistic lower bound', () => {
    const s = stateFromObservation(SIMULATED_RULES, observation());
    expect(s).toEqual({
      schemaVersion: 1,
      kind: 'observed',
      agent: 'agent-1',
      rules: { id: 'test-simulated-scenario', version: 1 },
      at: 1_000_000,
      energy: 4,
      currency: 120,
      unlockedColors: [RED, GREEN].sort((a, b) => a - b),
      upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
      availability: { status: 'available' },
      regenProgressMs: 0,
      regenPhase: 'lower-bound',
      observedAt: 1_000_000,
      operations: [],
    });
    expect(stateFromObservation(SIMULATED_RULES, observation({ regenProgressMs: 600 }))).toMatchObject({ regenProgressMs: 600, regenPhase: 'exact' });
    // At capacity the timer is stopped: phase known (0).
    expect(stateFromObservation(SIMULATED_RULES, observation({ energy: 10 }))).toMatchObject({ regenProgressMs: 0, regenPhase: 'exact' });
    // Above capacity is kept with 'keep' rules (energy packs).
    expect(stateFromObservation(SIMULATED_RULES, observation({ energy: 25 })).energy).toBe(25);
  });

  it('rejects invalid, incomplete or inconsistent observations', () => {
    const bad = [
      observation({ energy: -1 }),
      observation({ energy: 2.5 }),
      observation({ energy: Number.NaN }),
      observation({ currency: -10 }),
      observation({ observedAt: -1 }),
      observation({ unlockedColors: [RED, RED] }),
      observation({ unlockedColors: [0x123456 as never] }),
      observation({ upgrades: { maxEnergy: 4, regenSpeed: 0, energyPacks: 0 } }),
      observation({ upgrades: { maxEnergy: 0, regenSpeed: 3, energyPacks: 0 } }),
      observation({ upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 6 } }),
      observation({ capacity: 12 }),
      observation({ regenProgressMs: 1000 }),
      observation({ availability: { status: 'busy' } as never }),
      { ...observation(), type: 'agent-resource-state' } as never,
      { ...observation(), agent: '' } as never,
    ];
    for (const o of bad) expectCode(() => stateFromObservation(SIMULATED_RULES, o), 'INVALID_OBSERVATION');
    const capped = rulesWith((r) => (r.energy.aboveCapacity = 'cap'));
    expectCode(() => stateFromObservation(capped, observation({ energy: 11 })), 'INVALID_OBSERVATION');
    expect(stateFromObservation(SIMULATED_RULES, observation({ capacity: 20, upgrades: { maxEnergy: 1, regenSpeed: 0, energyPacks: 0 } })).energy).toBe(4);
  });
});

describe('agent state: validation and serialization', () => {
  const state = stateFromObservation(SIMULATED_RULES, observation({ unlockedColors: [BLUE, RED, GREEN] }));

  it('serializes canonically and parses back the same state, of the expected kind only', () => {
    const json = serializeResourceState(state);
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, kind: 'observed', unlockedColors: [BLUE, GREEN, RED] });
    expect(parseResourceState(SIMULATED_RULES, json)).toEqual(state);
    expect(parseResourceState(SIMULATED_RULES, json, 'observed')).toEqual(state);
    expectCode(() => parseResourceState(SIMULATED_RULES, json, 'projected'), 'INVALID_STATE');
    expectCode(() => parseResourceState(SIMULATED_RULES, '{"broken'), 'INVALID_STATE');
    // Same content, same text, whatever the key order of the object.
    const shuffled = Object.fromEntries(Object.entries(state).reverse()) as typeof state;
    expect(serializeResourceState(shuffled)).toBe(json);
  });

  it('refuses a state made for other rules', () => {
    const other: ResourceRules = rulesWith((r) => (r.version = 2));
    expectCode(() => validateState(other, state), 'RULES_MISMATCH');
  });

  it('enforces every invariant', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['negative energy', { energy: -1 }],
      ['negative currency', { currency: -1 }],
      ['observed after at', { observedAt: state.at + 1 }],
      ['unknown kind', { kind: 'guessed' }],
      ['progress beyond interval', { regenProgressMs: 1000 }],
      ['progress while full', { energy: 10, regenProgressMs: 5 }],
      ['bad phase', { regenPhase: 'maybe' }],
      ['unsorted colors', { unlockedColors: [RED, GREEN] }],
      ['color not in rules', { unlockedColors: [0x010101] }],
      ['duplicate operation', { operations: ['op-1', 'op-1'] }],
      ['unknown field', { extra: true }],
      ['schema 2', { schemaVersion: 2 }],
    ];
    for (const [label, patch] of cases) {
      let error: unknown = null;
      try {
        validateState(SIMULATED_RULES, { ...state, ...patch });
      } catch (e) {
        error = e;
      }
      expect((error as ResourceError | null)?.code, label).toBe('INVALID_STATE');
    }
    expect(validateState(SIMULATED_RULES, { ...state, unlockedColors: [GOLD] })).toBeDefined();
  });
});
