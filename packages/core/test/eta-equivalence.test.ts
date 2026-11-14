/**
 * Phase 1B.5 gate: the ETA now takes its energy from the shared resource
 * model. With a regeneration amount of 1 (the only case 1B.4 knew), every
 * result must be identical to the frozen 1B.4 estimator.
 */

import { describe, expect, it } from 'vitest';
import type { ColorProgress, ProgressSnapshot, Rgb, TemplateId } from '../src/index.js';
import { estimateEta } from '../src/index.js';
import { estimateEta1b4 } from './helpers/eta-1b4-reference.js';
import { convertLegacy, type LegacyAgent, type LegacyParameters } from './helpers/eta-legacy.js';
import { testRandom } from './helpers/strategy.js';

const NOW = 5_000_000;
const COLORS = [0xff0000, 0x00ff00, 0x0000ff, 0x123456] as Rgb[];

function randomCase(pick: (n: number) => number): { progress: ProgressSnapshot; agents: LegacyAgent[]; parameters: LegacyParameters } {
  const byColor: ColorProgress[] = COLORS.slice(0, 1 + pick(4)).map((color) => {
    const correct = pick(5);
    const incorrect = pick(3) === 0 ? 0 : 1 + pick(40);
    const unknown = pick(4) === 0 ? pick(10) : 0;
    return { color, total: correct + incorrect + unknown, correct, incorrect, wrongColor: incorrect, missing: 0, unknown };
  });
  const sum = (k: 'total' | 'correct' | 'incorrect' | 'unknown') => byColor.reduce((n, c) => n + c[k], 0);
  const total = sum('total');
  const progress: ProgressSnapshot = {
    templateId: 'm' as TemplateId,
    revision: 1,
    basis: { source: 'simulated', kind: 'simulation', observedAt: NOW, freshness: { status: 'not-evaluated', ageMs: 0, maxAgeMs: null } },
    total,
    correct: sum('correct'),
    incorrect: sum('incorrect'),
    wrongColor: sum('incorrect'),
    missing: 0,
    unknown: sum('unknown'),
    invalidObservations: 0,
    excluded: { transparent: 0, outsideCanvas: 0 },
    conformityPercent: total ? (sum('correct') * 100) / total : null,
    coveragePercent: total ? ((sum('correct') + sum('incorrect')) * 100) / total : null,
    completion: 'incomplete',
    byColor,
    computedAt: NOW,
  };
  const agents: LegacyAgent[] = Array.from({ length: 1 + pick(3) }, (_, i) => {
    const maxEnergy = 1 + pick(12);
    return {
      id: `a${i}` as LegacyAgent['id'],
      energy: pick(3) === 0 ? maxEnergy + pick(3) : pick(maxEnergy + 1),
      maxEnergy,
      regenIntervalMs: 1 + pick(3) * pick(400),
      observedAt: NOW - pick(2000),
      unlockedColors: new Set(COLORS.filter(() => pick(4) !== 0)),
      ...(pick(3) === 0 ? { availableFrom: NOW + pick(5000) } : {}),
    };
  });
  const parameters: LegacyParameters = {
    energyPerPixel: 1 + pick(3),
    msPerPixel: pick(3) === 0 ? 0 : pick(300),
    minCoveragePercent: 0,
    ...(pick(3) === 0 ? { pauses: [{ start: NOW + pick(3000), end: NOW + 3000 + pick(5000) }] } : {}),
  };
  return { progress, agents, parameters };
}

describe('ETA on the shared resource model: identical to Phase 1B.4', () => {
  // Fixed corpus: since Phase 1B.5 an instant pixel can no longer be counted at the
  // very start of a pause (a rare 1B.4 under-estimate, pinned in eta.test.ts), so
  // another corpus may legitimately differ from 1B.4 in that case.
  it('gives exactly the 1B.4 results on 2 000 random cases (regeneration amount 1)', () => {
    const pick = testRandom(1234);
    let estimated = 0;
    for (let k = 0; k < 2000; k++) {
      const { progress, agents, parameters } = randomCase(pick);
      const before = estimateEta1b4(progress, agents, parameters, NOW);
      const converted = convertLegacy(agents, parameters, NOW, { colors: COLORS });
      const after = estimateEta(progress, converted.agents, converted.parameters, NOW);
      const where = `case ${k}`;
      expect(after.durationMs, where).toBe(before.durationMs);
      expect(after.unavailable.map((u) => u.code), where).toEqual(before.unavailable.map((u) => u.code));
      expect(after.assignments, where).toEqual(before.assignments);
      if (after.durationMs !== null) estimated++;
    }
    expect(estimated).toBeGreaterThan(1000); // the corpus is not made of refusals
  });
});
