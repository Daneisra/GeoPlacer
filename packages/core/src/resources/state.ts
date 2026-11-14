/**
 * Agent resource states: creation from an observation, validation against
 * the rules, canonical serialization (versioned) and fingerprint.
 */

import type { AgentAvailability, AgentId, AgentResourceState, ResourceObservation, ResourceRules, ResourceStateKind, Rgb, UpgradeLevels } from '../contracts/index.js';
import { RESOURCE_STATE_SCHEMA_VERSION } from '../contracts/index.js';
import { capacityOf, isRgbValue, regenIntervalOf, ResourceError, unlockableColors } from './rules.js';

const KINDS: readonly ResourceStateKind[] = ['observed', 'computed', 'projected', 'simulated'];
const STATE_KEYS = [
  'schemaVersion', 'kind', 'agent', 'rules', 'at', 'energy', 'currency', 'unlockedColors', 'upgrades', 'availability',
  'regenProgressMs', 'regenPhase', 'observedAt', 'operations',
] as const;

type Json = Record<string, unknown>;
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function invalid(code: 'INVALID_STATE' | 'INVALID_OBSERVATION', message: string): never {
  throw new ResourceError(code, message);
}

function checkLevels(rules: ResourceRules, levels: unknown, code: 'INVALID_STATE' | 'INVALID_OBSERVATION'): UpgradeLevels {
  if (levels === null || typeof levels !== 'object') invalid(code, 'upgrades: expected an object');
  const l = levels as Json;
  for (const key of Object.keys(l)) if (!['maxEnergy', 'regenSpeed', 'energyPacks'].includes(key)) invalid(code, `upgrades.${key}: unknown field`);
  if (!isInt(l.maxEnergy) || l.maxEnergy > (rules.upgrades.maxEnergy?.length ?? 0)) invalid(code, 'upgrades.maxEnergy: level outside the configured levels');
  if (!isInt(l.regenSpeed) || l.regenSpeed > (rules.upgrades.regenSpeed?.length ?? 0)) invalid(code, 'upgrades.regenSpeed: level outside the configured levels');
  const maxPacks = rules.upgrades.energyPack === undefined ? 0 : (rules.upgrades.energyPack.maxPurchases ?? Number.MAX_SAFE_INTEGER);
  if (!isInt(l.energyPacks) || l.energyPacks > maxPacks) invalid(code, 'upgrades.energyPacks: outside the configured purchases');
  return { maxEnergy: l.maxEnergy, regenSpeed: l.regenSpeed, energyPacks: l.energyPacks };
}

function checkColors(rules: ResourceRules, colors: unknown, code: 'INVALID_STATE' | 'INVALID_OBSERVATION', sortedRequired: boolean): Rgb[] {
  if (!Array.isArray(colors)) invalid(code, 'unlockedColors: expected an array');
  const known = unlockableColors(rules);
  const out: Rgb[] = [];
  for (const c of colors) {
    if (!isRgbValue(c)) invalid(code, 'unlockedColors: expected 24-bit colors');
    if (!known.has(c)) invalid(code, `unlockedColors: 0x${c.toString(16)} is neither initial nor unlockable in these rules`);
    out.push(c as Rgb);
  }
  const sorted = [...new Set(out)].sort((a, b) => a - b);
  if (sorted.length !== out.length) invalid(code, 'unlockedColors: duplicate color');
  if (sortedRequired && sorted.some((c, i) => c !== out[i])) invalid(code, 'unlockedColors: expected ascending order');
  return sorted;
}

function checkAvailability(value: unknown, code: 'INVALID_STATE' | 'INVALID_OBSERVATION'): AgentAvailability {
  const a = value as Json | null;
  if (a?.status === 'available' && Object.keys(a).length === 1) return { status: 'available' };
  if (a?.status === 'unavailable' && Object.keys(a).length === 2 && (a.until === null || isInt(a.until))) return { status: 'unavailable', until: a.until as number | null };
  invalid(code, "availability: expected { status: 'available' } or { status: 'unavailable', until }");
}

/** Energy, capacity and regeneration consistency shared by observations and states. */
function checkEnergy(rules: ResourceRules, energy: unknown, levels: UpgradeLevels, code: 'INVALID_STATE' | 'INVALID_OBSERVATION'): number {
  if (!isInt(energy)) invalid(code, 'energy: expected a non-negative integer');
  if (rules.energy.aboveCapacity === 'cap' && energy > capacityOf(rules, levels)) invalid(code, 'energy above capacity, not allowed by these rules');
  return energy;
}

/**
 * Observed state from a provider report. Without a reported regeneration
 * progress, the phase is unknown: progress 0 as a lower bound (pessimistic).
 */
export function stateFromObservation(rules: ResourceRules, observation: ResourceObservation): AgentResourceState {
  const o = observation as unknown as Json;
  const code = 'INVALID_OBSERVATION';
  if (o.type !== 'resource-observation') invalid(code, "type: expected 'resource-observation'");
  if (typeof o.agent !== 'string' || o.agent.length === 0) invalid(code, 'agent: expected a non-empty id');
  if (!isInt(o.observedAt)) invalid(code, 'observedAt: expected a non-negative integer timestamp');
  if (!isInt(o.currency)) invalid(code, 'currency: expected a non-negative integer');
  const upgrades = checkLevels(rules, o.upgrades, code);
  const energy = checkEnergy(rules, o.energy, upgrades, code);
  const capacity = capacityOf(rules, upgrades);
  if (o.capacity !== undefined && o.capacity !== capacity) {
    invalid(code, `reported capacity ${String(o.capacity)} differs from ${capacity} expected by the rules and upgrade levels`);
  }
  const interval = regenIntervalOf(rules, upgrades);
  let progress = 0;
  let phase: AgentResourceState['regenPhase'] = 'lower-bound';
  if (energy >= capacity) phase = 'exact';
  else if (o.regenProgressMs !== undefined) {
    if (!isInt(o.regenProgressMs) || o.regenProgressMs >= interval) invalid(code, `regenProgressMs: expected an integer in [0, ${interval})`);
    progress = o.regenProgressMs;
    phase = 'exact';
  }
  return {
    schemaVersion: RESOURCE_STATE_SCHEMA_VERSION,
    kind: 'observed',
    agent: o.agent as AgentId,
    rules: { id: rules.id, version: rules.version },
    at: o.observedAt,
    energy,
    currency: o.currency,
    unlockedColors: checkColors(rules, o.unlockedColors, code, false),
    upgrades,
    availability: checkAvailability(o.availability, code),
    regenProgressMs: progress,
    regenPhase: phase,
    observedAt: o.observedAt,
    operations: [],
  };
}

/** Validates a state for the given rules (all invariants); returns it or throws. */
export function validateState(rules: ResourceRules, value: unknown): AgentResourceState {
  const code = 'INVALID_STATE';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(code, 'expected an object');
  const s = value as Json;
  for (const key of Object.keys(s)) if (!(STATE_KEYS as readonly string[]).includes(key)) invalid(code, `${key}: unknown field`);
  if (s.schemaVersion !== RESOURCE_STATE_SCHEMA_VERSION) invalid(code, `schemaVersion: expected ${RESOURCE_STATE_SCHEMA_VERSION}`);
  if (!KINDS.includes(s.kind as ResourceStateKind)) invalid(code, `kind: expected one of ${KINDS.join(', ')}`);
  if (typeof s.agent !== 'string' || s.agent.length === 0) invalid(code, 'agent: expected a non-empty id');
  const r = s.rules as Json | null;
  if (r?.id !== rules.id || r.version !== rules.version || Object.keys(r).length !== 2) {
    throw new ResourceError('RULES_MISMATCH', `state made for rules ${JSON.stringify(r)}, not ${rules.id} v${rules.version}`);
  }
  if (!isInt(s.at) || !isInt(s.observedAt) || s.observedAt > s.at) invalid(code, 'at / observedAt: integer timestamps with observedAt <= at');
  if (!isInt(s.currency)) invalid(code, 'currency: expected a non-negative integer');
  const upgrades = checkLevels(rules, s.upgrades, code);
  const energy = checkEnergy(rules, s.energy, upgrades, code);
  checkColors(rules, s.unlockedColors, code, true);
  checkAvailability(s.availability, code);
  const interval = regenIntervalOf(rules, upgrades);
  if (!isInt(s.regenProgressMs) || s.regenProgressMs >= interval) invalid(code, `regenProgressMs: expected an integer in [0, ${interval})`);
  if (energy >= capacityOf(rules, upgrades) && s.regenProgressMs !== 0) invalid(code, 'regenProgressMs must be 0 at or above capacity (the timer is stopped)');
  if (s.regenPhase !== 'exact' && s.regenPhase !== 'lower-bound') invalid(code, "regenPhase: expected 'exact' or 'lower-bound'");
  if (!Array.isArray(s.operations) || s.operations.some((op) => typeof op !== 'string' || op.length === 0) || new Set(s.operations).size !== s.operations.length) {
    invalid(code, 'operations: expected distinct non-empty ids');
  }
  return value as AgentResourceState;
}

/** Canonical JSON (fixed key order, colors ascending): equal states give equal strings. */
export function serializeResourceState(state: AgentResourceState): string {
  const ordered: Json = {};
  for (const key of STATE_KEYS) ordered[key] = state[key];
  ordered.rules = { id: state.rules.id, version: state.rules.version };
  ordered.upgrades = { maxEnergy: state.upgrades.maxEnergy, regenSpeed: state.upgrades.regenSpeed, energyPacks: state.upgrades.energyPacks };
  ordered.availability = state.availability.status === 'available' ? { status: 'available' } : { status: 'unavailable', until: state.availability.until };
  return JSON.stringify(ordered);
}

/** Parses and validates a serialized state; with `kind`, refuses any other kind. */
export function parseResourceState(rules: ResourceRules, json: string, kind?: ResourceStateKind): AgentResourceState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ResourceError('INVALID_STATE', 'not valid JSON');
  }
  const state = validateState(rules, value);
  if (kind !== undefined && state.kind !== kind) throw new ResourceError('INVALID_STATE', `expected a ${kind} state, got ${state.kind}`);
  return state;
}

/** Identity of a state's content (used to check that a proposal still applies to it). */
export const stateFingerprint = (state: AgentResourceState): string => serializeResourceState(state);
