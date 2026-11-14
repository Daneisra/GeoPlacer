/**
 * EtaEstimator: theoretical time to finish a template, from a progress
 * snapshot and the resources of the agents. Deterministic, integer
 * arithmetic, testable with any `now` (no real waiting).
 *
 * Model (wall clock, from `now`):
 * - work: known incorrect + unknown pixels of each color (unknown pixels are
 *   assumed to need painting);
 * - agent i starts at max(now, availableFrom); its energy there is predicted
 *   from its last observation, rounded down, capped at maxEnergy;
 * - it paints one pixel at a time, at most one every msPerPixel (C), each
 *   costing energyPerPixel (k): first B = floor(E / k) pixels from its
 *   energy, then one every D = max(C, k x regenIntervalMs), after a first
 *   wait of at most min(C, k x regenIntervalMs) (see capacity). Regeneration
 *   during that first burst, during pauses and before the start is ignored
 *   (the capacity is underestimated: pessimistic);
 * - nobody paints during the configured pauses;
 * - capacity of agent i at time T: pixels it can finish by now + T;
 * - the ETA is the smallest T at which the agents' capacities can cover the
 *   work of every color with agents that unlocked it (max flow colors ->
 *   agents): the best possible split between agents (optimistic; exact with
 *   one agent).
 */

import type {
  AgentId,
  EtaAgent,
  EtaAssignment,
  EtaEstimator,
  EtaParameters,
  EtaPause,
  EtaResult,
  EtaUnavailableReason,
  ProgressSnapshot,
  ResourceModel,
  ResourceSnapshot,
  Rgb,
  Timestamp,
} from '../contracts/index.js';

/** The hypotheses behind every estimate (returned with each result). */
export const ETA_ASSUMPTIONS: readonly string[] = [
  'theoretical estimate under these assumptions, not a measured performance',
  'every unknown eligible pixel is assumed to need painting (pessimistic)',
  'an agent paints one pixel at a time, at most one every msPerPixel, spending energyPerPixel energy per pixel',
  'energy is predicted from the last observation, rounded down; regeneration during the initial burst, pauses and waiting is ignored (pessimistic)',
  'after its initial energy, an agent paints one pixel every max(msPerPixel, energyPerPixel x regenIntervalMs)',
  'the work is split between agents in the best possible way, within their palettes (optimistic; exact with one agent)',
  'no rejected write, no third-party change on the canvas, no outage (optimistic)',
  'nobody paints during the configured pauses; an agent starts at availableFrom',
];

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

/** EtaAgent from a resource observation and the service's resource model. */
export function etaAgentFrom(id: AgentId, resources: ResourceSnapshot, model: Pick<ResourceModel, 'regenIntervalMs'>, availableFrom?: Timestamp): EtaAgent {
  return {
    id,
    energy: resources.energy,
    maxEnergy: resources.maxEnergy,
    regenIntervalMs: model.regenIntervalMs,
    observedAt: resources.observedAt,
    unlockedColors: resources.unlockedColors,
    ...(availableFrom === undefined ? {} : { availableFrom }),
  };
}

/** Sorted, merged pause windows. */
function mergePauses(pauses: readonly EtaPause[]): EtaPause[] {
  const sorted = [...pauses].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: EtaPause[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && p.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, p.end) };
    else merged.push({ start: p.start, end: p.end });
  }
  return merged;
}

/** Time in [from, to) outside the pauses. */
function activeTime(from: number, to: number, pauses: readonly EtaPause[]): number {
  if (to <= from) return 0;
  let active = to - from;
  for (const p of pauses) {
    const overlap = Math.min(to, p.end) - Math.max(from, p.start);
    if (overlap > 0) active -= overlap;
  }
  return active;
}

interface AgentModel {
  readonly id: AgentId;
  readonly start: number;
  /** Pixels from the energy available at start. */
  readonly burst: number;
  /** Milliseconds per pixel after the burst (Infinity: never regenerates enough). */
  readonly interval: number;
  /** Milliseconds to regenerate the energy of one pixel (k x regenIntervalMs). */
  readonly refill: number;
  readonly colors: ReadonlySet<Rgb>;
}

/**
 * Pixels agent `a` can finish by `end` (wall clock). Non-decreasing in `end`.
 * In active (non-paused) time from its start, with C = msPerPixel,
 * R = refill (energy of one pixel) and D = max(C, R):
 * - burst pixel j (1..B) finishes at j x C;
 * - after the burst, pixel j finishes at most at B x C + j x D + min(C, R):
 *   the first one may wait up to R for its energy (regeneration phase
 *   unknown), then takes C; the next ones follow every D.
 * Checked against a millisecond simulation (test/eta.test.ts).
 */
function capacity(a: AgentModel, end: number, msPerPixel: number, pauses: readonly EtaPause[]): number {
  // Nothing is painted before the first instant that is not paused (matters for an instant burst, C = 0).
  let first = a.start;
  for (const p of pauses) if (first >= p.start && first < p.end) first = p.end;
  if (end < first) return 0;
  const active = activeTime(a.start, end, pauses);
  const { burst, interval } = a;
  const burstTime = burst * msPerPixel;
  if (msPerPixel > 0 && active < burstTime) return Math.floor(active / msPerPixel);
  if (interval === Infinity) return burst;
  const after = active - burstTime - Math.min(msPerPixel, a.refill);
  return burst + (after < interval ? 0 : Math.floor(after / interval));
}

/** Max flow colors -> agents (Edmonds-Karp on a small dense graph); returns the flow into each agent. */
function maxFlow(work: readonly number[], allowed: readonly (readonly boolean[])[], caps: readonly number[]): { total: number; perAgent: number[] } {
  const nc = work.length;
  const na = caps.length;
  const n = nc + na + 2;
  const s = 0;
  const t = n - 1;
  const cap = Array.from({ length: n }, () => new Float64Array(n));
  const totalWork = work.reduce((x, y) => x + y, 0);
  for (let c = 0; c < nc; c++) {
    cap[s]![1 + c] = work[c]!;
    for (let a = 0; a < na; a++) if (allowed[c]![a]) cap[1 + c]![1 + nc + a] = totalWork;
  }
  for (let a = 0; a < na; a++) cap[1 + nc + a]![t] = Math.min(caps[a]!, totalWork);
  let total = 0;
  const parent = new Int32Array(n);
  for (;;) {
    parent.fill(-1);
    parent[s] = s;
    const queue = [s];
    for (let q = 0; q < queue.length && parent[t] === -1; q++) {
      const u = queue[q]!;
      for (let v = 0; v < n; v++) {
        if (parent[v] === -1 && cap[u]![v]! > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[t] === -1) break;
    let push = Infinity;
    for (let v = t; v !== s; v = parent[v]!) push = Math.min(push, cap[parent[v]!]![v]!);
    for (let v = t; v !== s; v = parent[v]!) {
      cap[parent[v]!]![v]! -= push;
      cap[v]![parent[v]!]! += push;
    }
    total += push;
  }
  // Flow into the sink from each agent = its residual reverse capacity.
  const perAgent = Array.from({ length: na }, (_, a) => cap[t]![1 + nc + a]!);
  return { total, perAgent };
}

function unavailable(progress: ProgressSnapshot, now: number, reasons: EtaUnavailableReason[], work: number, unknown: number): EtaResult {
  return {
    kind: 'theoretical-estimate',
    durationMs: null,
    finishAt: null,
    unavailable: reasons,
    workPixels: work,
    unknownCountedAsWork: unknown,
    assignments: [],
    assumptions: ETA_ASSUMPTIONS,
    basis: progress.basis,
    computedAt: now,
  };
}

export function estimateEta(progress: ProgressSnapshot, agents: readonly EtaAgent[], parameters: EtaParameters, now: Timestamp): EtaResult {
  const reasons: EtaUnavailableReason[] = [];
  const invalid = (message: string, extra: Partial<EtaUnavailableReason> = {}): void => {
    reasons.push({ code: 'INVALID_PARAMETERS', message, ...extra });
  };
  const workByColor = progress.byColor.map((c) => ({ color: c.color, pixels: c.incorrect + c.unknown }));
  const workPixels = workByColor.reduce((n, c) => n + c.pixels, 0);
  const unknown = progress.unknown;

  // 1. Inputs.
  if (!isInt(now)) invalid('now must be a non-negative integer timestamp');
  const { energyPerPixel: k, msPerPixel: cadence, minCoveragePercent } = parameters;
  if (!isInt(k, 1)) invalid('energyPerPixel must be a positive integer');
  if (!isInt(cadence)) invalid('msPerPixel must be a non-negative integer');
  if (typeof minCoveragePercent !== 'number' || !(minCoveragePercent >= 0 && minCoveragePercent <= 100)) invalid('minCoveragePercent must be in [0, 100]');
  for (const p of parameters.pauses ?? []) if (!isInt(p.start) || !isInt(p.end) || p.end <= p.start) invalid('a pause must be [start, end) with integer timestamps and end > start');
  if (!Number.isSafeInteger(workPixels) || workPixels < 0 || progress.byColor.some((c) => !isInt(c.incorrect) || !isInt(c.unknown))) {
    invalid('progress counters must be non-negative integers');
  }
  const ids = new Set<AgentId>();
  for (const a of agents) {
    const bad = (what: string): void => invalid(`agent ${a.id}: ${what}`, { agents: [a.id] });
    if (ids.has(a.id)) bad('listed twice');
    ids.add(a.id);
    if (!isInt(a.energy)) bad('energy must be a non-negative integer');
    if (!isInt(a.maxEnergy)) bad('maxEnergy must be a non-negative integer');
    if (!isInt(a.regenIntervalMs, 1)) bad('regenIntervalMs must be a positive integer');
    if (!isInt(a.observedAt) || (isInt(now) && a.observedAt > now)) bad('observedAt must be an integer timestamp not after now');
    if (a.availableFrom !== undefined && !isInt(a.availableFrom)) bad('availableFrom must be an integer timestamp');
    if (!(a.unlockedColors instanceof Set)) bad('unlockedColors must be a Set');
  }

  // 2. Observation quality.
  const freshness = progress.basis.freshness.status;
  if (freshness === 'future') invalid('the snapshot was observed after now (inconsistent clocks)');
  if (freshness === 'stale') {
    reasons.push({ code: 'STALE_SNAPSHOT', message: `the snapshot is ${progress.basis.freshness.ageMs} ms old, beyond the ${String(progress.basis.freshness.maxAgeMs)} ms policy of its source` });
  }
  if (progress.coveragePercent !== null && typeof minCoveragePercent === 'number' && progress.coveragePercent < minCoveragePercent) {
    reasons.push({ code: 'INSUFFICIENT_OBSERVATION', message: `only ${progress.coveragePercent.toFixed(2)} % of the eligible pixels are observed (minimum ${minCoveragePercent} %)` });
  }
  if (reasons.length > 0) return unavailable(progress, now, reasons, workPixels, unknown);

  // 3. Nothing left to paint (fully observed, all correct; or nothing eligible): 0, agents or not.
  if (workPixels === 0) {
    return { ...unavailable(progress, now, [], 0, 0), durationMs: 0, finishAt: now };
  }

  // 4. Agents able to paint, and colors nobody can paint.
  if (agents.length === 0) return unavailable(progress, now, [{ code: 'NO_AGENT', message: 'no agent available' }], workPixels, unknown);
  const pauses = mergePauses(parameters.pauses ?? []);
  const models: AgentModel[] = [];
  const powerless: AgentId[] = [];
  for (const a of agents) {
    const start = Math.max(now, a.availableFrom ?? now);
    const regenerated = a.energy >= a.maxEnergy ? a.energy : Math.min(a.maxEnergy, a.energy + Math.floor((start - a.observedAt) / a.regenIntervalMs));
    const burst = Math.floor(regenerated / k);
    const interval = a.maxEnergy >= k ? Math.max(cadence, k * a.regenIntervalMs) : Infinity;
    if (burst === 0 && interval === Infinity) powerless.push(a.id);
    else models.push({ id: a.id, start, burst, interval, refill: k * a.regenIntervalMs, colors: a.unlockedColors });
  }
  if (models.length === 0) {
    return unavailable(progress, now, [{ code: 'INSUFFICIENT_ENERGY', message: `no agent can ever hold the ${k} energy of one pixel`, agents: powerless }], workPixels, unknown);
  }
  const needed = workByColor.filter((c) => c.pixels > 0);
  const missingColors = needed.filter((c) => !models.some((m) => m.colors.has(c.color))).map((c) => c.color);
  if (missingColors.length > 0) {
    return unavailable(progress, now, [{ code: 'COLORS_UNAVAILABLE', message: `${missingColors.length} color(s) with remaining work are unlocked by no able agent`, colors: missingColors }], workPixels, unknown);
  }

  // 5. Feasible at all? Given unlimited time, an agent that never regenerates
  // a pixel's energy still paints only its burst.
  const allowed = needed.map((c) => models.map((m) => m.colors.has(c.color)));
  const work = needed.map((c) => c.pixels);
  if (maxFlow(work, allowed, models.map((m) => (m.interval === Infinity ? m.burst : workPixels))).total < workPixels) {
    const starved = needed.filter((_, ci) => !models.some((m, mi) => allowed[ci]![mi] && m.interval !== Infinity)).map((c) => c.color);
    return unavailable(
      progress,
      now,
      [{ code: 'INSUFFICIENT_ENERGY', message: 'the agents able to paint some colors can never regenerate enough energy for all of their work', colors: starved }],
      workPixels,
      unknown
    );
  }

  // 6. Smallest T (ms from now) whose capacities cover the work.
  const flowAt = (T: number) => maxFlow(work, allowed, models.map((m) => capacity(m, now + T, cadence, pauses)));
  const limit = Number.MAX_SAFE_INTEGER - now;
  let hi = 1;
  while (flowAt(hi).total < workPixels) {
    if (hi >= limit) {
      return unavailable(progress, now, [{ code: 'OUT_OF_RANGE', message: 'the estimate exceeds the safe range of milliseconds' }], workPixels, unknown);
    }
    hi = Math.min(limit, hi * 2);
  }
  let lo = 0;
  if (flowAt(0).total >= workPixels) hi = 0;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (flowAt(mid).total >= workPixels) hi = mid;
    else lo = mid + 1;
  }
  const split = flowAt(hi).perAgent;
  const assignments: EtaAssignment[] = models.map((m, i) => ({ agent: m.id, pixels: split[i] ?? 0 })).filter((x) => x.pixels > 0);
  return {
    kind: 'theoretical-estimate',
    durationMs: hi,
    finishAt: now + hi,
    unavailable: [],
    workPixels,
    unknownCountedAsWork: unknown,
    assignments,
    assumptions: ETA_ASSUMPTIONS,
    basis: progress.basis,
    computedAt: now,
  };
}

export function createEtaEstimator(): EtaEstimator {
  return { estimate: estimateEta };
}
