import { describe, expect, it } from 'vitest';
import type { AgentId, AgentResourceState, ResourceManager } from '../src/index.js';
import {
  ResourceError,
  advance,
  applyOperation,
  capacityOf,
  checkEnergy,
  createResourceManager,
  stateFromObservation,
  timeUntilEnergy,
  validateState,
} from '../src/index.js';
import { BLUE, GOLD, GREEN, RED, SIMULATED_RULES as R, observation, rulesWith } from './helpers/resources.js';
import { testRandom } from './helpers/strategy.js';

const T0 = 1_000_000;
const A = 'agent-1' as AgentId;

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(ResourceError);
  expect((error as ResourceError).code).toBe(code);
}

const observed = (extra: Parameters<typeof observation>[0] = {}) => stateFromObservation(R, observation(extra));

describe('regeneration', () => {
  it('credits whole ticks only, and keeps the partial progress (no rounding up)', () => {
    const s = observed({ energy: 4, regenProgressMs: 0 });
    expect(advance(R, s, T0 + 999, T0 + 999)).toMatchObject({ energy: 4, regenProgressMs: 999, kind: 'computed' });
    expect(advance(R, s, T0 + 1000, T0)).toMatchObject({ energy: 5, regenProgressMs: 0, kind: 'projected' });
    expect(advance(R, s, T0 + 2500, T0 + 9999)).toMatchObject({ energy: 6, regenProgressMs: 500 });
    // A reported progress counts toward the first tick.
    expect(advance(R, observed({ energy: 4, regenProgressMs: 700 }), T0 + 300, T0).energy).toBe(5);
  });

  it('stops at capacity over a long time, and the timer stays stopped while full', () => {
    const s = observed({ energy: 4 });
    const later = advance(R, s, T0 + 10 ** 9, T0 + 10 ** 9);
    expect(later).toMatchObject({ energy: 10, regenProgressMs: 0, regenPhase: 'exact' });
    expect(advance(R, observed({ energy: 25 }), T0 + 50_000, T0)).toMatchObject({ energy: 25, regenProgressMs: 0 }); // above capacity: kept, no regeneration
  });

  it('never credits regeneration twice: advancing in steps equals advancing at once', () => {
    const pick = testRandom(31);
    for (let k = 0; k < 400; k++) {
      const s = observed({ energy: pick(11), ...(pick(2) === 0 ? { regenProgressMs: pick(1000) } : {}) });
      const t1 = T0 + pick(5000);
      const t2 = t1 + pick(5000);
      const t3 = t2 + pick(20_000);
      const direct = advance(R, s, t3, t3);
      expect(advance(R, advance(R, advance(R, s, t1, t3), t2, t3), t3, t3)).toEqual(direct);
      // Asking again at the same time changes nothing.
      expect(advance(R, direct, t3, t3)).toEqual(direct);
    }
  });

  it('refuses to go back in time, foreign rules and invalid times', () => {
    const s = observed();
    expectCode(() => advance(R, s, T0 - 1, T0), 'TIME_BEFORE_STATE');
    expectCode(() => advance(rulesWith((r) => (r.version = 2)), s, T0, T0), 'RULES_MISMATCH');
    expectCode(() => advance(R, s, Number.NaN, T0), 'INVALID_OPERATION');
    expectCode(() => advance(R, s, T0 + 1.5, T0), 'INVALID_OPERATION');
  });
});

describe('next energy availability and capacity check', () => {
  it('gives the wait for an amount: 0 if available, null if more than the capacity', () => {
    const s = observed({ energy: 4, regenProgressMs: 300 });
    expect(timeUntilEnergy(R, s, 3)).toBe(0);
    expect(timeUntilEnergy(R, s, 5)).toBe(700);
    expect(timeUntilEnergy(R, s, 7)).toBe(2700);
    expect(timeUntilEnergy(R, s, 11)).toBeNull();
    // Unknown phase: the answer is an upper bound (pessimistic).
    expect(timeUntilEnergy(R, observed({ energy: 4 }), 5)).toBe(1000);
    expect(checkEnergy(R, s, 11)).toEqual({ energy: 4, needed: 11, enough: false, everPossible: false });
    expect(checkEnergy(R, observed({ energy: 25 }), 20)).toMatchObject({ enough: true, everPossible: true });
  });

  it('matches advance: after the announced wait, the energy is there, not one ms before (exact phase)', () => {
    const pick = testRandom(8);
    for (let k = 0; k < 200; k++) {
      const s = observed({ energy: pick(10), regenProgressMs: pick(1000) });
      const needed = 1 + pick(10);
      const wait = timeUntilEnergy(R, s, needed)!;
      expect(advance(R, s, T0 + wait, T0).energy).toBeGreaterThanOrEqual(needed);
      if (wait > 0) expect(advance(R, s, T0 + wait - 1, T0).energy).toBeLessThan(needed);
    }
  });
});

describe('operations (spending and simulated upgrades)', () => {
  const s = observed({ energy: 4, currency: 400, regenProgressMs: 250 });
  const op = <T extends object>(o: T) => ({ id: 'op-1', at: T0 + 100, ...o });

  it('spends energy once, never below zero', () => {
    const after = applyOperation(R, s, op({ type: 'spend' as const, energy: 4 }), T0 + 100, 'recorded');
    expect(after).toMatchObject({ energy: 0, kind: 'computed', operations: ['op-1'], regenProgressMs: 350 });
    expectCode(() => applyOperation(R, after, op({ type: 'spend' as const, energy: 1 }), T0 + 100), 'DUPLICATE_OPERATION');
    expectCode(() => applyOperation(R, s, op({ type: 'spend' as const, energy: 5 }), T0), 'INSUFFICIENT_ENERGY');
    expectCode(() => applyOperation(R, s, op({ type: 'spend' as const, energy: 0 }), T0), 'INVALID_OPERATION');
    expectCode(() => applyOperation(R, s, { type: 'upgrade-max-energy', id: 'x', at: T0 }, T0, 'recorded'), 'INVALID_OPERATION');
  });

  it('starts the regeneration timer at 0 when energy drops below capacity', () => {
    const full = observed({ energy: 10 });
    const spent = applyOperation(R, full, op({ type: 'spend' as const, energy: 3 }), T0 + 100);
    expect(spent).toMatchObject({ energy: 7, regenProgressMs: 0, regenPhase: 'exact', kind: 'simulated' });
    expect(advance(R, spent, T0 + 1100, T0).energy).toBe(8);
  });

  it('simulates a capacity upgrade (timer starts if the agent was full)', () => {
    const full = observed({ energy: 10, currency: 400 });
    const up = applyOperation(R, full, op({ type: 'upgrade-max-energy' as const }), T0);
    expect(up).toMatchObject({ kind: 'simulated', currency: 300, upgrades: { maxEnergy: 1 }, energy: 10, regenProgressMs: 0, regenPhase: 'exact' });
    expect(capacityOf(R, up.upgrades)).toBe(20);
    expect(advance(R, up, T0 + 1100, T0).energy).toBe(11);
  });

  it('simulates a faster regeneration without crediting a tick at the change', () => {
    const slow = observed({ energy: 4, currency: 1000, regenProgressMs: 900 });
    const fast = applyOperation(R, slow, { type: 'upgrade-regen-speed', id: 'r1', at: T0 }, T0);
    expect(fast).toMatchObject({ energy: 4, regenProgressMs: 799, upgrades: { regenSpeed: 1 }, currency: 850 });
    expect(advance(R, fast, T0 + 1, T0).energy).toBe(5); // the next tick, not at the change
    const faster = applyOperation(R, fast, { type: 'upgrade-regen-speed', id: 'r2', at: T0 }, T0);
    expect(faster.regenProgressMs).toBe(499);
    expectCode(() => applyOperation(R, faster, { type: 'upgrade-regen-speed', id: 'r3', at: T0 }, T0), 'UPGRADE_NOT_AVAILABLE');
  });

  it('simulates energy packs (kept above capacity, or capped) and color unlocks', () => {
    const pack = applyOperation(R, s, { type: 'buy-energy-pack', id: 'p', at: T0 }, T0);
    expect(pack).toMatchObject({ energy: 19, currency: 370, upgrades: { energyPacks: 1 }, regenProgressMs: 0 });
    const capped = rulesWith((r) => (r.energy.aboveCapacity = 'cap'));
    expect(applyOperation(capped, stateFromObservation(capped, observation({ energy: 4, currency: 400 })), { type: 'buy-energy-pack', id: 'p', at: T0 }, T0).energy).toBe(10);
    const blue = applyOperation(R, s, { type: 'unlock-color', id: 'c', at: T0, color: BLUE }, T0);
    expect(blue).toMatchObject({ unlockedColors: [BLUE, GREEN, RED], currency: 350 });
    expectCode(() => applyOperation(R, blue, { type: 'unlock-color', id: 'c2', at: T0, color: BLUE }, T0), 'UPGRADE_NOT_AVAILABLE');
    expectCode(() => applyOperation(R, s, { type: 'unlock-color', id: 'c3', at: T0, color: 0x010203 as never }, T0), 'UPGRADE_NOT_AVAILABLE');
  });

  it('refuses when currency is insufficient or a limit is exceeded', () => {
    const poor = observed({ currency: 20 });
    expectCode(() => applyOperation(R, poor, { type: 'buy-energy-pack', id: 'p', at: T0 }, T0), 'INSUFFICIENT_CURRENCY');
    expectCode(() => applyOperation(R, observed({ currency: 400 }), { type: 'unlock-color', id: 'g', at: T0, color: GOLD }, T0), 'INSUFFICIENT_CURRENCY');
    const limited = rulesWith((r) => (r.currency.maxSpendPerOperation = 100));
    expectCode(() => applyOperation(limited, stateFromObservation(limited, observation({ currency: 10_000 })), { type: 'unlock-color', id: 'g', at: T0, color: GOLD }, T0), 'LIMIT_EXCEEDED');
    const atLimit = rulesWith((r) => (r.energy.capacityLimit = 10));
    expectCode(() => applyOperation(atLimit, stateFromObservation(atLimit, observation({ currency: 400 })), { type: 'upgrade-max-energy', id: 'm', at: T0 }, T0), 'LIMIT_EXCEEDED');
    const maxed = observed({ currency: 400, upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 5 } });
    expectCode(() => applyOperation(R, maxed, { type: 'buy-energy-pack', id: 'p', at: T0 }, T0), 'UPGRADE_NOT_AVAILABLE');
    expectCode(() => applyOperation(R, observed(), { type: 'spend', id: '', at: T0, energy: 1 }, T0), 'INVALID_OPERATION');
  });
});

describe('ResourceManager', () => {
  const manager = (): ResourceManager => createResourceManager(R);

  it('accepts only observations, never a computed state', () => {
    const m = manager();
    const state = m.observe(observation()).state;
    // @ts-expect-error a computed or projected state is not an observation
    expect(() => m.observe(state)).toThrow(ResourceError);
    expect(m.agents()).toEqual([A]);
    expectCode(() => m.stateAt('other' as AgentId, T0, T0), 'UNKNOWN_AGENT');
  });

  it('keeps observed and computed states apart; repeated queries are identical', () => {
    const m = manager();
    m.observe(observation({ energy: 4 }));
    const a = m.stateAt(A, T0 + 3000, T0 + 3000);
    expect(a).toMatchObject({ kind: 'computed', energy: 7 });
    expect(m.stateAt(A, T0 + 3000, T0 + 3000)).toEqual(a);
    expect(m.stateAt(A, T0 + 9000, T0 + 3000).kind).toBe('projected');
    expect(m.observed(A)).toMatchObject({ kind: 'observed', energy: 4, at: T0 }); // never overwritten by a projection
    expectCode(() => m.stateAt(A, T0 - 1, T0), 'TIME_BEFORE_STATE');
  });

  it('records each spend once, in order, within the available energy', () => {
    const m = manager();
    m.observe(observation({ energy: 4 }));
    const spend = { operationId: 'paint-1', energy: 3, at: T0 + 500 };
    expect(m.recordSpend(A, spend, T0 + 500)).toMatchObject({ status: 'applied', state: { energy: 1 } });
    expect(m.recordSpend(A, spend, T0 + 600)).toMatchObject({ status: 'duplicate', state: { energy: 1 } });
    expectCode(() => m.recordSpend(A, { ...spend, energy: 2 }, T0 + 600), 'DUPLICATE_OPERATION');
    expectCode(() => m.recordSpend(A, { operationId: 'paint-0', energy: 1, at: T0 + 400 }, T0 + 600), 'OUT_OF_ORDER');
    expectCode(() => m.recordSpend(A, { operationId: 'paint-2', energy: 3, at: T0 + 600 }, T0 + 600), 'INSUFFICIENT_ENERGY');
    expect(m.stateAt(A, T0 + 1500, T0 + 1500).energy).toBe(2); // 4 - 3 + 1 tick
    expect(m.recordedSpends(A)).toEqual([{ operationId: 'paint-1', energy: 3, at: T0 + 500 }]); // traceability
    expect(m.timeUntil(A, 4, T0 + 1500)).toBe(1500); // 2 ticks, 500 ms of progress already kept
    expect(m.timeUntil(A, 11, T0 + 1500)).toBeNull();
  });

  it('absorbs spends reflected by a newer observation (reported), and rejects older observations', () => {
    const m = manager();
    m.observe(observation({ energy: 4 }));
    m.recordSpend(A, { operationId: 's1', energy: 2, at: T0 + 100 }, T0 + 100);
    m.recordSpend(A, { operationId: 's2', energy: 1, at: T0 + 900 }, T0 + 900);
    const r = m.observe(observation({ observedAt: T0 + 500, energy: 2 }));
    expect(r.absorbedSpends).toEqual(['s1']);
    expect(r.inconsistentSpends).toEqual([]);
    expect(m.stateAt(A, T0 + 900, T0 + 900).energy).toBe(1); // s2 still applies once
    expect(m.recordSpend(A, { operationId: 's0', energy: 1, at: T0 + 500 }, T0 + 950).status).toBe('absorbed-by-observation');
    expect(m.recordSpend(A, { operationId: 's1', energy: 2, at: T0 + 100 }, T0 + 950).status).toBe('duplicate');
    expectCode(() => m.observe(observation({ observedAt: T0 + 400 })), 'STALE_OBSERVATION');
    expectCode(() => m.observe(observation({ observedAt: T0 + 500, energy: 3 })), 'STALE_OBSERVATION');
    expect(m.observe(observation({ observedAt: T0 + 500, energy: 2 })).state.at).toBe(T0 + 500); // identical: accepted as is
  });

  it('reports recorded spends that a newer observation contradicts, never going negative', () => {
    const m = manager();
    m.observe(observation({ energy: 5 }));
    m.recordSpend(A, { operationId: 's1', energy: 5, at: T0 + 2000 }, T0 + 2000);
    const r = m.observe(observation({ observedAt: T0 + 1000, energy: 0 }));
    expect(r.inconsistentSpends).toEqual(['s1']);
    expect(m.stateAt(A, T0 + 2000, T0 + 2000).energy).toBe(0);
  });

  it('carries the regeneration progress across observations only when they confirm the prediction', () => {
    const m = manager();
    m.observe(observation({ energy: 4, regenProgressMs: 200 }));
    // 500 ms later (less than one interval): energy unchanged as predicted, progress 700 kept.
    const close = m.observe(observation({ observedAt: T0 + 500, energy: 4 }));
    expect(close.regenPhase).toBe('carried-over');
    expect(close.state).toMatchObject({ regenProgressMs: 700, regenPhase: 'exact' });
    expect(m.stateAt(A, T0 + 800, T0 + 800).energy).toBe(5);
    // Unexpected energy: the phase is unknown again (pessimistic lower bound).
    const off = m.observe(observation({ observedAt: T0 + 900, energy: 9 }));
    expect(off.regenPhase).toBe('reset-lower-bound');
    expect(off.state).toMatchObject({ regenProgressMs: 0, regenPhase: 'lower-bound' });
    const reported = m.observe(observation({ observedAt: T0 + 1000, energy: 9, regenProgressMs: 10 }));
    expect(reported.regenPhase).toBe('reported');
  });

  it('keeps the resources of different agents apart', () => {
    const m = manager();
    m.observe(observation({ agent: 'a' as AgentId, energy: 1 }));
    m.observe(observation({ agent: 'b' as AgentId, energy: 9, unlockedColors: [RED] }));
    m.recordSpend('a' as AgentId, { operationId: 'x', energy: 1, at: T0 + 1 }, T0 + 1);
    expect(m.stateAt('b' as AgentId, T0 + 1, T0 + 1)).toMatchObject({ energy: 9, unlockedColors: [RED] });
    expect(m.recordSpend('b' as AgentId, { operationId: 'x', energy: 1, at: T0 + 1 }, T0 + 1).status).toBe('applied'); // ids are per agent
  });
});

describe('resource invariants (properties)', () => {
  it('hold after any sequence of operations and times', () => {
    const pick = testRandom(55);
    for (let run = 0; run < 150; run++) {
      let state: AgentResourceState = observed({ energy: pick(11), currency: pick(1500), ...(pick(2) === 0 ? { regenProgressMs: pick(1000) } : {}) });
      let t = T0;
      for (let step = 0; step < 25; step++) {
        t += pick(4000);
        const id = `op-${run}-${step}`;
        const ops = [
          { type: 'spend' as const, id, at: t, energy: 1 + pick(6) },
          { type: 'upgrade-max-energy' as const, id, at: t },
          { type: 'upgrade-regen-speed' as const, id, at: t },
          { type: 'buy-energy-pack' as const, id, at: t },
          { type: 'unlock-color' as const, id, at: t, color: [BLUE, GOLD, RED][pick(3)]! },
        ];
        try {
          state = applyOperation(R, state, ops[pick(ops.length)]!, t);
        } catch (e) {
          expect(e).toBeInstanceOf(ResourceError); // refused cleanly, state unchanged
        }
        expect(validateState(R, state)).toBe(state);
        expect(state.energy).toBeGreaterThanOrEqual(0);
        expect(state.currency).toBeGreaterThanOrEqual(0);
        expect(new Set(state.operations).size).toBe(state.operations.length);
        const later = advance(R, state, t + pick(10_000), t);
        expect(validateState(R, later)).toBe(later);
        if (state.energy <= capacityOf(R, state.upgrades)) expect(later.energy).toBeLessThanOrEqual(capacityOf(R, state.upgrades));
        expect(later.energy).toBeGreaterThanOrEqual(state.energy);
      }
    }
  });
});

describe('ResourceManager: fast path equals a full replay', () => {
  it('gives the same state at any time as an independent replay of the recorded spends', () => {
    const pick = testRandom(73);
    const strip = (s: AgentResourceState) => ({ ...s, operations: [], kind: 'computed' });
    for (let run = 0; run < 40; run++) {
      const m = createResourceManager(R);
      const first = m.observe(observation({ energy: pick(11), ...(pick(2) === 0 ? { regenProgressMs: pick(1000) } : {}) })).state;
      let reference = first;
      let t = T0;
      const checkpoints: Array<[number, AgentResourceState]> = [];
      for (let k = 0; k < 60; k++) {
        t += 1 + pick(2500);
        const available = advance(R, reference, t, t).energy;
        if (available === 0) continue;
        const energy = 1 + pick(available);
        m.recordSpend(A, { operationId: `s${k}`, energy, at: t }, t);
        reference = applyOperation(R, reference, { type: 'spend', id: `s${k}`, at: t, energy }, t, 'recorded');
        checkpoints.push([t, reference]);
      }
      for (const [at, expected] of checkpoints) expect(strip(m.stateAt(A, at, t))).toEqual(strip(expected)); // before the head: replay
      const later = t + pick(50_000);
      expect(strip(m.stateAt(A, later, later))).toEqual(strip(advance(R, reference, later, later))); // after: head
    }
  });
});
