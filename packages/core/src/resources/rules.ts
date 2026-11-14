/**
 * Resource rules: strict validation and derived values (capacity and
 * regeneration interval for given upgrade levels). No default rule set:
 * every value comes from the configuration (simulated scenarios in V1).
 */

import type { ResourceRules, UpgradeLevels } from '../contracts/index.js';
import { RESOURCE_RULES_SCHEMA_VERSION } from '../contracts/index.js';

export type ResourceErrorCode =
  | 'INVALID_RULES'
  | 'INVALID_STATE'
  | 'INVALID_OBSERVATION'
  /** The state was made for another rule set (id or version). */
  | 'RULES_MISMATCH'
  /** An observation older than the stored one. */
  | 'STALE_OBSERVATION'
  /** A time before the state's time (states never go back in time). */
  | 'TIME_BEFORE_STATE'
  | 'INSUFFICIENT_ENERGY'
  | 'INSUFFICIENT_CURRENCY'
  /** An operation id already applied (with another payload, for recorded spends). */
  | 'DUPLICATE_OPERATION'
  /** A spend older than the last recorded one. */
  | 'OUT_OF_ORDER'
  | 'UNKNOWN_AGENT'
  /** Upgrade not configured, maximum level reached, color not unlockable or already unlocked. */
  | 'UPGRADE_NOT_AVAILABLE'
  /** A configured limit (capacity, spending per operation) would be exceeded. */
  | 'LIMIT_EXCEEDED'
  | 'INVALID_OPERATION';

export class ResourceError extends Error {
  readonly code: ResourceErrorCode;

  constructor(code: ResourceErrorCode, message: string) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
  }
}

type Json = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ResourceError('INVALID_RULES', `${path}: ${message}`);
}

function object(value: unknown, path: string, keys: readonly string[]): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value as Json)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  return value as Json;
}

function int(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(path, `expected an integer >= ${min}`);
  return value;
}

export const isRgbValue = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff;

/** Validates a rule set; returns it unchanged or throws ResourceError('INVALID_RULES'). */
export function validateRules(value: unknown): ResourceRules {
  const r = object(value, 'rules', ['schemaVersion', 'id', 'version', 'energy', 'palette', 'upgrades', 'currency']);
  if (r.schemaVersion !== RESOURCE_RULES_SCHEMA_VERSION) fail('rules.schemaVersion', `expected ${RESOURCE_RULES_SCHEMA_VERSION}`);
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 100) fail('rules.id', 'expected a non-empty string (max 100)');
  int(r.version, 'rules.version', 1);
  const e = object(r.energy, 'rules.energy', ['costPerPixel', 'baseCapacity', 'capacityLimit', 'regenAmount', 'regenIntervalMs', 'aboveCapacity']);
  int(e.costPerPixel, 'rules.energy.costPerPixel', 1);
  const base = int(e.baseCapacity, 'rules.energy.baseCapacity', 0);
  if (e.capacityLimit !== undefined) int(e.capacityLimit, 'rules.energy.capacityLimit', base);
  int(e.regenAmount, 'rules.energy.regenAmount', 1);
  const baseInterval = int(e.regenIntervalMs, 'rules.energy.regenIntervalMs', 1);
  if (e.aboveCapacity !== 'keep' && e.aboveCapacity !== 'cap') fail('rules.energy.aboveCapacity', "expected 'keep' or 'cap'");

  const p = object(r.palette, 'rules.palette', ['initialColors', 'unlockable']);
  if (!Array.isArray(p.initialColors)) fail('rules.palette.initialColors', 'expected an array');
  if (!Array.isArray(p.unlockable)) fail('rules.palette.unlockable', 'expected an array');
  const seen = new Set<number>();
  p.initialColors.forEach((c, i) => {
    if (!isRgbValue(c) || seen.has(c)) fail(`rules.palette.initialColors[${i}]`, 'expected a distinct 24-bit color');
    seen.add(c);
  });
  p.unlockable.forEach((entry, i) => {
    const u = object(entry, `rules.palette.unlockable[${i}]`, ['color', 'cost']);
    if (!isRgbValue(u.color) || seen.has(u.color)) fail(`rules.palette.unlockable[${i}].color`, 'expected a distinct 24-bit color, not an initial one');
    seen.add(u.color);
    int(u.cost, `rules.palette.unlockable[${i}].cost`, 0);
  });

  const u = object(r.upgrades, 'rules.upgrades', ['maxEnergy', 'regenSpeed', 'energyPack']);
  if (u.maxEnergy !== undefined) {
    if (!Array.isArray(u.maxEnergy)) fail('rules.upgrades.maxEnergy', 'expected an array of levels');
    u.maxEnergy.forEach((level, i) => {
      const l = object(level, `rules.upgrades.maxEnergy[${i}]`, ['cost', 'capacityBonus']);
      int(l.cost, `rules.upgrades.maxEnergy[${i}].cost`, 0);
      int(l.capacityBonus, `rules.upgrades.maxEnergy[${i}].capacityBonus`, 1);
    });
  }
  if (u.regenSpeed !== undefined) {
    if (!Array.isArray(u.regenSpeed)) fail('rules.upgrades.regenSpeed', 'expected an array of levels');
    let previous = baseInterval;
    u.regenSpeed.forEach((level, i) => {
      const l = object(level, `rules.upgrades.regenSpeed[${i}]`, ['cost', 'regenIntervalMs']);
      int(l.cost, `rules.upgrades.regenSpeed[${i}].cost`, 0);
      const interval = int(l.regenIntervalMs, `rules.upgrades.regenSpeed[${i}].regenIntervalMs`, 1);
      if (interval >= previous) fail(`rules.upgrades.regenSpeed[${i}].regenIntervalMs`, 'intervals must strictly decrease, from the base interval');
      previous = interval;
    });
  }
  if (u.energyPack !== undefined) {
    const k = object(u.energyPack, 'rules.upgrades.energyPack', ['cost', 'energy', 'maxPurchases']);
    int(k.cost, 'rules.upgrades.energyPack.cost', 0);
    int(k.energy, 'rules.upgrades.energyPack.energy', 1);
    if (k.maxPurchases !== undefined) int(k.maxPurchases, 'rules.upgrades.energyPack.maxPurchases', 0);
  }
  const c = object(r.currency, 'rules.currency', ['maxSpendPerOperation']);
  if (c.maxSpendPerOperation !== undefined) int(c.maxSpendPerOperation, 'rules.currency.maxSpendPerOperation', 0);
  return value as ResourceRules;
}

/** Capacity for the given levels: base + bonuses of the levels bought, within the optional limit. */
export function capacityOf(rules: ResourceRules, levels: Pick<UpgradeLevels, 'maxEnergy'>): number {
  let capacity = rules.energy.baseCapacity;
  const table = rules.upgrades.maxEnergy ?? [];
  for (let i = 0; i < levels.maxEnergy && i < table.length; i++) capacity += table[i]!.capacityBonus;
  return rules.energy.capacityLimit === undefined ? capacity : Math.min(capacity, rules.energy.capacityLimit);
}

/** Regeneration interval for the given levels (the base one at level 0). */
export function regenIntervalOf(rules: ResourceRules, levels: Pick<UpgradeLevels, 'regenSpeed'>): number {
  if (levels.regenSpeed === 0) return rules.energy.regenIntervalMs;
  return rules.upgrades.regenSpeed?.[levels.regenSpeed - 1]?.regenIntervalMs ?? rules.energy.regenIntervalMs;
}

export function unlockableColors(rules: ResourceRules): ReadonlySet<number> {
  return new Set<number>([...rules.palette.initialColors, ...rules.palette.unlockable.map((u) => u.color)]);
}
