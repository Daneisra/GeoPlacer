import { describe, expect, it } from 'vitest';
import type { AgentId, AgentResourceState, ColorProgress, ProgressSnapshot, Rgb, TemplateId } from '../src/index.js';
import {
  ETA_ASSUMPTIONS,
  advance,
  applyOperation,
  createResourceManager,
  estimateEta as estimateEtaV5,
  etaAgentsFrom,
  stateFromObservation,
} from '../src/index.js';
import { estimateEta1b4 } from './helpers/eta-1b4-reference.js';
import { convertLegacy, type LegacyAgent as EtaAgent, type LegacyParameters as EtaParameters } from './helpers/eta-legacy.js';
import { SIMULATED_RULES, observation } from './helpers/resources.js';
import { testRandom } from './helpers/strategy.js';

/**
 * The 1B.4 cases are kept as written: agents with their own energy model,
 * converted to one rule set + per-agent upgrade levels (helpers/eta-legacy).
 */
function estimateEta(p: ProgressSnapshot, agents: readonly EtaAgent[], parameters: EtaParameters, now: number, regenAmount = 1) {
  const c = convertLegacy(agents, parameters, now, { colors: [RED, BLUE], regenAmount });
  return estimateEtaV5(p, c.agents, c.parameters, now);
}

const RED = 0xff0000 as Rgb;
const BLUE = 0x0000ff as Rgb;
const NOW = 1_000_000;

/** Progress with, per color, [correct, incorrect, unknown]. */
function progress(colors: Array<[Rgb, number, number, number]>, freshness: ProgressSnapshot['basis']['freshness'] = { status: 'not-evaluated', ageMs: 0, maxAgeMs: null }): ProgressSnapshot {
  const byColor: ColorProgress[] = colors.map(([color, correct, incorrect, unknown]) => ({
    color,
    total: correct + incorrect + unknown,
    correct,
    incorrect,
    wrongColor: incorrect,
    missing: 0,
    unknown,
  }));
  const sum = (k: 'total' | 'correct' | 'incorrect' | 'unknown') => byColor.reduce((n, c) => n + c[k], 0);
  const total = sum('total');
  return {
    templateId: 'm' as TemplateId,
    revision: 1,
    basis: { source: 'simulated', kind: 'simulation', observedAt: NOW, freshness },
    total,
    correct: sum('correct'),
    incorrect: sum('incorrect'),
    wrongColor: sum('incorrect'),
    missing: 0,
    unknown: sum('unknown'),
    invalidObservations: 0,
    excluded: { transparent: 0, outsideCanvas: 0 },
    conformityPercent: total === 0 ? null : (sum('correct') * 100) / total,
    coveragePercent: total === 0 ? null : ((sum('correct') + sum('incorrect')) * 100) / total,
    completion: total === 0 ? 'no-eligible-pixels' : sum('incorrect') > 0 ? 'incomplete' : sum('unknown') > 0 ? 'undetermined' : 'complete',
    byColor,
    computedAt: NOW,
  };
}

function agent(id: string, extra: Partial<EtaAgent> = {}): EtaAgent {
  return { id: id as AgentId, energy: 0, maxEnergy: 10, regenIntervalMs: 1000, observedAt: NOW, unlockedColors: new Set([RED, BLUE]), ...extra };
}

const params: EtaParameters = { energyPerPixel: 1, msPerPixel: 0, minCoveragePercent: 0 };
const codes = (r: ReturnType<typeof estimateEta>) => r.unavailable.map((u) => u.code);

describe('EtaEstimator: availability', () => {
  it('is 0 for a fully observed, fully correct template, even without any agent', () => {
    const r = estimateEta(progress([[RED, 10, 0, 0]]), [], params, NOW);
    expect(r).toMatchObject({ durationMs: 0, finishAt: NOW, unavailable: [], workPixels: 0, kind: 'theoretical-estimate' });
    expect(estimateEta(progress([]), [], params, NOW).durationMs).toBe(0); // nothing eligible
  });

  it('is null with NO_AGENT when work remains and nobody can paint', () => {
    const r = estimateEta(progress([[RED, 0, 5, 0]]), [], params, NOW);
    expect(r).toMatchObject({ durationMs: null, finishAt: null, workPixels: 5 });
    expect(codes(r)).toEqual(['NO_AGENT']);
  });

  it('is null with COLORS_UNAVAILABLE, listing only colors that still have work', () => {
    const onlyRed = agent('a', { unlockedColors: new Set([RED]) });
    expect(estimateEta(progress([[RED, 0, 3, 0], [BLUE, 4, 0, 0]]), [onlyRed], params, NOW).durationMs).not.toBeNull(); // blue is done
    const r = estimateEta(progress([[RED, 0, 3, 0], [BLUE, 0, 1, 0]]), [onlyRed], params, NOW);
    expect(r.unavailable).toEqual([{ code: 'COLORS_UNAVAILABLE', message: expect.any(String) as string, colors: [BLUE] }]);
  });

  it('is null with INSUFFICIENT_ENERGY when no agent can ever pay for one pixel', () => {
    const r = estimateEta(progress([[RED, 0, 3, 0]]), [agent('a', { maxEnergy: 1, energy: 0 })], { ...params, energyPerPixel: 2 }, NOW);
    expect(codes(r)).toEqual(['INSUFFICIENT_ENERGY']);
    // Energy above its cap (one-off), but no regeneration up to 2: 1 pixel possible, 3 needed.
    const capped = estimateEta(progress([[RED, 0, 3, 0]]), [agent('a', { maxEnergy: 1, energy: 2 })], { ...params, energyPerPixel: 2 }, NOW);
    expect(codes(capped)).toEqual(['INSUFFICIENT_ENERGY']);
  });

  it('blames energy, not the time range, when the only agent with a color can never regenerate it', () => {
    // a regenerates but lacks BLUE; b has BLUE but max energy 1 < 2 per pixel, energy 2 now: one blue pixel at most.
    const a = agent('a', { unlockedColors: new Set([RED]), energy: 0 });
    const b = agent('b', { unlockedColors: new Set([BLUE]), energy: 2, maxEnergy: 1 });
    const r = estimateEta(progress([[RED, 0, 3, 0], [BLUE, 0, 2, 0]]), [a, b], { ...params, energyPerPixel: 2 }, NOW);
    expect(codes(r)).toEqual(['INSUFFICIENT_ENERGY']);
    expect(r.unavailable[0]?.colors).toEqual([BLUE]);
    // With a single blue pixel to paint, b's one-off energy is enough.
    expect(estimateEta(progress([[RED, 0, 3, 0], [BLUE, 0, 1, 0]]), [a, b], { ...params, energyPerPixel: 2 }, NOW).durationMs).not.toBeNull();
  });

  it('is null when the observation is too incomplete or stale, never replaced by a value', () => {
    const half = progress([[RED, 4, 1, 5]]); // coverage 50 %
    expect(codes(estimateEta(half, [agent('a')], { ...params, minCoveragePercent: 60 }, NOW))).toEqual(['INSUFFICIENT_OBSERVATION']);
    expect(estimateEta(half, [agent('a')], { ...params, minCoveragePercent: 50 }, NOW).durationMs).not.toBeNull();
    const stale = progress([[RED, 0, 1, 0]], { status: 'stale', ageMs: 9000, maxAgeMs: 1000 });
    expect(codes(estimateEta(stale, [agent('a')], params, NOW))).toEqual(['STALE_SNAPSHOT']);
    const future = progress([[RED, 0, 1, 0]], { status: 'future', ageMs: -5, maxAgeMs: null });
    expect(codes(estimateEta(future, [agent('a')], params, NOW))).toEqual(['INVALID_PARAMETERS']);
  });

  it('reports every invalid parameter, rule or resource state instead of guessing', () => {
    const p = progress([[RED, 0, 2, 0]]);
    const c = convertLegacy([agent('a')], params, NOW, { colors: [RED, BLUE] });
    const state = c.agents[0]!.state;
    const run = (agents: typeof c.agents, parameters = c.parameters, now = NOW) => codes(estimateEtaV5(p, agents, parameters, now));
    const badStates: Array<Record<string, unknown>> = [{ energy: -1 }, { energy: Number.NaN }, { currency: -3 }, { regenProgressMs: 5000 }, { kind: 'guessed' }, { unlockedColors: [RED, BLUE] }];
    for (const patch of badStates) expect(run([{ id: state.agent, state: { ...state, ...patch } as AgentResourceState }]), JSON.stringify(patch)).toEqual(['INVALID_PARAMETERS']);
    expect(run([{ id: 'other' as AgentId, state }])).toEqual(['INVALID_PARAMETERS']); // the state of another agent
    expect(run([{ id: state.agent, state: { ...state, at: NOW + 1, observedAt: NOW + 1 } }])).toEqual(['INVALID_PARAMETERS']); // dated after now
    expect(run([{ id: state.agent, state }, { id: state.agent, state }])).toEqual(['INVALID_PARAMETERS']);
    expect(run(c.agents, { ...c.parameters, rules: { ...c.rules, version: 0 } })).toContain('INVALID_PARAMETERS');
    expect(run(c.agents, { ...c.parameters, rules: { ...c.rules, version: 2 } })).toEqual(['INVALID_PARAMETERS']); // states made for other rules
    expect(run(c.agents, { ...c.parameters, msPerPixel: -1 })).toEqual(['INVALID_PARAMETERS']);
    expect(run(c.agents, { ...c.parameters, minCoveragePercent: 101 })).toEqual(['INVALID_PARAMETERS', 'INSUFFICIENT_OBSERVATION']);
    expect(run(c.agents, { ...c.parameters, minCoveragePercent: Number.NaN })).toEqual(['INVALID_PARAMETERS']);
    expect(run(c.agents, { ...c.parameters, pauses: [{ start: 10, end: 10 }] })).toEqual(['INVALID_PARAMETERS']);
    expect(run(c.agents, c.parameters, -1)).toContain('INVALID_PARAMETERS');
  });

  it('treats an agent unavailable without end as absent, and one with an end as starting then', () => {
    const p = progress([[RED, 0, 1, 0]]);
    const c = convertLegacy([agent('a', { energy: 5 })], params, NOW, { colors: [RED, BLUE] });
    const s = c.agents[0]!.state;
    expect(codes(estimateEtaV5(p, [{ id: s.agent, state: { ...s, availability: { status: 'unavailable', until: null } } }], c.parameters, NOW))).toEqual(['NO_AGENT']);
    expect(estimateEtaV5(p, [{ id: s.agent, state: { ...s, availability: { status: 'unavailable', until: NOW + 700 } } }], c.parameters, NOW).durationMs).toBe(700);
  });

  it('warns when the snapshot freshness was not evaluated, or the resources are simulated', () => {
    const c = convertLegacy([agent('a', { energy: 5 })], params, NOW, { colors: [RED, BLUE] });
    const r = estimateEtaV5(progress([[RED, 0, 1, 0]]), c.agents, c.parameters, NOW);
    expect(r.durationMs).toBe(0);
    expect(r.warnings.map((w) => w.code)).toEqual(['FRESHNESS_NOT_EVALUATED']);
    const fresh = progress([[RED, 0, 1, 0]], { status: 'fresh', ageMs: 10, maxAgeMs: 100 });
    expect(estimateEtaV5(fresh, c.agents, c.parameters, NOW).warnings).toEqual([]);
    const simulated = [{ ...c.agents[0]!, state: { ...c.agents[0]!.state, kind: 'simulated' as const } }];
    expect(estimateEtaV5(fresh, simulated, c.parameters, NOW).warnings.map((w) => w.code)).toEqual(['SIMULATED_RESOURCES']);
  });

  it('is null with OUT_OF_RANGE beyond the safe millisecond range', () => {
    const r = estimateEta(progress([[RED, 0, 5, 0]]), [agent('a', { regenIntervalMs: 2 ** 51 })], params, NOW);
    expect(codes(r)).toEqual(['OUT_OF_RANGE']);
  });
});

describe('EtaEstimator: values', () => {
  it('counts unknown pixels as work and explains its assumptions', () => {
    const r = estimateEta(progress([[RED, 2, 1, 3]]), [agent('a', { energy: 10 })], params, NOW);
    expect(r).toMatchObject({ workPixels: 4, unknownCountedAsWork: 3, durationMs: 0, assignments: [{ agent: 'a', pixels: 4 }] });
    expect(r.assumptions).toEqual(ETA_ASSUMPTIONS);
    expect(r.assumptions.join(' ')).toMatch(/not a measured performance/);
  });

  it('waits for regeneration from zero energy', () => {
    // 3 pixels, no energy, 1 point every 1000 ms: 3000 ms.
    expect(estimateEta(progress([[RED, 0, 3, 0]]), [agent('a', { energy: 0 })], params, NOW).durationMs).toBe(3000);
    // Energy regenerated since the observation is counted (rounded down).
    expect(estimateEta(progress([[RED, 0, 3, 0]]), [agent('a', { energy: 0, observedAt: NOW - 2500 })], params, NOW).durationMs).toBe(1000);
    // Capped at maxEnergy.
    expect(estimateEta(progress([[RED, 0, 3, 0]]), [agent('a', { energy: 0, maxEnergy: 1, observedAt: 0 })], params, NOW).durationMs).toBe(2000);
  });

  it('applies the cadence, the energy cost, availability and pauses', () => {
    const p = progress([[RED, 0, 4, 0]]);
    expect(estimateEta(p, [agent('a', { energy: 10 })], { ...params, msPerPixel: 250 }, NOW).durationMs).toBe(1000);
    expect(estimateEta(p, [agent('a', { energy: 0 })], { ...params, energyPerPixel: 2 }, NOW).durationMs).toBe(8000);
    expect(estimateEta(p, [agent('a', { energy: 10, availableFrom: NOW + 5000 })], { ...params, msPerPixel: 250 }, NOW).durationMs).toBe(6000);
    const paused = estimateEta(p, [agent('a', { energy: 10 })], { ...params, msPerPixel: 250, pauses: [{ start: NOW + 500, end: NOW + 2500 }, { start: NOW + 2000, end: NOW + 3000 }] }, NOW);
    expect(paused.durationMs).toBe(3500); // 500 ms, pause until +3000 (merged), then 500 ms
  });

  it('splits work between agents with different resources and palettes', () => {
    const p = progress([[RED, 0, 6, 0], [BLUE, 0, 2, 0]]);
    const fast = agent('fast', { energy: 0, regenIntervalMs: 100, unlockedColors: new Set([RED]) });
    const slow = agent('slow', { energy: 0, regenIntervalMs: 1000, unlockedColors: new Set([RED, BLUE]) });
    const r = estimateEta(p, [fast, slow], params, NOW);
    // slow must paint the 2 blue pixels (2000 ms); fast paints the 6 red ones (600 ms).
    expect(r.durationMs).toBe(2000);
    expect(r.assignments.reduce((n, a) => n + a.pixels, 0)).toBe(8);
    expect(r.assignments.find((a) => a.agent === 'slow')!.pixels).toBeGreaterThanOrEqual(2);
  });

});

/**
 * Millisecond simulation of ONE agent with continuous regeneration (also
 * during bursts and pauses): what the estimate's pessimistic model must
 * never undercut.
 */
function simulate(pixels: number, a: EtaAgent, p: EtaParameters, now: number, regenAmount = 1): number {
  let energy = a.energy;
  let nextRegen = a.observedAt + a.regenIntervalMs;
  const start = Math.max(now, a.availableFrom ?? now);
  let done = 0;
  let nextFree = start;
  let finish = now;
  for (let t = a.observedAt; done < pixels; t++) {
    while (t >= nextRegen) {
      if (energy < a.maxEnergy) energy = Math.min(a.maxEnergy, energy + regenAmount);
      nextRegen += a.regenIntervalMs;
    }
    const paused = (p.pauses ?? []).some((w) => t >= w.start && t < w.end);
    while (!paused && t >= start && t >= nextFree && energy >= p.energyPerPixel && done < pixels) {
      energy -= p.energyPerPixel;
      done++;
      nextFree = t + p.msPerPixel;
      finish = Math.max(finish, t + p.msPerPixel);
      if (p.msPerPixel > 0) break;
    }
  }
  return finish - now;
}

/** Second simulation: paints by stepping the SHARED resource model (advance + recorded spends), millisecond by millisecond. */
function simulateShared(pixels: number, state: AgentResourceState, msPerPixel: number, now: number): number {
  const rules = SIMULATED_RULES;
  let s = advance(rules, state, now, now);
  let done = 0;
  let nextFree = now;
  let finish = now;
  for (let t = now; done < pixels; t++) {
    s = advance(rules, s, t, t);
    while (t >= nextFree && s.energy >= rules.energy.costPerPixel && done < pixels) {
      s = applyOperation(rules, s, { type: 'spend', id: `p${done}`, at: t, energy: rules.energy.costPerPixel }, t, 'recorded');
      done++;
      nextFree = t + msPerPixel;
      finish = Math.max(finish, t + msPerPixel);
      if (msPerPixel > 0) break;
    }
  }
  return finish - now;
}

const p = (n: number) => progress([[0xff0000 as Rgb, 0, n, 0]], { status: 'fresh', ageMs: 0, maxAgeMs: 1000 });
const parameters = { rules: SIMULATED_RULES, msPerPixel: 0, minCoveragePercent: 0 };

describe('EtaEstimator: on the ResourceManager and the shared energy model', () => {

  it('takes its agents from the ResourceManager and is recomputed after resource changes', () => {
    const m = createResourceManager(SIMULATED_RULES);
    m.observe(observation({ agent: 'x' as AgentId, observedAt: NOW, energy: 4, regenProgressMs: 0 }));
    const before = estimateEtaV5(p(6), etaAgentsFrom(m, NOW), parameters, NOW).durationMs!;
    expect(before).toBe(2000); // 4 now, then 2 ticks of 1000 ms
    // A spend at the observation time is reflected by it; one later is applied.
    expect(m.recordSpend('x' as AgentId, { operationId: 'paint-0', energy: 3, at: NOW }, NOW).status).toBe('absorbed-by-observation');
    expect(m.recordSpend('x' as AgentId, { operationId: 'paint-1', energy: 3, at: NOW + 1 }, NOW + 1).status).toBe('applied');
    expect(estimateEtaV5(p(6), etaAgentsFrom(m, NOW + 1), parameters, NOW + 1).durationMs).toBe(5000); // 1 now, 5 ticks
    m.observe(observation({ agent: 'x' as AgentId, observedAt: NOW + 10, energy: 9 }));
    expect(estimateEtaV5(p(6), etaAgentsFrom(m, NOW + 10), parameters, NOW + 10).durationMs).toBe(0);
  });

  it('uses each agent palette and simulated upgrades (faster regeneration never lengthens it)', () => {
    const base = stateFromObservation(SIMULATED_RULES, observation({ energy: 0, currency: 1000 }));
    const slow = estimateEtaV5(p(5), [{ id: base.agent, state: base }], parameters, NOW).durationMs!;
    const faster = applyOperation(SIMULATED_RULES, base, { type: 'upgrade-regen-speed', id: 'u', at: NOW }, NOW);
    const fast = estimateEtaV5(p(5), [{ id: base.agent, state: faster }], parameters, NOW);
    expect(fast.durationMs!).toBeLessThan(slow);
    expect(fast.warnings.map((w) => w.code)).toContain('SIMULATED_RESOURCES');
    const blue = progress([[0x0000ff as Rgb, 0, 1, 0]], { status: 'fresh', ageMs: 0, maxAgeMs: 1000 });
    expect(codes(estimateEtaV5(blue, [{ id: base.agent, state: base }], parameters, NOW))).toEqual(['COLORS_UNAVAILABLE']);
    const unlocked = applyOperation(SIMULATED_RULES, base, { type: 'unlock-color', id: 'c', at: NOW, color: 0x0000ff as Rgb }, NOW);
    expect(estimateEtaV5(blue, [{ id: base.agent, state: unlocked }], parameters, NOW).durationMs).toBe(1000);
  });

  it('never undercuts a simulation stepping the shared energy model', () => {
    const pick = testRandom(Number(process.env.GEOPLACER_ETA_SEED ?? 404));
    for (let k = 0; k < 150; k++) {
      const pixels = 1 + pick(15);
      const state = stateFromObservation(SIMULATED_RULES, observation({ energy: pick(11), observedAt: NOW - pick(3000), ...(pick(2) === 0 ? { regenProgressMs: pick(1000) } : {}) }));
      const msPerPixel = pick(3) * pick(700);
      const eta = estimateEtaV5(p(pixels), [{ id: state.agent, state }], { ...parameters, msPerPixel }, NOW).durationMs!;
      expect(simulateShared(pixels, state, msPerPixel, NOW), JSON.stringify({ pixels, msPerPixel, energy: state.energy })).toBeLessThanOrEqual(eta);
    }
  });
});

describe('EtaEstimator: pinned cases and agreement with the ResourceManager', () => {
  it('never counts an instant pixel at the very start of a pause (cases found by the simulation, seeds 2 and 11)', () => {
    // 1B.4 gave 185 and 24 ms: below what can actually be painted (simulation: 485 and 309 ms).
    const cases: Array<[number, EtaAgent, EtaParameters, number]> = [
      [19, agent('a', { energy: 1, maxEnergy: 3, regenIntervalMs: 10, observedAt: NOW - 95, availableFrom: NOW + 25 }), { ...params, pauses: [{ start: NOW + 185, end: NOW + 485 }] }, 185],
      [5, agent('a', { energy: 1, maxEnergy: 4, regenIntervalMs: 16, observedAt: NOW - 56, availableFrom: NOW + 8 }), { ...params, pauses: [{ start: NOW + 24, end: NOW + 309 }] }, 24],
    ];
    for (const [pixels, a, pp, previous] of cases) {
      expect(estimateEta1b4(progress([[RED, 0, pixels, 0]]), [a], pp, NOW).durationMs).toBe(previous);
      const eta = estimateEta(progress([[RED, 0, pixels, 0]]), [a], pp, NOW).durationMs!;
      expect(eta).toBeGreaterThanOrEqual(simulate(pixels, a, pp, NOW));
      expect(eta).toBeGreaterThan(previous);
    }
  });

  it('agrees with ResourceManager.timeUntil: never shorter, equal when the regeneration phase is 0', () => {
    const pick = testRandom(29);
    for (let k = 0; k < 200; k++) {
      const m = createResourceManager(SIMULATED_RULES);
      const progressMs = pick(3) === 0 ? 0 : pick(1000);
      m.observe(observation({ agent: 'x' as AgentId, observedAt: NOW, energy: pick(10), regenProgressMs: progressMs }));
      const state = m.stateAt('x' as AgentId, NOW, NOW);
      const pixels = 1 + pick(10 - Math.min(9, state.energy)) + state.energy; // within the capacity of 10
      const eta = estimateEtaV5(p(pixels), etaAgentsFrom(m, NOW), parameters, NOW).durationMs!;
      const wait = m.timeUntil('x' as AgentId, pixels * SIMULATED_RULES.energy.costPerPixel, NOW)!;
      expect(eta).toBeGreaterThanOrEqual(wait);
      // The ETA ignores the known progress after the initial energy (pessimistic): equal only at 0.
      if (progressMs === 0 || pixels <= state.energy) expect(eta).toBe(wait);
    }
  });

  it('warns about the age of resource observations without a policy, and is unavailable beyond it', () => {
    const m = createResourceManager(SIMULATED_RULES);
    m.observe(observation({ agent: 'x' as AgentId, observedAt: NOW, energy: 9 }));
    const at = NOW + 60_000;
    const codesOf = (extra: object) => estimateEtaV5(p(3), etaAgentsFrom(m, at), { ...parameters, ...extra }, at).warnings.map((w) => w.code);
    expect(codesOf({})).toEqual(['RESOURCE_AGE_NOT_EVALUATED']);
    expect(codesOf({ maxResourceAgeMs: 120_000 })).toEqual([]);
    expect(codesOf({ maxResourceAgeMs: 30_000 })).toEqual([]);
    const stale = estimateEtaV5(p(3), etaAgentsFrom(m, at), { ...parameters, maxResourceAgeMs: 30_000 }, at);
    expect(stale.durationMs).toBeNull();
    expect(codes(stale)).toEqual(['STALE_RESOURCES']);
    expect(codes(estimateEtaV5(p(3), etaAgentsFrom(m, at), { ...parameters, maxResourceAgeMs: -1 }, at))).toEqual(['INVALID_PARAMETERS']);
  });
});

describe('EtaEstimator: properties', () => {
  it('never undercuts a millisecond simulation of one agent, and matches it when energy covers the work', () => {
    const pick = testRandom(Number(process.env.GEOPLACER_ETA_SEED ?? 77));
    for (let k = 0; k < 600; k++) {
      const pixels = 1 + pick(20);
      const a = agent('a', { energy: pick(6), maxEnergy: 1 + pick(8), regenIntervalMs: 1 + pick(60), observedAt: NOW - pick(100), availableFrom: NOW + pick(3) * pick(40) });
      const pp: EtaParameters = {
        energyPerPixel: 1 + pick(2),
        msPerPixel: pick(3) * pick(30),
        minCoveragePercent: 0,
        pauses: pick(2) === 0 ? [] : [{ start: NOW + pick(200), end: NOW + 200 + pick(300) }],
      };
      if (a.maxEnergy < pp.energyPerPixel) continue;
      const amount = 1 + pick(3) * pick(2); // 1 to 3 energy per tick
      const eta = estimateEta(progress([[RED, 0, pixels, 0]]), [a], pp, NOW, amount).durationMs;
      const where = JSON.stringify({ pixels, a: { ...a, unlockedColors: 0 }, pp, amount });
      expect(eta, where).not.toBeNull();
      expect(simulate(pixels, a, pp, NOW, amount), where).toBeLessThanOrEqual(eta!);
    }
    // Energy for the whole work, no pause, start now: the model is exact (pixels x cadence).
    // Otherwise it may exceed the simulation by at most one refill wait (unknown regeneration phase).
    for (const pixels of [1, 5, 17]) {
      const a = agent('a', { energy: 20, maxEnergy: 20, regenIntervalMs: 10 });
      const pp: EtaParameters = { energyPerPixel: 1, msPerPixel: 40, minCoveragePercent: 0 };
      expect(estimateEta(progress([[RED, 0, pixels, 0]]), [a], pp, NOW).durationMs).toBe(simulate(pixels, a, pp, NOW));
    }
  });

  it('is monotonic: more work, a pause or less energy never shortens it; another agent never lengthens it', () => {
    const pick = testRandom(9);
    for (let k = 0; k < 80; k++) {
      const red = 1 + pick(30);
      const blue = pick(10);
      const agents = [agent('a', { energy: pick(5), regenIntervalMs: 1 + pick(500) }), agent('b', { energy: pick(5), regenIntervalMs: 1 + pick(500), unlockedColors: new Set([RED]) })];
      const pp: EtaParameters = { energyPerPixel: 1 + pick(2), msPerPixel: pick(100), minCoveragePercent: 0 };
      const base = estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), agents, pp, NOW).durationMs!;
      expect(base).not.toBeNull();
      expect(estimateEta(progress([[RED, 0, red + 1 + pick(5), 0], [BLUE, 0, blue, 0]]), agents, pp, NOW).durationMs!).toBeGreaterThanOrEqual(base);
      expect(estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), agents, { ...pp, pauses: [{ start: NOW + pick(100), end: NOW + 100 + pick(1000) }] }, NOW).durationMs!).toBeGreaterThanOrEqual(base);
      const poorer = agents.map((a) => ({ ...a, energy: 0 }));
      expect(estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), poorer, pp, NOW).durationMs!).toBeGreaterThanOrEqual(base);
      const more = [...agents, agent('c', { energy: pick(5), regenIntervalMs: 1 + pick(500), unlockedColors: new Set([pick(2) === 0 ? RED : BLUE]) })];
      expect(estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), more, pp, NOW).durationMs!).toBeLessThanOrEqual(base);
      // Deterministic.
      expect(estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), agents, pp, NOW)).toEqual(estimateEta(progress([[RED, 0, red, 0], [BLUE, 0, blue, 0]]), agents, pp, NOW));
    }
  });
});
