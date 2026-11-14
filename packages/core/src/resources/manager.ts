/**
 * In-memory ResourceManager: per agent, the latest observation and a ledger
 * of the spending recorded after it. The single source of truth for the
 * energy of an agent at any time.
 *
 * Rules:
 * - an observation older than the stored one is rejected; at the same time
 *   it must be identical (otherwise rejected);
 * - an observation absorbs the recorded spends at or before its time (they
 *   are reflected by it); they are reported, never silently dropped;
 * - a spend at or before the latest observation is not applied
 *   ('absorbed-by-observation'); a spend older than the last recorded one
 *   is rejected (OUT_OF_ORDER);
 * - the same operation id with the same payload is reported 'duplicate'
 *   and not applied again; with another payload it is an error;
 * - a recorded spend that a newer observation contradicts (not enough
 *   energy) consumes only what is available and is reported;
 * - regeneration progress across observations: kept when the new
 *   observation matches the prediction (same energy, levels and capacity),
 *   otherwise reset to a pessimistic lower bound — unless reported.
 */

import type {
  AgentId,
  AgentResourceState,
  ObservationResult,
  ResourceManager,
  ResourceObservation,
  ResourceRules,
  SpendRecord,
  SpendResult,
  Timestamp,
} from '../contracts/index.js';
import { advance, consumeEnergy, derivedKind, timeUntilEnergy } from './energy.js';
import { ResourceError, validateRules } from './rules.js';
import { serializeResourceState, stateFromObservation } from './state.js';

interface Entry {
  observed: AgentResourceState;
  /** Spends after the observation, by increasing time. */
  ledger: SpendRecord[];
  /** Every spend id ever seen for this agent, with its payload. */
  known: Map<string, string>;
  /**
   * State right after the last ledger spend (the observation when the
   * ledger is empty): queries at or after it and new spends cost O(1).
   */
  head: AgentResourceState;
}

const payloadOf = (spend: SpendRecord): string => `${spend.energy}@${spend.at}`;

export function createResourceManager(rawRules: ResourceRules): ResourceManager {
  const rules = validateRules(rawRules);
  const entries = new Map<AgentId, Entry>();

  function entryOf(agent: AgentId): Entry {
    const entry = entries.get(agent);
    if (entry === undefined) throw new ResourceError('UNKNOWN_AGENT', `no observation of agent ${agent}`);
    return entry;
  }

  /**
   * Replays the ledger from the observation up to `at` (O(ledger), no
   * copy). A spend larger than the energy then available (only possible
   * when a newer observation contradicts it) consumes what is available:
   * energy never goes negative; `clamped` receives its id.
   */
  function replay(observed: AgentResourceState, ledger: readonly SpendRecord[], at: Timestamp, now: Timestamp, clamped?: string[]): AgentResourceState {
    let state = observed;
    for (const spend of ledger) {
      if (spend.at > at) break;
      const step = consumeEnergy(rules, state, spend.at, spend.energy, now, true);
      if (step.clamped) clamped?.push(spend.operationId);
      state = step.state;
    }
    return state;
  }

  /** Observation + ledger spends up to `at`, regenerated to `at`. */
  function compute(entry: Entry, at: Timestamp, now: Timestamp): AgentResourceState {
    if (at < entry.observed.at) throw new ResourceError('TIME_BEFORE_STATE', `no state before the observation at ${entry.observed.at}`);
    const base = at >= entry.head.at ? entry.head : replay(entry.observed, entry.ledger, at, now);
    return advance(rules, base, at, now);
  }

  const manager: ResourceManager = {
    rules,

    observe(observation: ResourceObservation): ObservationResult {
      let state = stateFromObservation(rules, observation);
      const entry = entries.get(state.agent);
      let regenPhase: ObservationResult['regenPhase'] = observation.regenProgressMs !== undefined ? 'reported' : 'reset-lower-bound';
      if (entry === undefined) {
        entries.set(state.agent, { observed: state, ledger: [], known: new Map(), head: state });
        return { state, absorbedSpends: [], inconsistentSpends: [], regenPhase };
      }
      const previous = entry.observed;
      if (state.observedAt < previous.observedAt) {
        throw new ResourceError('STALE_OBSERVATION', `observation at ${state.observedAt} is older than the stored one at ${previous.observedAt}`);
      }
      if (state.observedAt === previous.observedAt) {
        if (serializeResourceState(state) === serializeResourceState({ ...previous, regenProgressMs: state.regenProgressMs, regenPhase: state.regenPhase })) {
          return { state: previous, absorbedSpends: [], inconsistentSpends: [], regenPhase: 'carried-over' };
        }
        throw new ResourceError('STALE_OBSERVATION', `a different observation at the same time ${state.observedAt} is already stored`);
      }
      if (observation.regenProgressMs === undefined && state.regenPhase === 'lower-bound') {
        // Keep the regeneration progress only if the observation confirms the prediction.
        const predicted = compute(entry, state.observedAt, state.observedAt);
        const same =
          predicted.energy === state.energy &&
          predicted.upgrades.maxEnergy === state.upgrades.maxEnergy &&
          predicted.upgrades.regenSpeed === state.upgrades.regenSpeed;
        if (same) {
          state = { ...state, regenProgressMs: predicted.regenProgressMs, regenPhase: predicted.regenPhase };
          regenPhase = 'carried-over';
        }
      }
      const absorbed = entry.ledger.filter((s) => s.at <= state.observedAt).map((s) => s.operationId);
      const ledger = entry.ledger.filter((s) => s.at > state.observedAt);
      const inconsistent: string[] = [];
      const lastSpend = ledger[ledger.length - 1];
      const head = lastSpend === undefined ? state : replay(state, ledger, lastSpend.at, lastSpend.at, inconsistent);
      entries.set(state.agent, { observed: state, ledger, known: entry.known, head });
      return { state, absorbedSpends: absorbed, inconsistentSpends: inconsistent, regenPhase };
    },

    observed(agent) {
      return entries.get(agent)?.observed;
    },

    stateAt(agent, at, now) {
      return compute(entryOf(agent), at, now);
    },

    recordSpend(agent, spend, now): SpendResult {
      const entry = entryOf(agent);
      if (typeof spend.operationId !== 'string' || spend.operationId.length === 0) throw new ResourceError('INVALID_OPERATION', 'operationId must be a non-empty string');
      if (!Number.isSafeInteger(spend.energy) || spend.energy < 1) throw new ResourceError('INVALID_OPERATION', 'spent energy must be a positive integer');
      if (!Number.isSafeInteger(spend.at) || spend.at < 0) throw new ResourceError('INVALID_OPERATION', 'at must be a non-negative integer timestamp');
      const seen = entry.known.get(spend.operationId);
      if (seen !== undefined) {
        if (seen !== payloadOf(spend)) throw new ResourceError('DUPLICATE_OPERATION', `operation ${spend.operationId} was recorded with another payload`);
        return { status: 'duplicate', state: compute(entry, Math.max(spend.at, entry.observed.at), now) };
      }
      if (spend.at <= entry.observed.observedAt) {
        entry.known.set(spend.operationId, payloadOf(spend));
        return { status: 'absorbed-by-observation', state: compute(entry, entry.observed.at, now) };
      }
      const last = entry.ledger[entry.ledger.length - 1];
      if (last !== undefined && spend.at < last.at) throw new ResourceError('OUT_OF_ORDER', `spend at ${spend.at} is older than the last recorded one at ${last.at}`);
      // In order (checked above): the spend applies to the head, in O(1).
      const before = advance(rules, entry.head, spend.at, now);
      if (spend.energy > before.energy) throw new ResourceError('INSUFFICIENT_ENERGY', `needs ${spend.energy}, the agent has ${before.energy} at ${spend.at}`);
      entry.head = consumeEnergy(rules, entry.head, spend.at, spend.energy, now).state;
      entry.ledger.push({ operationId: spend.operationId, energy: spend.energy, at: spend.at });
      entry.known.set(spend.operationId, payloadOf(spend));
      return { status: 'applied', state: { ...entry.head, kind: derivedKind(entry.head.kind, spend.at, now) } };
    },

    timeUntil(agent, energy, now) {
      return timeUntilEnergy(rules, compute(entryOf(agent), now, now), energy);
    },

    agents() {
      return [...entries.keys()].sort();
    },
  };
  return manager;
}
