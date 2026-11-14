/**
 * Energy model: the single implementation of regeneration, used by the
 * ResourceManager and by the ETA estimator.
 *
 * Regeneration: while energy < capacity, +regenAmount every interval. The
 * time accumulated toward the next tick (regenProgressMs) is carried over:
 * advance(advance(s, t1), t2) = advance(s, t2). At or above capacity the
 * timer is stopped (progress 0); it starts again at 0 when energy drops
 * below capacity. Asking twice never regenerates twice: every function is
 * pure and only depends on the state and the requested time.
 *
 * When the phase is a lower bound (not reported by the provider), every
 * prediction is pessimistic: energy never higher, waits never shorter than
 * the reality.
 */

import type { AgentResourceState, ResourceRules, ResourceStateKind, Rgb, Timestamp } from '../contracts/index.js';
import { capacityOf, isRgbValue, regenIntervalOf, ResourceError } from './rules.js';

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function checkTime(at: number, name: string): void {
  if (!isInt(at)) throw new ResourceError('INVALID_OPERATION', `${name} must be a non-negative integer timestamp`);
}

function checkRules(rules: ResourceRules, state: AgentResourceState): void {
  if (state.rules.id !== rules.id || state.rules.version !== rules.version) {
    throw new ResourceError('RULES_MISMATCH', `state made for rules ${state.rules.id} v${state.rules.version}, not ${rules.id} v${rules.version}`);
  }
}

/** Kind of a derived state: a simulation stays simulated; otherwise computed (not after now) or projected. */
export function derivedKind(source: ResourceStateKind, at: Timestamp, now: Timestamp): ResourceStateKind {
  return source === 'simulated' ? 'simulated' : at <= now ? 'computed' : 'projected';
}

/** State regenerated up to `at` (>= state.at). */
export function advance(rules: ResourceRules, state: AgentResourceState, at: Timestamp, now: Timestamp): AgentResourceState {
  checkRules(rules, state);
  checkTime(at, 'at');
  checkTime(now, 'now');
  if (at < state.at) throw new ResourceError('TIME_BEFORE_STATE', `cannot compute a state at ${at}, before its time ${state.at}`);
  const kind = derivedKind(state.kind, at, now);
  const capacity = capacityOf(rules, state.upgrades);
  if (state.energy >= capacity) return { ...state, kind, at, regenProgressMs: 0 };
  const interval = regenIntervalOf(rules, state.upgrades);
  const elapsed = at - state.at + state.regenProgressMs;
  const ticks = Math.floor(elapsed / interval);
  const ticksToFull = Math.ceil((capacity - state.energy) / rules.energy.regenAmount);
  if (ticks >= ticksToFull) return { ...state, kind, at, energy: capacity, regenProgressMs: 0, regenPhase: 'exact' };
  return { ...state, kind, at, energy: state.energy + ticks * rules.energy.regenAmount, regenProgressMs: elapsed - ticks * interval };
}

/**
 * Milliseconds from state.at until `needed` energy is available: 0 if
 * already, null if never by regeneration (more than the capacity). An
 * upper bound when the phase is only a lower bound.
 */
export function timeUntilEnergy(rules: ResourceRules, state: AgentResourceState, needed: number): number | null {
  checkRules(rules, state);
  if (!isInt(needed)) throw new ResourceError('INVALID_OPERATION', 'needed energy must be a non-negative integer');
  if (state.energy >= needed) return 0;
  if (needed > capacityOf(rules, state.upgrades)) return null;
  const interval = regenIntervalOf(rules, state.upgrades);
  const ticks = Math.ceil((needed - state.energy) / rules.energy.regenAmount);
  return ticks * interval - state.regenProgressMs;
}

export interface EnergyCheck {
  /** Energy available now. */
  readonly energy: number;
  readonly needed: number;
  readonly enough: boolean;
  /** Can this much ever be held (capacity, or current energy above it)? */
  readonly everPossible: boolean;
}

/** Capacity check: is `needed` energy available, or ever reachable? */
export function checkEnergy(rules: ResourceRules, state: AgentResourceState, needed: number): EnergyCheck {
  checkRules(rules, state);
  if (!isInt(needed)) throw new ResourceError('INVALID_OPERATION', 'needed energy must be a non-negative integer');
  const enough = state.energy >= needed;
  return { energy: state.energy, needed, enough, everPossible: enough || needed <= capacityOf(rules, state.upgrades) };
}

// ───────────────────────── Operations ─────────────────────────

export type ResourceOperation =
  | { readonly type: 'spend'; readonly id: string; readonly at: Timestamp; readonly energy: number }
  | { readonly type: 'upgrade-max-energy'; readonly id: string; readonly at: Timestamp }
  | { readonly type: 'upgrade-regen-speed'; readonly id: string; readonly at: Timestamp }
  | { readonly type: 'buy-energy-pack'; readonly id: string; readonly at: Timestamp }
  | { readonly type: 'unlock-color'; readonly id: string; readonly at: Timestamp; readonly color: Rgb };

/** The timer only runs below capacity: it stops at or above, and starts at 0 when energy drops below. */
function withTimerRule(rules: ResourceRules, before: AgentResourceState, capacityBefore: number, next: AgentResourceState): AgentResourceState {
  if (next.energy >= capacityOf(rules, next.upgrades)) return { ...next, regenProgressMs: 0, regenPhase: 'exact' };
  if (before.energy >= capacityBefore) return { ...next, regenProgressMs: 0, regenPhase: 'exact' };
  return next;
}

/**
 * Recorded energy consumption without an operation id (the ResourceManager
 * keeps the ids of recorded spends in its ledger): regenerates to `at`, then
 * removes `energy`. With `clamp`, consumes at most what is available
 * (energy never negative) and reports whether it had to; otherwise throws
 * INSUFFICIENT_ENERGY. O(1): no copy of the operation list.
 */
export function consumeEnergy(
  rules: ResourceRules,
  state: AgentResourceState,
  at: Timestamp,
  energy: number,
  now: Timestamp,
  clamp = false
): { readonly state: AgentResourceState; readonly clamped: boolean } {
  if (!isInt(energy, 1)) throw new ResourceError('INVALID_OPERATION', 'spent energy must be a positive integer');
  const before = advance(rules, state, at, now);
  if (energy > before.energy && !clamp) throw new ResourceError('INSUFFICIENT_ENERGY', `needs ${energy}, the agent has ${before.energy}`);
  const used = Math.min(energy, before.energy);
  const next = withTimerRule(rules, before, capacityOf(rules, before.upgrades), { ...before, energy: before.energy - used });
  return { state: next, clamped: used < energy };
}

/** Price of an operation in currency (0 for a spend of energy); throws when not available. */
export function operationCost(rules: ResourceRules, state: AgentResourceState, op: ResourceOperation): number {
  switch (op.type) {
    case 'spend':
      return 0;
    case 'upgrade-max-energy': {
      const level = rules.upgrades.maxEnergy?.[state.upgrades.maxEnergy];
      if (level === undefined) throw new ResourceError('UPGRADE_NOT_AVAILABLE', 'no further capacity level is configured');
      return level.cost;
    }
    case 'upgrade-regen-speed': {
      const level = rules.upgrades.regenSpeed?.[state.upgrades.regenSpeed];
      if (level === undefined) throw new ResourceError('UPGRADE_NOT_AVAILABLE', 'no further regeneration level is configured');
      return level.cost;
    }
    case 'buy-energy-pack': {
      const pack = rules.upgrades.energyPack;
      if (pack === undefined) throw new ResourceError('UPGRADE_NOT_AVAILABLE', 'no energy pack is configured');
      if (pack.maxPurchases !== undefined && state.upgrades.energyPacks >= pack.maxPurchases) {
        throw new ResourceError('UPGRADE_NOT_AVAILABLE', 'maximum number of energy packs reached');
      }
      return pack.cost;
    }
    case 'unlock-color': {
      if (!isRgbValue(op.color)) throw new ResourceError('INVALID_OPERATION', 'color must be a 24-bit RGB value');
      if (state.unlockedColors.includes(op.color)) throw new ResourceError('UPGRADE_NOT_AVAILABLE', `color 0x${op.color.toString(16)} is already unlocked`);
      const entry = rules.palette.unlockable.find((u) => u.color === op.color);
      if (entry === undefined) throw new ResourceError('UPGRADE_NOT_AVAILABLE', `color 0x${op.color.toString(16)} cannot be unlocked under these rules`);
      return entry.cost;
    }
  }
}

/**
 * Applies one operation to a state, after regenerating it up to op.at.
 * `mode`: 'recorded' for a real, accounted spending (the result is computed
 * or projected), 'simulated' for a hypothesis (the result is simulated).
 * Upgrades are always simulated in this phase. An operation id is applied
 * at most once: a repeated id throws DUPLICATE_OPERATION.
 */
export function applyOperation(
  rules: ResourceRules,
  state: AgentResourceState,
  op: ResourceOperation,
  now: Timestamp,
  mode: 'recorded' | 'simulated' = 'simulated'
): AgentResourceState {
  if (typeof op.id !== 'string' || op.id.length === 0) throw new ResourceError('INVALID_OPERATION', 'operation id must be a non-empty string');
  if (state.operations.includes(op.id)) throw new ResourceError('DUPLICATE_OPERATION', `operation ${op.id} was already applied to this state`);
  if (mode === 'recorded' && op.type !== 'spend') throw new ResourceError('INVALID_OPERATION', 'only spending can be recorded; upgrades are simulated in this phase');
  const before = advance(rules, state, op.at, now);
  const capacityBefore = capacityOf(rules, before.upgrades);
  const cost = operationCost(rules, before, op);
  if (cost > before.currency) throw new ResourceError('INSUFFICIENT_CURRENCY', `costs ${cost}, the agent has ${before.currency}`);
  const maxSpend = rules.currency.maxSpendPerOperation;
  if (maxSpend !== undefined && cost > maxSpend) throw new ResourceError('LIMIT_EXCEEDED', `costs ${cost}, above the ${maxSpend} limit per operation`);

  let next: AgentResourceState = { ...before, currency: before.currency - cost, operations: [...before.operations, op.id] };
  switch (op.type) {
    case 'spend': {
      if (!isInt(op.energy, 1)) throw new ResourceError('INVALID_OPERATION', 'spent energy must be a positive integer');
      if (op.energy > before.energy) throw new ResourceError('INSUFFICIENT_ENERGY', `needs ${op.energy}, the agent has ${before.energy}`);
      next = { ...next, energy: before.energy - op.energy };
      break;
    }
    case 'upgrade-max-energy': {
      const upgrades = { ...before.upgrades, maxEnergy: before.upgrades.maxEnergy + 1 };
      if (capacityOf(rules, upgrades) === capacityBefore) throw new ResourceError('LIMIT_EXCEEDED', 'the capacity limit is already reached');
      next = { ...next, upgrades };
      break;
    }
    case 'upgrade-regen-speed': {
      const upgrades = { ...before.upgrades, regenSpeed: before.upgrades.regenSpeed + 1 };
      // No tick is credited at the instant of the change: the progress is kept, below the new interval.
      next = { ...next, upgrades, regenProgressMs: Math.min(before.regenProgressMs, regenIntervalOf(rules, upgrades) - 1) };
      break;
    }
    case 'buy-energy-pack': {
      const energy = before.energy + (rules.upgrades.energyPack?.energy ?? 0);
      next = {
        ...next,
        energy: rules.energy.aboveCapacity === 'cap' ? Math.min(energy, capacityBefore) : energy,
        upgrades: { ...before.upgrades, energyPacks: before.upgrades.energyPacks + 1 },
      };
      break;
    }
    case 'unlock-color':
      next = { ...next, unlockedColors: [...before.unlockedColors, op.color].sort((a, b) => a - b) };
      break;
  }
  const kind: ResourceStateKind = mode === 'simulated' ? 'simulated' : derivedKind(before.kind, op.at, now);
  return { ...withTimerRule(rules, before, capacityBefore, next), kind };
}

// ───────────────────────── Painting capacity (shared with the ETA) ─────────────────────────

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Pixels an agent can finish within `activeMs` of painting time from
 * `state` (energy already regenerated to the start), painting one pixel at
 * a time, at most one every `msPerPixel` (C), each costing the rules'
 * costPerPixel (k). Pessimistic schedule, the one of the ETA:
 * - first B = floor(energy / k) pixels from the current energy: pixel j
 *   (1..B) finishes at j x C;
 * - then the regeneration phase is taken as unknown and the leftover
 *   energy as zero: i more pixels need ceil(i x k / A) ticks of the
 *   interval R, counted from the end of the burst, where A = min(regenAmount,
 *   capacity - k + 1) is the energy a tick surely adds while the agent waits
 *   (energy is capped at the capacity); pixel
 *   j after the burst starts at max over i <= j of (ceil(i k / A) R +
 *   (j - i) C) and finishes C later;
 * - an agent whose capacity is below k never regenerates enough: burst only.
 * With A = 1 this is exactly the Phase 1B.4 bound j x max(C, k R) +
 * min(C, k R). Regeneration during the burst is ignored (pessimistic).
 */
export function paintingCapacity(rules: ResourceRules, state: AgentResourceState, activeMs: number, msPerPixel: number): number {
  checkRules(rules, state);
  const k = rules.energy.costPerPixel;
  const C = msPerPixel;
  const burst = Math.floor(state.energy / k);
  const burstTime = burst * C;
  if (C > 0 && activeMs < burstTime) return Math.floor(activeMs / C);
  const capacity = capacityOf(rules, state.upgrades);
  if (capacity < k) return burst;
  const tau = activeMs - burstTime;
  const R = regenIntervalOf(rules, state.upgrades);
  // Usable energy per tick: energy is capped at the capacity, so an agent
  // waiting with up to k - 1 left gains at least min(A, capacity - k + 1).
  const A = Math.min(rules.energy.regenAmount, capacity - k + 1);
  // f(i) = ceil(i k / A) R - i C is periodic up to a drift: f(i + p) = f(i) + delta.
  const g = gcd(k, A);
  const p = A / g;
  const delta = (k / g) * R - p * C;
  const finish = (j: number): number => {
    let best = -Infinity;
    for (let r = 1; r <= Math.min(p, j); r++) {
      const q = delta >= 0 ? Math.floor((j - r) / p) : 0;
      best = Math.max(best, Math.ceil((r * k) / A) * R - r * C + q * delta);
    }
    return j * C + best + C;
  };
  let lo = 0;
  let hi = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((tau * A) / (k * R)) + 1, C > 0 ? Math.floor(tau / C) + 1 : Number.MAX_SAFE_INTEGER);
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (finish(mid) <= tau) lo = mid;
    else hi = mid - 1;
  }
  return burst + lo;
}
