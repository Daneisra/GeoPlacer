/**
 * Agent resources: provider rules and per-agent state. Layer 1.
 *
 * Phase 1B.5 (contracts v5): the rules of a provider are an explicit,
 * versioned, validated document (never values hard-coded from a real
 * service); each agent has its own serializable state, whose `kind` says
 * whether it was observed, computed, projected or simulated. The
 * ResourceManager is the single source of truth for energy predictions
 * (the ETA estimator uses them).
 */

import type { AgentId, Rgb, Timestamp } from './primitives.js';

export const RESOURCE_RULES_SCHEMA_VERSION = 1;
export const RESOURCE_STATE_SCHEMA_VERSION = 1;

export type UpgradeKind = 'max-energy' | 'regen-speed' | 'energy-pack' | 'color-unlock';

/** One level of the capacity upgrade: price, and capacity added by this level. */
export interface CapacityUpgradeLevel {
  readonly cost: number;
  readonly capacityBonus: number;
}

/** One level of the regeneration upgrade: price, and regeneration interval from this level on. */
export interface RegenUpgradeLevel {
  readonly cost: number;
  readonly regenIntervalMs: number;
}

export interface UnlockableColor {
  readonly color: Rgb;
  readonly cost: number;
}

/**
 * Rules of one provider (a simulated scenario in V1). Every value is given
 * explicitly by whoever configures the provider; nothing is assumed.
 */
export interface ResourceRules {
  readonly schemaVersion: 1;
  /** Identifier and version of this rule set; a state is only valid for its own rules. */
  readonly id: string;
  readonly version: number;
  readonly energy: {
    /** Energy spent per painted pixel. */
    readonly costPerPixel: number;
    /** Capacity without upgrades. */
    readonly baseCapacity: number;
    /** Optional ceiling of the capacity, upgrades included. */
    readonly capacityLimit?: number;
    /** Regeneration: +regenAmount every regenIntervalMs while energy < capacity. */
    readonly regenAmount: number;
    readonly regenIntervalMs: number;
    /**
     * Energy above capacity (energy packs): 'keep' it (no regeneration until
     * below capacity again) or 'cap' it at the capacity.
     */
    readonly aboveCapacity: 'keep' | 'cap';
  };
  readonly palette: {
    /** Colors every agent starts with. */
    readonly initialColors: readonly Rgb[];
    /** Colors that can be unlocked, with their price. */
    readonly unlockable: readonly UnlockableColor[];
  };
  readonly upgrades: {
    /** Successive levels (level n = the first n entries). Absent: not available. */
    readonly maxEnergy?: readonly CapacityUpgradeLevel[];
    /** Successive levels; intervals strictly decreasing and below the base interval. */
    readonly regenSpeed?: readonly RegenUpgradeLevel[];
    readonly energyPack?: { readonly cost: number; readonly energy: number; readonly maxPurchases?: number };
  };
  readonly currency: {
    /** Optional ceiling of one spending operation. */
    readonly maxSpendPerOperation?: number;
  };
}

export interface UpgradeLevels {
  readonly maxEnergy: number;
  readonly regenSpeed: number;
  readonly energyPacks: number;
}

export type AgentAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly until: Timestamp | null };

/**
 * What a provider (or the user) reports about an agent at observedAt. The
 * only input accepted by ResourceManager.observe: a computed or projected
 * state can never be passed as an observation.
 */
export interface ResourceObservation {
  readonly type: 'resource-observation';
  readonly agent: AgentId;
  readonly observedAt: Timestamp;
  readonly energy: number;
  readonly currency: number;
  readonly unlockedColors: readonly Rgb[];
  readonly upgrades: UpgradeLevels;
  readonly availability: AgentAvailability;
  /** Reported capacity, checked against the rules and levels when given. */
  readonly capacity?: number;
  /** Time accumulated toward the next regeneration tick, when the provider reports it. */
  readonly regenProgressMs?: number;
}

/**
 * observed: as reported; computed: derived for a time not after `now`
 * (regeneration, recorded spending); projected: derived for a future time;
 * simulated: the result of a hypothetical operation (never a real one).
 */
export type ResourceStateKind = 'observed' | 'computed' | 'projected' | 'simulated';

export interface AgentResourceState {
  readonly schemaVersion: 1;
  readonly kind: ResourceStateKind;
  readonly agent: AgentId;
  readonly rules: { readonly id: string; readonly version: number };
  /** Time the values refer to. */
  readonly at: Timestamp;
  readonly energy: number;
  readonly currency: number;
  /** Ascending, without duplicates. */
  readonly unlockedColors: readonly Rgb[];
  readonly upgrades: UpgradeLevels;
  readonly availability: AgentAvailability;
  /**
   * Time accumulated toward the next regeneration tick, in [0, interval).
   * 0 when energy is at or above capacity (the timer only runs below it).
   */
  readonly regenProgressMs: number;
  /**
   * exact: known; lower-bound: the real progress may be larger (phase not
   * reported): predictions are then pessimistic, never optimistic.
   */
  readonly regenPhase: 'exact' | 'lower-bound';
  /** Observation this state derives from. */
  readonly observedAt: Timestamp;
  /**
   * Ids of the operations applied to this state with applyOperation
   * (simulated upgrades and spends), in order; an id appears once. Spends
   * recorded through the ResourceManager are traced in its ledger instead
   * (ResourceManager.recordedSpends), not here.
   */
  readonly operations: readonly string[];
}

/** A recorded spending (painting): consumes energy once, identified by its id. */
export interface SpendRecord {
  readonly operationId: string;
  readonly energy: number;
  readonly at: Timestamp;
}

export type SpendStatus =
  /** Applied to the agent's ledger. */
  | 'applied'
  /** Same id and payload already recorded: not applied again. */
  | 'duplicate'
  /** At or before the latest observation: already reflected by it, not applied. */
  | 'absorbed-by-observation';

export interface SpendResult {
  readonly status: SpendStatus;
  readonly state: AgentResourceState;
}

export interface ObservationResult {
  readonly state: AgentResourceState;
  /** Recorded spends at or before observedAt, now considered included in the observation. */
  readonly absorbedSpends: readonly string[];
  /** Recorded spends after observedAt that the observation contradicts (not enough energy): they consume only what is available. */
  readonly inconsistentSpends: readonly string[];
  /** Whether the regeneration progress was carried over from the previous state, reported, or reset. */
  readonly regenPhase: 'reported' | 'carried-over' | 'reset-lower-bound';
}

/**
 * Single source of truth for the resources of the agents (one rule set).
 * Pure with respect to time: every time is a parameter; no Date.now().
 */
export interface ResourceManager {
  readonly rules: ResourceRules;
  /** Rejects an observation older than the stored one (never silently ignored). */
  observe(observation: ResourceObservation): ObservationResult;
  /** Latest observed state (unchanged by spending or projections). */
  observed(agent: AgentId): AgentResourceState | undefined;
  /** Observation + recorded spends up to `at`, regenerated to `at`: 'computed' when at <= now, 'projected' otherwise. */
  stateAt(agent: AgentId, at: Timestamp, now: Timestamp): AgentResourceState;
  /** Records a spending once; see SpendStatus. */
  recordSpend(agent: AgentId, spend: SpendRecord, now: Timestamp): SpendResult;
  /** Milliseconds from `now` until `energy` is available (0 if already), or null if never. */
  timeUntil(agent: AgentId, energy: number, now: Timestamp): number | null;
  /** Spends recorded after the latest observation, in order (traceability of the computed states). */
  recordedSpends(agent: AgentId): readonly SpendRecord[];
  agents(): readonly AgentId[];
}
