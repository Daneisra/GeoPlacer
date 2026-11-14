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
import { advance, applyOperation, derivedKind, timeUntilEnergy } from './energy.js';
import { ResourceError, validateRules } from './rules.js';
import { serializeResourceState, stateFromObservation } from './state.js';

interface Entry {
  observed: AgentResourceState;
  /** Spends after the observation, by increasing time. */
  ledger: SpendRecord[];
  /** Every spend id ever seen for this agent, with its payload. */
  known: Map<string, string>;
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
   * Observation + ledger spends up to `at`, regenerated to `at`. A spend
   * larger than the energy then available (only possible when a newer
   * observation contradicts it) consumes what is available: energy never
   * goes negative; `clamped` receives its id.
   */
  function compute(entry: Entry, at: Timestamp, now: Timestamp, clamped?: string[]): AgentResourceState {
    if (at < entry.observed.at) throw new ResourceError('TIME_BEFORE_STATE', `no state before the observation at ${entry.observed.at}`);
    let state = entry.observed;
    for (const spend of entry.ledger) {
      if (spend.at > at) break;
      const current = advance(rules, state, spend.at, now);
      const amount = Math.min(spend.energy, current.energy);
      if (amount < spend.energy) clamped?.push(spend.operationId);
      state =
        amount > 0
          ? applyOperation(rules, current, { type: 'spend', id: spend.operationId, at: spend.at, energy: amount }, now, 'recorded')
          : { ...current, operations: [...current.operations, spend.operationId] };
    }
    return advance(rules, state, at, now);
  }

  const manager: ResourceManager = {
    rules,

    observe(observation: ResourceObservation): ObservationResult {
      let state = stateFromObservation(rules, observation);
      const entry = entries.get(state.agent);
      let regenPhase: ObservationResult['regenPhase'] = observation.regenProgressMs !== undefined ? 'reported' : 'reset-lower-bound';
      if (entry === undefined) {
        entries.set(state.agent, { observed: state, ledger: [], known: new Map() });
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
      const updated: Entry = { observed: state, ledger: entry.ledger.filter((s) => s.at > state.observedAt), known: entry.known };
      entries.set(state.agent, updated);
      const inconsistent: string[] = [];
      const lastSpend = updated.ledger[updated.ledger.length - 1];
      if (lastSpend !== undefined) compute(updated, lastSpend.at, lastSpend.at, inconsistent);
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
      const before = compute(entry, spend.at, now);
      if (spend.energy > before.energy) throw new ResourceError('INSUFFICIENT_ENERGY', `needs ${spend.energy}, the agent has ${before.energy} at ${spend.at}`);
      entry.ledger.push({ operationId: spend.operationId, energy: spend.energy, at: spend.at });
      entry.known.set(spend.operationId, payloadOf(spend));
      const after = compute(entry, spend.at, now);
      return { status: 'applied', state: { ...after, kind: derivedKind(after.kind, spend.at, now) } };
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
