import { describe, it, expect } from 'vitest';
import {
  asTemplateId,
  computeProgress,
  createArraySnapshot,
  evaluateUpgradePolicy,
  stateFromObservation,
  type UpgradeContext,
  type UpgradePolicy,
} from '../src/index.js';
import { RED, BLUE, SIMULATED_RULES as rules, observation } from './helpers/resources.js';

function context(): UpgradeContext {
  const state = stateFromObservation(rules, observation({ currency: 400, energy: 0 }));
  const progress = computeProgress(
    {
      id: asTemplateId('test'),
      revision: 1,
      image: { width: 2, height: 1, pixels: Uint32Array.from([RED, BLUE]) },
      placement: { topLeft: { x: 0, y: 0 } },
      coordinateSystem: { yAxis: 'down' },
    },
    createArraySnapshot({
      rect: { minX: 0, minY: 0, width: 2, height: 1 },
      coordinateSystem: { yAxis: 'down' },
      source: 'geopixels-fixture',
      observedAt: 1_000_000,
      pixels: Int32Array.from([-1, -1]),
    }),
    1_000_000
  );
  return {
    agent: state.agent,
    agents: [{ id: state.agent, state }],
    progress,
    parameters: { rules, msPerPixel: 10, minCoveragePercent: 0 },
    now: 1_000_000,
  };
}
const policy: UpgradePolicy = {
  enabled: { 'energy-pack': true, 'max-energy': true, 'regen-speed': true, 'color-unlock': true },
  priority: ['regen-speed', 'max-energy', 'color-unlock', 'energy-pack'],
  targetCapacity: 20,
  requiredColors: [BLUE],
  maxBudget: 300,
  minimumReserve: 50,
};
describe('Upgrade policy over the existing planner', () => {
  it('retains existing estimates, ranks recovery first and requires confirmation', () => {
    const c = context(),
      before = JSON.stringify(c);
    const p = evaluateUpgradePolicy(c, policy);
    expect(p[0]!.proposal.kind).toBe('regen-speed');
    expect(p.every((p) => p.confirmationRequired)).toBe(true);
    expect(p[0]!.proposal.cost).toBe(150);
    expect(JSON.stringify(c)).toBe(before);
  });
  it.each(['budget', 'reserve', 'disabled', 'target', 'color'])('explains refusal: %s', (which) => {
    const p = { ...policy, enabled: { ...policy.enabled } };
    if (which === 'budget') p.maxBudget = 0;
    if (which === 'reserve') p.minimumReserve = 400;
    if (which === 'disabled') p.enabled['regen-speed'] = false;
    if (which === 'target') p.targetCapacity = 10;
    if (which === 'color') p.requiredColors = [];
    const result = evaluateUpgradePolicy(context(), p);
    const target = result.find(
      (r) => r.proposal.kind === (which === 'target' ? 'max-energy' : which === 'color' ? 'color-unlock' : 'regen-speed')
    )!;
    expect(target.allowed).toBe(false);
    expect(target.reasons.length).toBeGreaterThan(0);
  });
  it('accounts for already spent budget without executing purchases', () => {
    expect(evaluateUpgradePolicy(context(), policy, 300).every((p) => !p.allowed)).toBe(true);
  });
  it.each([-1, NaN, Infinity, 0.5])('rejects invalid budgets %s', (maxBudget) =>
    expect(() => evaluateUpgradePolicy(context(), { ...policy, maxBudget })).toThrow()
  );
});
