/**
 * Upgrade planning. Layer 4 (needs resources and the ETA).
 *
 * Four separate steps: analysis (conditions, price, effects), simulation
 * (resulting state, ETA before and after, ranking), explicit user
 * confirmation, application to a SIMULATED state. No real purchase, no
 * external shop, no automatic spending.
 */

import type { AgentId, Rgb, Timestamp } from './primitives.js';
import type { EtaAgent, EtaParameters, EtaUnavailableCode, EtaWarning, ProgressSnapshot } from './progress.js';
import type { AgentResourceState, UpgradeKind } from './resources.js';

export type UpgradeImpossibleCode =
  /** This upgrade is not configured in the rules. */
  | 'NOT_CONFIGURED'
  /** The last configured level (or number of purchases) is reached. */
  | 'MAX_LEVEL'
  /** The color is not unlockable under these rules. */
  | 'NOT_UNLOCKABLE'
  | 'INSUFFICIENT_CURRENCY'
  /** A configured limit (capacity ceiling, spending per operation) forbids it. */
  | 'LIMIT_EXCEEDED';

export interface UpgradeOption {
  readonly kind: UpgradeKind;
  /** For color-unlock. */
  readonly color: Rgb | null;
}

export interface UpgradeEffects {
  readonly capacity: { readonly before: number; readonly after: number };
  readonly regenIntervalMs: { readonly before: number; readonly after: number };
  readonly energy: { readonly before: number; readonly after: number };
  readonly currency: { readonly before: number; readonly after: number };
  readonly unlockedColor: Rgb | null;
}

/** Step 1: what an upgrade would cost and change, or why it is impossible. */
export interface UpgradeAnalysis extends UpgradeOption {
  /** Deterministic: agent, option and state time. Also the operation id when applied. */
  readonly id: string;
  readonly agent: AgentId;
  /** Price, when known (also for an upgrade the agent cannot afford). */
  readonly cost: number | null;
  readonly possible: boolean;
  readonly impossible: readonly { readonly code: UpgradeImpossibleCode; readonly message: string }[];
  readonly effects: UpgradeEffects | null;
  /** The resulting state (kind 'simulated'), or null when impossible. */
  readonly simulatedState: AgentResourceState | null;
}

export interface EtaSummary {
  readonly durationMs: number | null;
  readonly unavailable: readonly EtaUnavailableCode[];
}

/**
 * enables-estimate: the ETA was unavailable and becomes available (e.g. a
 * missing color); reduces-eta: the ETA gets shorter; no-measurable-benefit:
 * no shorter ETA (an upgrade is never assumed useful because it exists);
 * not-evaluable: not simulated (impossible upgrade), or no ETA before nor
 * after for reasons the upgrade does not touch (stale snapshot, too little
 * observation...).
 */
export type UpgradeBenefit = 'enables-estimate' | 'reduces-eta' | 'no-measurable-benefit' | 'not-evaluable';

/** Step 2: an analysis with its simulated consequences and its rank. */
export interface UpgradeProposal extends UpgradeAnalysis {
  readonly eta: { readonly before: EtaSummary; readonly after: EtaSummary | null };
  readonly benefit: UpgradeBenefit;
  /** before - after, when both exist. */
  readonly savedMs: number | null;
  /** possible and enables-estimate or reduces-eta. */
  readonly recommended: boolean;
  /** 1 = first; deterministic order (see the upgrades module). */
  readonly rank: number;
  /** Warnings of the ETA it is based on (e.g. snapshot freshness not evaluated). */
  readonly warnings: readonly EtaWarning[];
  /** State, rules and time the proposal was computed for: it only applies to that exact state. */
  readonly basedOn: { readonly state: string; readonly rules: { readonly id: string; readonly version: number }; readonly computedAt: Timestamp };
}

export interface UpgradeContext {
  readonly agent: AgentId;
  /** Every agent for the ETA (the analysed one included), states at `now`. */
  readonly agents: readonly EtaAgent[];
  readonly progress: ProgressSnapshot;
  readonly parameters: EtaParameters;
  readonly now: Timestamp;
}

export interface UpgradePlanner {
  /** Analysis + simulation of every upgrade of the agent, ranked. Changes nothing. */
  propose(context: UpgradeContext): readonly UpgradeProposal[];
}

/** Step 3: given by the user, for one proposal. */
export interface UserConfirmation {
  readonly proposalId: string;
  readonly confirmedBy: 'user';
  readonly confirmedAt: Timestamp;
}

/** A proposal checked against its confirmation; the only input of the application step. */
export interface ConfirmedUpgrade {
  readonly proposal: UpgradeProposal;
  readonly confirmation: UserConfirmation;
}
