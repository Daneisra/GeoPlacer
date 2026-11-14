/**
 * EtaEstimator: theoretical time to finish a template, from a progress
 * snapshot and the resources of the agents. Deterministic, integer
 * arithmetic, testable with any `now` (no real waiting).
 *
 * Model (wall clock, from `now`):
 * - work: known incorrect + unknown pixels of each color (unknown pixels are
 *   assumed to need painting);
 * - agent i starts at max(now, end of its unavailability); its energy there
 *   comes from the shared resource model (resources/energy: advance, whole
 *   ticks, unknown phase as a lower bound);
 * - its painting capacity over active time is the shared pessimistic
 *   schedule (resources/energy: paintingCapacity): burst from its energy,
 *   then regeneration with an unknown phase, at most one pixel every
 *   msPerPixel. Regeneration during the burst, pauses and waiting is ignored
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
  AgentResourceState,
  EtaAgent,
  EtaAssignment,
  EtaEstimator,
  EtaParameters,
  EtaPause,
  EtaResult,
  EtaUnavailableReason,
  EtaWarning,
  ProgressSnapshot,
  ResourceRules,
  Rgb,
  Timestamp,
} from '../contracts/index.js';
import type { ResourceManager } from '../contracts/index.js';
import { advance, paintingCapacity } from '../resources/energy.js';
import { capacityOf, validateRules } from '../resources/rules.js';
import { validateState } from '../resources/state.js';

/** The hypotheses behind every estimate (returned with each result). */
export const ETA_ASSUMPTIONS: readonly string[] = [
  'theoretical estimate under these assumptions, not a measured performance',
  'every unknown eligible pixel is assumed to need painting (pessimistic)',
  'an agent paints one pixel at a time, at most one every msPerPixel, spending the costPerPixel of the rules per pixel',
  'energy comes from the shared resource model (whole regeneration ticks, unknown phase as a lower bound); regeneration during the initial burst, pauses and waiting is ignored (pessimistic)',
  'after its initial energy, an agent waits for regeneration with an unknown phase and leftover energy counted as zero (pessimistic)',
  'the work is split between agents in the best possible way, within their palettes (optimistic; exact with one agent)',
  'no rejected write, no third-party change on the canvas, no outage (optimistic)',
  'nobody paints during the configured pauses; an unavailable agent starts when its unavailability ends (never, if it has no end)',
];

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

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
  /** Resource state regenerated up to `start` (shared model). */
  readonly state: AgentResourceState;
  /** Pixels from the energy available at start. */
  readonly burst: number;
  /** False when its capacity is below the cost of one pixel: burst only. */
  readonly regenerates: boolean;
  readonly colors: ReadonlySet<Rgb>;
}

/**
 * Pixels agent `a` can finish by `end` (wall clock). Non-decreasing in `end`:
 * the shared pessimistic painting schedule over the active (non-paused)
 * time since its start. Checked against a millisecond simulation
 * (test/eta.test.ts).
 */
function capacity(rules: ResourceRules, a: AgentModel, end: number, msPerPixel: number, pauses: readonly EtaPause[]): number {
  // Nothing is painted before the first instant that is not paused (matters for an instant burst, C = 0).
  let first = a.start;
  for (const p of pauses) if (first >= p.start && first < p.end) first = p.end;
  if (end < first) return 0;
  let active = activeTime(a.start, end, pauses);
  // An instant pixel (C = 0) needs an unpaused instant: at a paused `end`, the last paintable instant is before the pause.
  if (msPerPixel === 0 && pauses.some((p) => end >= p.start && end < p.end)) active -= 1;
  return paintingCapacity(rules, a.state, active, msPerPixel);
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

function unavailable(progress: ProgressSnapshot, now: number, reasons: EtaUnavailableReason[], work: number, unknown: number, warnings: EtaWarning[] = []): EtaResult {
  return {
    kind: 'theoretical-estimate',
    durationMs: null,
    finishAt: null,
    unavailable: reasons,
    workPixels: work,
    unknownCountedAsWork: unknown,
    assignments: [],
    assumptions: ETA_ASSUMPTIONS,
    warnings,
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
  const { rules, msPerPixel: cadence, minCoveragePercent } = parameters;
  let rulesOk = true;
  try {
    validateRules(rules);
  } catch (error) {
    rulesOk = false;
    invalid(`rules: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isInt(cadence)) invalid('msPerPixel must be a non-negative integer');
  if (typeof minCoveragePercent !== 'number' || !(minCoveragePercent >= 0 && minCoveragePercent <= 100)) invalid('minCoveragePercent must be in [0, 100]');
  for (const p of parameters.pauses ?? []) if (!isInt(p.start) || !isInt(p.end) || p.end <= p.start) invalid('a pause must be [start, end) with integer timestamps and end > start');
  if (parameters.maxResourceAgeMs !== undefined && !isInt(parameters.maxResourceAgeMs)) invalid('maxResourceAgeMs must be a non-negative integer');
  if (!Number.isSafeInteger(workPixels) || workPixels < 0 || progress.byColor.some((c) => !isInt(c.incorrect) || !isInt(c.unknown))) {
    invalid('progress counters must be non-negative integers');
  }
  const ids = new Set<AgentId>();
  for (const a of agents) {
    const bad = (what: string): void => invalid(`agent ${a.id}: ${what}`, { agents: [a.id] });
    if (ids.has(a.id)) bad('listed twice');
    ids.add(a.id);
    if (!rulesOk) continue;
    try {
      validateState(rules, a.state);
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (a.state.agent !== a.id) bad('the resource state belongs to another agent');
    if (isInt(now) && a.state.at > now) bad('the resource state is dated after now');
  }
  const warnings: EtaWarning[] = [];
  if (progress.basis.freshness.status === 'not-evaluated') {
    warnings.push({
      code: 'FRESHNESS_NOT_EVALUATED',
      message: `no freshness policy for ${progress.basis.source}: the snapshot is ${progress.basis.freshness.ageMs} ms old and its age was not judged`,
    });
  }
  const aged = agents
    .filter((a) => isInt((a.state as AgentResourceState | undefined)?.observedAt) && isInt(now) && now > a.state.observedAt)
    .map((a) => `${a.id} (${now - a.state.observedAt} ms)`);
  if (parameters.maxResourceAgeMs === undefined) {
    if (aged.length > 0) warnings.push({ code: 'RESOURCE_AGE_NOT_EVALUATED', message: `resource observations not judged for age: ${aged.join(', ')}` });
  } else if (isInt(parameters.maxResourceAgeMs)) {
    const max = parameters.maxResourceAgeMs;
    const stale = agents.filter((a) => isInt(a.state?.observedAt) && isInt(now) && now - a.state.observedAt > max).map((a) => `${a.id} (${now - a.state.observedAt} ms)`);
    if (stale.length > 0) warnings.push({ code: 'STALE_RESOURCES', message: `resource observations older than ${max} ms: ${stale.join(', ')}` });
  }
  const simulated = agents.filter((a) => (a.state as AgentResourceState | undefined)?.kind === 'simulated').map((a) => a.id);
  if (simulated.length > 0) warnings.push({ code: 'SIMULATED_RESOURCES', message: `hypothetical (simulated) resources for ${simulated.join(', ')}` });

  // 2. Observation quality.
  const freshness = progress.basis.freshness.status;
  if (freshness === 'future') invalid('the snapshot was observed after now (inconsistent clocks)');
  if (freshness === 'stale') {
    reasons.push({ code: 'STALE_SNAPSHOT', message: `the snapshot is ${progress.basis.freshness.ageMs} ms old, beyond the ${String(progress.basis.freshness.maxAgeMs)} ms policy of its source` });
  }
  if (progress.coveragePercent !== null && typeof minCoveragePercent === 'number' && progress.coveragePercent < minCoveragePercent) {
    reasons.push({ code: 'INSUFFICIENT_OBSERVATION', message: `only ${progress.coveragePercent.toFixed(2)} % of the eligible pixels are observed (minimum ${minCoveragePercent} %)` });
  }
  if (reasons.length > 0) return unavailable(progress, now, reasons, workPixels, unknown, warnings);

  // 3. Nothing left to paint (fully observed, all correct; or nothing eligible): 0, agents or not.
  if (workPixels === 0) {
    return { ...unavailable(progress, now, [], 0, 0, warnings), durationMs: 0, finishAt: now };
  }

  // 4. Agents able to paint, and colors nobody can paint.
  const k = rules.energy.costPerPixel;
  const pauses = mergePauses(parameters.pauses ?? []);
  const models: AgentModel[] = [];
  const powerless: AgentId[] = [];
  for (const a of agents) {
    const availability = a.state.availability;
    if (availability.status === 'unavailable' && availability.until === null) continue; // never available
    const start = Math.max(now, availability.status === 'unavailable' ? (availability.until ?? now) : now);
    const state = advance(rules, a.state, start, now);
    const burst = Math.floor(state.energy / k);
    const regenerates = capacityOf(rules, state.upgrades) >= k;
    if (burst === 0 && !regenerates) powerless.push(a.id);
    else models.push({ id: a.id, start, state, burst, regenerates, colors: new Set(state.unlockedColors) });
  }
  if (models.length === 0 && powerless.length === 0) {
    return unavailable(progress, now, [{ code: 'NO_AGENT', message: 'no agent available' }], workPixels, unknown, warnings);
  }
  if (models.length === 0) {
    return unavailable(progress, now, [{ code: 'INSUFFICIENT_ENERGY', message: `no agent can ever hold the ${k} energy of one pixel`, agents: powerless }], workPixels, unknown, warnings);
  }
  const needed = workByColor.filter((c) => c.pixels > 0);
  const missingColors = needed.filter((c) => !models.some((m) => m.colors.has(c.color))).map((c) => c.color);
  if (missingColors.length > 0) {
    return unavailable(progress, now, [{ code: 'COLORS_UNAVAILABLE', message: `${missingColors.length} color(s) with remaining work are unlocked by no able agent`, colors: missingColors }], workPixels, unknown, warnings);
  }

  // 5. Feasible at all? Given unlimited time, an agent that never regenerates
  // a pixel's energy still paints only its burst.
  const allowed = needed.map((c) => models.map((m) => m.colors.has(c.color)));
  const work = needed.map((c) => c.pixels);
  if (maxFlow(work, allowed, models.map((m) => (m.regenerates ? workPixels : m.burst))).total < workPixels) {
    const starved = needed.filter((_, ci) => !models.some((m, mi) => allowed[ci]![mi] && m.regenerates)).map((c) => c.color);
    return unavailable(
      progress,
      now,
      [{ code: 'INSUFFICIENT_ENERGY', message: 'the agents able to paint some colors can never regenerate enough energy for all of their work', colors: starved }],
      workPixels,
      unknown,
      warnings
    );
  }

  // 6. Smallest T (ms from now) whose capacities cover the work.
  const flowAt = (T: number) => maxFlow(work, allowed, models.map((m) => capacity(rules, m, now + T, cadence, pauses)));
  const limit = Number.MAX_SAFE_INTEGER - now;
  let hi = 1;
  while (flowAt(hi).total < workPixels) {
    if (hi >= limit) {
      return unavailable(progress, now, [{ code: 'OUT_OF_RANGE', message: 'the estimate exceeds the safe range of milliseconds' }], workPixels, unknown, warnings);
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
    warnings,
    basis: progress.basis,
    computedAt: now,
  };
}

/** ETA agents from the ResourceManager (the single source of energy predictions): each agent's state at `now`. */
export function etaAgentsFrom(manager: ResourceManager, now: Timestamp, agents: readonly AgentId[] = manager.agents()): EtaAgent[] {
  return agents.map((id) => ({ id, state: manager.stateAt(id, now, now) }));
}

export function createEtaEstimator(): EtaEstimator {
  return { estimate: estimateEta };
}
