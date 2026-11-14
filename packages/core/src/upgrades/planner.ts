/**
 * UpgradePlanner: analysis, simulation, confirmation and application of
 * upgrades, all on simulated states (no real purchase in this phase).
 *
 * Ranking (deterministic, total):
 *   1. possible before impossible;
 *   2. benefit: enables-estimate, reduces-eta, no-measurable-benefit,
 *      not-evaluable;
 *   3. enables-estimate: shorter resulting ETA first;
 *      reduces-eta: larger time saved per unit of currency first (exact
 *      comparison by cross-multiplication in BigInt; a free upgrade first),
 *      then larger time saved;
 *   4. lower cost, then kind (max-energy, regen-speed, energy-pack,
 *      color-unlock), then color value.
 */

import type {
  AgentResourceState,
  ConfirmedUpgrade,
  EtaAgent,
  EtaResult,
  EtaSummary,
  ResourceRules,
  Rgb,
  Timestamp,
  UpgradeAnalysis,
  UpgradeBenefit,
  UpgradeContext,
  UpgradeImpossibleCode,
  UpgradeKind,
  UpgradeOption,
  UpgradePlanner,
  UpgradeProposal,
  UserConfirmation,
} from '../contracts/index.js';
import { estimateEta } from '../progress/eta.js';
import { applyOperation, advance, operationCost, type ResourceOperation } from '../resources/energy.js';
import { capacityOf, regenIntervalOf, ResourceError } from '../resources/rules.js';
import { stateFingerprint, validateState } from '../resources/state.js';

export type UpgradeErrorCode =
  /** The agent is not in the context, or its state is invalid. */
  | 'INVALID_CONTEXT'
  /** Confirmation missing, from someone else, for another proposal, or dated before it. */
  | 'NOT_CONFIRMED'
  /** The state changed since the proposal was computed. */
  | 'STALE_PROPOSAL'
  /** The proposal was not possible. */
  | 'NOT_POSSIBLE';

export class UpgradeError extends Error {
  readonly code: UpgradeErrorCode;

  constructor(code: UpgradeErrorCode, message: string) {
    super(message);
    this.name = 'UpgradeError';
    this.code = code;
  }
}

const KIND_ORDER: readonly UpgradeKind[] = ['max-energy', 'regen-speed', 'energy-pack', 'color-unlock'];
const BENEFIT_ORDER: readonly UpgradeBenefit[] = ['enables-estimate', 'reduces-eta', 'no-measurable-benefit', 'not-evaluable'];

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

function proposalId(state: AgentResourceState, option: UpgradeOption): string {
  return `${state.agent}:${option.kind}${option.color === null ? '' : `:${hex(option.color)}`}@${state.at}`;
}

function operationOf(option: UpgradeOption, id: string, at: Timestamp): ResourceOperation {
  switch (option.kind) {
    case 'max-energy':
      return { type: 'upgrade-max-energy', id, at };
    case 'regen-speed':
      return { type: 'upgrade-regen-speed', id, at };
    case 'energy-pack':
      return { type: 'buy-energy-pack', id, at };
    case 'color-unlock':
      return { type: 'unlock-color', id, at, color: option.color as Rgb };
  }
}

/** Every upgrade option of an agent: the three level-based ones, and each unlockable color it lacks. */
export function upgradeOptions(rules: ResourceRules, state: AgentResourceState): UpgradeOption[] {
  const colors = rules.palette.unlockable
    .map((u) => u.color)
    .filter((c) => !state.unlockedColors.includes(c))
    .sort((a, b) => a - b);
  return [
    { kind: 'max-energy', color: null },
    { kind: 'regen-speed', color: null },
    { kind: 'energy-pack', color: null },
    ...colors.map((color): UpgradeOption => ({ kind: 'color-unlock', color })),
  ];
}

function impossibleCode(rules: ResourceRules, option: UpgradeOption, error: ResourceError): UpgradeImpossibleCode {
  if (error.code === 'INSUFFICIENT_CURRENCY') return 'INSUFFICIENT_CURRENCY';
  if (error.code === 'LIMIT_EXCEEDED') return 'LIMIT_EXCEEDED';
  const configured =
    option.kind === 'max-energy'
      ? rules.upgrades.maxEnergy !== undefined && rules.upgrades.maxEnergy.length > 0
      : option.kind === 'regen-speed'
        ? rules.upgrades.regenSpeed !== undefined && rules.upgrades.regenSpeed.length > 0
        : option.kind === 'energy-pack'
          ? rules.upgrades.energyPack !== undefined
          : true;
  if (!configured) return 'NOT_CONFIGURED';
  return option.kind === 'color-unlock' ? 'NOT_UNLOCKABLE' : 'MAX_LEVEL';
}

/** Step 1: analysis of one option for a state at `now` (regenerated first). */
export function analyzeUpgrade(rules: ResourceRules, rawState: AgentResourceState, option: UpgradeOption, now: Timestamp): UpgradeAnalysis {
  const state = advance(rules, rawState, Math.max(now, rawState.at), now);
  const id = proposalId(state, option);
  const op = operationOf(option, id, state.at);
  let cost: number | null = null;
  try {
    cost = operationCost(rules, state, op);
  } catch {
    // price unknown: the option itself is not available
  }
  try {
    const simulated = applyOperation(rules, state, op, now, 'simulated');
    return {
      ...option,
      id,
      agent: state.agent,
      cost,
      possible: true,
      impossible: [],
      effects: {
        capacity: { before: capacityOf(rules, state.upgrades), after: capacityOf(rules, simulated.upgrades) },
        regenIntervalMs: { before: regenIntervalOf(rules, state.upgrades), after: regenIntervalOf(rules, simulated.upgrades) },
        energy: { before: state.energy, after: simulated.energy },
        currency: { before: state.currency, after: simulated.currency },
        unlockedColor: option.kind === 'color-unlock' ? option.color : null,
      },
      simulatedState: simulated,
    };
  } catch (error) {
    if (!(error instanceof ResourceError)) throw error;
    return { ...option, id, agent: state.agent, cost, possible: false, impossible: [{ code: impossibleCode(rules, option, error), message: error.message }], effects: null, simulatedState: null };
  }
}

const summary = (r: EtaResult): EtaSummary => ({ durationMs: r.durationMs, unavailable: r.unavailable.map((u) => u.code) });

function benefitOf(before: EtaSummary, after: EtaSummary | null): { benefit: UpgradeBenefit; savedMs: number | null } {
  // Not simulated (impossible upgrade): its benefit is unknown, not zero.
  if (after === null) return { benefit: 'not-evaluable', savedMs: null };
  if (before.durationMs === null) return { benefit: after.durationMs === null ? 'not-evaluable' : 'enables-estimate', savedMs: null };
  if (after.durationMs === null) return { benefit: 'no-measurable-benefit', savedMs: null };
  const saved = before.durationMs - after.durationMs;
  return { benefit: saved > 0 ? 'reduces-eta' : 'no-measurable-benefit', savedMs: saved };
}

/** Total, deterministic order of proposals (see the module header). */
export function compareProposals(a: Omit<UpgradeProposal, 'rank'>, b: Omit<UpgradeProposal, 'rank'>): number {
  if (a.possible !== b.possible) return a.possible ? -1 : 1;
  const benefit = BENEFIT_ORDER.indexOf(a.benefit) - BENEFIT_ORDER.indexOf(b.benefit);
  if (benefit !== 0) return benefit;
  if (a.benefit === 'enables-estimate') {
    const d = (a.eta.after?.durationMs ?? Infinity) - (b.eta.after?.durationMs ?? Infinity);
    if (d !== 0) return d;
  }
  if (a.benefit === 'reduces-eta') {
    // savedA / costA > savedB / costB  <=>  savedA x costB > savedB x costA (exact, in BigInt).
    const sa = BigInt(a.savedMs ?? 0);
    const sb = BigInt(b.savedMs ?? 0);
    const ca = BigInt(a.cost ?? 0);
    const cb = BigInt(b.cost ?? 0);
    const left = sa * cb;
    const right = sb * ca;
    if (left !== right) return left > right ? -1 : 1;
    if (sa !== sb) return sa > sb ? -1 : 1;
  }
  const cost = (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER);
  if (cost !== 0) return cost;
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kind !== 0) return kind;
  return (a.color ?? -1) - (b.color ?? -1);
}

/** Steps 1 and 2 for every option of the agent: analysis, simulation, ETA before and after, ranking. */
export function proposeUpgrades(context: UpgradeContext): UpgradeProposal[] {
  const { agent, agents, progress, parameters, now } = context;
  const rules = parameters.rules;
  const self = agents.find((a) => a.id === agent);
  if (self === undefined) throw new UpgradeError('INVALID_CONTEXT', `agent ${agent} is not among the agents`);
  try {
    validateState(rules, self.state);
  } catch (error) {
    throw new UpgradeError('INVALID_CONTEXT', `agent ${agent}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const beforeResult = estimateEta(progress, agents, parameters, now);
  const before = summary(beforeResult);
  const basedOn = { state: stateFingerprint(self.state), rules: { id: rules.id, version: rules.version }, computedAt: now };
  const unranked = upgradeOptions(rules, self.state).map((option) => {
    const analysis = analyzeUpgrade(rules, self.state, option, now);
    let after: EtaSummary | null = null;
    if (analysis.simulatedState !== null) {
      const simulatedAgents: EtaAgent[] = agents.map((a) => (a.id === agent ? { id: a.id, state: analysis.simulatedState as AgentResourceState } : a));
      after = summary(estimateEta(progress, simulatedAgents, parameters, now));
    }
    const { benefit, savedMs } = benefitOf(before, after);
    return {
      ...analysis,
      eta: { before, after },
      benefit,
      savedMs,
      recommended: analysis.possible && (benefit === 'enables-estimate' || benefit === 'reduces-eta'),
      warnings: beforeResult.warnings,
      basedOn,
    };
  });
  return unranked.sort(compareProposals).map((p, i) => ({ ...p, rank: i + 1 }));
}

export function createUpgradePlanner(): UpgradePlanner {
  return { propose: proposeUpgrades };
}

/** Step 3: checks that the user confirmed exactly this proposal. */
export function confirmUpgrade(proposal: UpgradeProposal, confirmation: UserConfirmation): ConfirmedUpgrade {
  if (confirmation.confirmedBy !== 'user') throw new UpgradeError('NOT_CONFIRMED', 'only an explicit user confirmation is accepted');
  if (confirmation.proposalId !== proposal.id) throw new UpgradeError('NOT_CONFIRMED', `the confirmation is for ${confirmation.proposalId}, not ${proposal.id}`);
  if (!Number.isSafeInteger(confirmation.confirmedAt) || confirmation.confirmedAt < proposal.basedOn.computedAt) {
    throw new UpgradeError('NOT_CONFIRMED', 'the confirmation must be given after the proposal was computed');
  }
  if (!proposal.possible) throw new UpgradeError('NOT_POSSIBLE', `proposal ${proposal.id} is not possible: ${proposal.impossible.map((i) => i.code).join(', ')}`);
  return { proposal, confirmation };
}

/**
 * Step 4: applies a confirmed upgrade to the SAME state it was proposed for,
 * as a simulation (kind 'simulated'). Refused when the state changed
 * (STALE_PROPOSAL) or when this proposal was already applied
 * (DUPLICATE_OPERATION, its id is recorded in the state's operations).
 */
export function applyConfirmedUpgrade(rules: ResourceRules, state: AgentResourceState, confirmed: ConfirmedUpgrade, now: Timestamp): AgentResourceState {
  const { proposal } = confirmed;
  if (state.operations.includes(proposal.id)) throw new ResourceError('DUPLICATE_OPERATION', `proposal ${proposal.id} was already applied to this state`);
  if (stateFingerprint(state) !== proposal.basedOn.state) {
    throw new UpgradeError('STALE_PROPOSAL', 'the agent state changed since the proposal was computed: propose again');
  }
  if (rules.id !== proposal.basedOn.rules.id || rules.version !== proposal.basedOn.rules.version) throw new UpgradeError('STALE_PROPOSAL', 'the rules changed since the proposal');
  const regenerated = advance(rules, state, Math.max(proposal.basedOn.computedAt, state.at), now);
  return applyOperation(rules, regenerated, operationOf(proposal, proposal.id, regenerated.at), now, 'simulated');
}
