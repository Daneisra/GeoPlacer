/**
 * Agent resources and upgrade planning. Layer 1.
 */

import type { AgentId, Rgb, Timestamp } from './primitives.js';

export type UpgradeKind = 'max-energy' | 'regen-speed' | 'energy-pack' | 'color-unlock';

/** Configurable per service; never hard-coded in the engine. */
export interface ResourceModel {
  readonly maxEnergy: number;
  /** Milliseconds to regain one energy point. */
  readonly regenIntervalMs: number;
  readonly upgradeCosts: Readonly<Record<UpgradeKind, number>>;
}

export interface ResourceSnapshot {
  readonly energy: number;
  readonly maxEnergy: number;
  readonly currency: number;
  /** The agent's own palette: the single source of truth for what it can paint. */
  readonly unlockedColors: ReadonlySet<Rgb>;
  readonly observedAt: Timestamp;
}

export interface ResourceManager {
  observe(agent: AgentId, snapshot: ResourceSnapshot): void;
  latest(agent: AgentId): ResourceSnapshot | undefined;
  predictEnergy(agent: AgentId, at: Timestamp): number;
  /** Milliseconds until `energy` points are available (0 when already available). */
  timeUntil(agent: AgentId, energy: number, now: Timestamp): number;
  /** The single place where spending is recorded (no double counting). */
  recordSpend(agent: AgentId, energy: number, at: Timestamp): void;
}

export interface UpgradeProposal {
  readonly agent: AgentId;
  readonly kind: UpgradeKind;
  readonly cost: number;
  readonly rationale: string;
}

/** Only proposes. Any real spending requires an explicit UserConfirmation. */
export interface UpgradePlanner {
  propose(agent: AgentId, snapshot: ResourceSnapshot, model: ResourceModel): readonly UpgradeProposal[];
}

export interface UserConfirmation {
  readonly proposal: UpgradeProposal;
  readonly confirmedBy: 'user';
  readonly confirmedAt: Timestamp;
}
