import type { UpgradeContext, UpgradeKind, UpgradeProposal, Rgb } from '../contracts/index.js';
import { proposeUpgrades } from './planner.js';
import { capacityOf } from '../resources/rules.js';

export interface UpgradePolicy {
  readonly enabled: Readonly<Record<UpgradeKind, boolean>>;
  readonly priority: readonly UpgradeKind[];
  readonly targetCapacity: number;
  readonly requiredColors: readonly Rgb[];
  readonly maxBudget: number | null;
  readonly minimumReserve: number;
}
export interface PolicyProposal {
  readonly proposal: UpgradeProposal;
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  /** No policy ever grants a real spending capability. */
  readonly confirmationRequired: true;
}

/** Policy over the existing UpgradePlanner: no second energy, cost or benefit model. */
export function evaluateUpgradePolicy(context: UpgradeContext, policy: UpgradePolicy, spent = 0): readonly PolicyProposal[] {
  for (const n of [policy.targetCapacity, policy.maxBudget ?? 0, policy.minimumReserve, spent])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid upgrade budget or target');
  const kinds: readonly UpgradeKind[] = ['energy-pack', 'max-energy', 'regen-speed', 'color-unlock'];
  if (
    new Set(policy.priority).size !== policy.priority.length ||
    policy.priority.some((k) => !kinds.includes(k)) ||
    kinds.some((k) => typeof policy.enabled[k] !== 'boolean')
  )
    throw new Error('invalid upgrade policy');
  const state = context.agents.find((a) => a.id === context.agent)?.state;
  if (state === undefined) throw new Error('agent not observed');
  const capacity = capacityOf(context.parameters.rules, state.upgrades);
  return proposeUpgrades(context)
    .map((proposal): PolicyProposal => {
      const reasons: string[] = [];
      if (!policy.enabled[proposal.kind]) reasons.push('disabled-by-policy');
      if (!proposal.possible) reasons.push('provider-refused');
      if (proposal.cost === null) reasons.push('cost-unavailable');
      else {
        if (policy.maxBudget !== null && proposal.cost > Math.max(0, policy.maxBudget - spent)) reasons.push('budget-exceeded');
        if (state.currency - proposal.cost < policy.minimumReserve) reasons.push('minimum-reserve');
      }
      if (proposal.kind === 'max-energy' && capacity >= policy.targetCapacity) reasons.push('capacity-target-reached');
      if (proposal.kind === 'color-unlock' && (proposal.color == null || !policy.requiredColors.includes(proposal.color)))
        reasons.push('color-not-required');
      return { proposal, allowed: reasons.length === 0, reasons, confirmationRequired: true };
    })
    .sort((a, b) => {
      const priority = (kind: UpgradeKind) => {
        const i = policy.priority.indexOf(kind);
        return i < 0 ? 4 : i;
      };
      return (
        Number(b.allowed) - Number(a.allowed) || priority(a.proposal.kind) - priority(b.proposal.kind) || a.proposal.rank - b.proposal.rank
      );
    });
}
