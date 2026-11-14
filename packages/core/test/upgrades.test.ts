import { describe, expect, it } from 'vitest';
import type { AgentId, ColorProgress, EtaAgent, ProgressSnapshot, Rgb, TemplateId, UpgradeContext, UpgradeProposal } from '../src/index.js';
import {
  ResourceError,
  UpgradeError,
  applyConfirmedUpgrade,
  compareProposals,
  confirmUpgrade,
  createUpgradePlanner,
  proposeUpgrades,
  stateFromObservation,
  validateState,
} from '../src/index.js';
import { BLUE, GOLD, GREEN, RED, SIMULATED_RULES as R, observation, rulesWith } from './helpers/resources.js';
import { testRandom } from './helpers/strategy.js';

const NOW = 1_000_000;
const A = 'agent-1' as AgentId;

function progress(colors: Array<[Rgb, number]>, status: 'fresh' | 'stale' | 'not-evaluated' = 'fresh'): ProgressSnapshot {
  const byColor: ColorProgress[] = colors.map(([color, incorrect]) => ({ color, total: incorrect + 1, correct: 1, incorrect, wrongColor: incorrect, missing: 0, unknown: 0 }));
  const total = byColor.reduce((n, c) => n + c.total, 0);
  const incorrect = byColor.reduce((n, c) => n + c.incorrect, 0);
  return {
    templateId: 'm' as TemplateId,
    revision: 1,
    basis: { source: 'simulated', kind: 'simulation', observedAt: NOW, freshness: { status, ageMs: 5, maxAgeMs: status === 'not-evaluated' ? null : 1 } },
    total,
    correct: total - incorrect,
    incorrect,
    wrongColor: incorrect,
    missing: 0,
    unknown: 0,
    invalidObservations: 0,
    excluded: { transparent: 0, outsideCanvas: 0 },
    conformityPercent: ((total - incorrect) * 100) / total,
    coveragePercent: 100,
    completion: incorrect > 0 ? 'incomplete' : 'complete',
    byColor,
    computedAt: NOW,
  };
}

function context(extra: Partial<UpgradeContext> = {}, obs: Parameters<typeof observation>[0] = {}): UpgradeContext {
  const state = stateFromObservation(R, observation({ observedAt: NOW, energy: 0, currency: 400, regenProgressMs: 0, ...obs }));
  return { agent: A, agents: [{ id: A, state }], progress: progress([[RED, 30]]), parameters: { rules: R, msPerPixel: 0, minCoveragePercent: 0 }, now: NOW, ...extra };
}
const byKind = (ps: readonly UpgradeProposal[], kind: string, color: number | null = null) => ps.find((p) => p.kind === kind && p.color === color)!;

describe('UpgradePlanner: analysis and simulation', () => {
  it('lists every upgrade with its price, effects and ETA before / after, changing nothing', () => {
    const ctx = context();
    const before = JSON.stringify(ctx);
    const ps = proposeUpgrades(ctx);
    expect(JSON.stringify(ctx)).toBe(before);
    expect(ps.map((p) => `${p.kind}${p.color === null ? '' : `:${p.color}`}`).sort()).toEqual(['color-unlock:255', `color-unlock:${GOLD}`, 'energy-pack', 'max-energy', 'regen-speed'].sort());
    const regen = byKind(ps, 'regen-speed');
    expect(regen).toMatchObject({
      possible: true,
      cost: 150,
      effects: { regenIntervalMs: { before: 1000, after: 800 }, currency: { before: 400, after: 250 }, capacity: { before: 10, after: 10 } },
      eta: { before: { durationMs: 30_000 }, after: { durationMs: 24_000 } },
      benefit: 'reduces-eta',
      savedMs: 6000,
      recommended: true,
    });
    expect(regen.simulatedState).toMatchObject({ kind: 'simulated', operations: [regen.id] });
    const pack = byKind(ps, 'energy-pack');
    expect(pack).toMatchObject({ effects: { energy: { before: 0, after: 15 } }, eta: { after: { durationMs: 15_000 } }, savedMs: 15_000 });
    // A larger capacity does not help an agent with no energy painting 30 pixels at 1 per second.
    expect(byKind(ps, 'max-energy')).toMatchObject({ possible: true, benefit: 'no-measurable-benefit', savedMs: 0, recommended: false });
    // A color nobody needs is never recommended just because it can be bought.
    expect(byKind(ps, 'color-unlock', BLUE)).toMatchObject({ possible: true, benefit: 'no-measurable-benefit', recommended: false });
  });

  it('gives an explicit reason when an upgrade is impossible', () => {
    const ps = proposeUpgrades(context({}, { currency: 40 }));
    expect(byKind(ps, 'regen-speed')).toMatchObject({ possible: false, cost: 150, impossible: [{ code: 'INSUFFICIENT_CURRENCY' }], simulatedState: null, recommended: false });
    expect(byKind(ps, 'color-unlock', GOLD).impossible[0]?.code).toBe('INSUFFICIENT_CURRENCY');
    const maxed = proposeUpgrades(context({}, { upgrades: { maxEnergy: 3, regenSpeed: 2, energyPacks: 5 }, currency: 9000 }));
    expect(byKind(maxed, 'max-energy').impossible[0]?.code).toBe('MAX_LEVEL');
    expect(byKind(maxed, 'regen-speed').impossible[0]?.code).toBe('MAX_LEVEL');
    expect(byKind(maxed, 'energy-pack').impossible[0]?.code).toBe('MAX_LEVEL');
    const bare = rulesWith((r) => (r.upgrades = {}));
    const state = stateFromObservation(bare, observation({ observedAt: NOW }));
    const none = proposeUpgrades({ ...context(), agents: [{ id: A, state }], parameters: { rules: bare, msPerPixel: 0, minCoveragePercent: 0 } });
    expect(none.filter((p) => p.kind !== 'color-unlock').map((p) => p.impossible[0]?.code)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
    const limited = rulesWith((r) => (r.energy.capacityLimit = 10));
    const s2 = stateFromObservation(limited, observation({ observedAt: NOW, currency: 400 }));
    expect(byKind(proposeUpgrades({ ...context(), agents: [{ id: A, state: s2 }], parameters: { rules: limited, msPerPixel: 0, minCoveragePercent: 0 } }), 'max-energy').impossible[0]?.code).toBe('LIMIT_EXCEEDED');
  });

  it('ranks a color that makes the estimate possible first, then time saved per unit of currency', () => {
    const ps = proposeUpgrades(context({ progress: progress([[RED, 30], [BLUE, 2]]) }));
    expect(ps[0]).toMatchObject({ kind: 'color-unlock', color: BLUE, benefit: 'enables-estimate', eta: { before: { durationMs: null, unavailable: ['COLORS_UNAVAILABLE'] } }, rank: 1 });
    const ranks = ps.map((p) => p.rank);
    expect(ranks).toEqual(ps.map((_, i) => i + 1));
    // Without the blue work: energy pack (15 000 ms for 30) before regeneration (6 000 ms for 150).
    const order = proposeUpgrades(context()).map((p) => p.kind);
    expect(order.indexOf('energy-pack')).toBeLessThan(order.indexOf('regen-speed'));
  });

  it('marks proposals not evaluable when the snapshot itself prevents any ETA, and carries ETA warnings', () => {
    const stale = proposeUpgrades(context({ progress: progress([[RED, 3]], 'stale') }));
    expect(stale.every((p) => p.benefit === 'not-evaluable' && !p.recommended)).toBe(true);
    const unknownAge = proposeUpgrades(context({ progress: progress([[RED, 3]], 'not-evaluated') }));
    expect(unknownAge[0]?.warnings.map((w) => w.code)).toEqual(['FRESHNESS_NOT_EVALUATED']);
  });

  it('accounts for the other agents (different resources and palettes)', () => {
    const helper = stateFromObservation(R, observation({ agent: 'helper' as AgentId, observedAt: NOW, energy: 10, currency: 0, unlockedColors: [BLUE, RED] }));
    const ctx = context({ progress: progress([[BLUE, 2], [RED, 2]]) });
    const withHelper = proposeUpgrades({ ...ctx, agents: [...ctx.agents, { id: helper.agent, state: helper }] });
    // The helper already paints blue: unlocking blue for agent-1 no longer enables anything.
    expect(byKind(withHelper, 'color-unlock', BLUE).benefit).not.toBe('enables-estimate');
    expect(byKind(proposeUpgrades(ctx), 'color-unlock', BLUE).benefit).toBe('enables-estimate');
  });

  it('is deterministic and refuses an unknown or invalid agent', () => {
    const ctx = context({ progress: progress([[RED, 17], [BLUE, 4]]) });
    expect(proposeUpgrades(ctx)).toEqual(proposeUpgrades(ctx));
    expect(createUpgradePlanner().propose(ctx)).toEqual(proposeUpgrades(ctx));
    expect(() => proposeUpgrades({ ...ctx, agent: 'nobody' as AgentId })).toThrow(UpgradeError);
    const broken: EtaAgent = { id: A, state: { ...ctx.agents[0]!.state, energy: -1 } };
    expect(() => proposeUpgrades({ ...ctx, agents: [broken] })).toThrow(UpgradeError);
  });

  it('compares time saved per currency unit exactly (no float division)', () => {
    const base = proposeUpgrades(context())[0]!;
    const mk = (savedMs: number, cost: number, kind: UpgradeProposal['kind'] = 'regen-speed') => ({ ...base, kind, color: null, possible: true, benefit: 'reduces-eta' as const, savedMs, cost });
    // 2^53 - 1 over 3 vs 2^53 - 2 over 3: equal as floats after division, different exactly.
    const a = mk(Number.MAX_SAFE_INTEGER, 3);
    const b = mk(Number.MAX_SAFE_INTEGER - 1, 3);
    expect(compareProposals(a, b)).toBeLessThan(0);
    expect(compareProposals(b, a)).toBeGreaterThan(0);
    expect(compareProposals(mk(10, 0), mk(1_000_000, 1))).toBeLessThan(0); // free first
    expect(compareProposals(mk(10, 5), mk(10, 5, 'energy-pack'))).toBeLessThan(0); // then the kind order
  });
});

describe('UpgradePlanner: confirmation and application (simulated only)', () => {
  const ctx = context();
  const state = ctx.agents[0]!.state;
  const regen = byKind(proposeUpgrades(ctx), 'regen-speed');
  const confirmation = { proposalId: regen.id, confirmedBy: 'user' as const, confirmedAt: NOW + 5 };

  it('requires an explicit user confirmation of that very proposal', () => {
    expect(() => confirmUpgrade(regen, { ...confirmation, proposalId: 'other' })).toThrow(UpgradeError);
    expect(() => confirmUpgrade(regen, { ...confirmation, confirmedBy: 'scheduler' as never })).toThrow(UpgradeError);
    expect(() => confirmUpgrade(regen, { ...confirmation, confirmedAt: NOW - 1 })).toThrow(UpgradeError);
    const impossible = byKind(proposeUpgrades(context({}, { currency: 0 })), 'regen-speed');
    let error: unknown;
    try {
      confirmUpgrade(impossible, { ...confirmation, proposalId: impossible.id });
    } catch (e) {
      error = e;
    }
    expect((error as UpgradeError).code).toBe('NOT_POSSIBLE');
  });

  it('applies once, to the exact state it was proposed for, as a simulation', () => {
    const confirmed = confirmUpgrade(regen, confirmation);
    const after = applyConfirmedUpgrade(R, state, confirmed, NOW + 5);
    expect(after).toMatchObject({ kind: 'simulated', currency: 250, upgrades: { regenSpeed: 1 }, operations: [regen.id] });
    expect(validateState(R, after)).toBe(after);
    expect(state.kind).toBe('observed'); // the observed state is never modified
    let error: unknown;
    try {
      applyConfirmedUpgrade(R, after, confirmed, NOW + 6);
    } catch (e) {
      error = e;
    }
    expect((error as ResourceError).code).toBe('DUPLICATE_OPERATION');
    const changed = { ...state, currency: 399 };
    try {
      applyConfirmedUpgrade(R, changed, confirmed, NOW + 6);
    } catch (e) {
      error = e;
    }
    expect((error as UpgradeError).code).toBe('STALE_PROPOSAL');
  });
});

describe('UpgradePlanner: properties', () => {
  it('keeps proposals consistent on random agents', () => {
    const pick = testRandom(61);
    for (let k = 0; k < 60; k++) {
      const obs = {
        energy: pick(11),
        currency: pick(800),
        unlockedColors: [RED, GREEN, ...(pick(2) === 0 ? [BLUE] : [])],
        upgrades: { maxEnergy: pick(4), regenSpeed: pick(3), energyPacks: pick(6) },
        ...(pick(2) === 0 ? { regenProgressMs: pick(500) } : {}),
      };
      const ctx = context({ progress: progress([[RED, 1 + pick(40)], ...(pick(2) === 0 ? ([[BLUE, 1 + pick(5)]] as Array<[Rgb, number]>) : [])]) }, obs);
      const ps = proposeUpgrades(ctx);
      for (let i = 1; i < ps.length; i++) expect(compareProposals(ps[i - 1]!, ps[i]!)).toBeLessThanOrEqual(0);
      for (const p of ps) {
        if (p.recommended) expect(p.possible).toBe(true);
        if (p.possible) {
          expect(p.simulatedState?.kind).toBe('simulated');
          expect(p.effects!.currency.after).toBe(p.effects!.currency.before - (p.cost ?? 0));
          expect(p.effects!.currency.after).toBeGreaterThanOrEqual(0);
          expect(validateState(R, p.simulatedState)).toBe(p.simulatedState);
          if (p.eta.after?.durationMs != null && p.eta.before.durationMs !== null) expect(p.eta.after.durationMs).toBeLessThanOrEqual(p.eta.before.durationMs); // upgrades never lengthen the ETA
        } else expect(p.impossible.length).toBe(1);
      }
    }
  });
});
