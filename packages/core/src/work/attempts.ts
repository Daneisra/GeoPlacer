/**
 * AttemptManager (Phase 1B.6): attempts with explicit states, journaled
 * BEFORE they take effect, replayed by the same state machine on restart.
 *
 * Guarantees and non-guarantees:
 * - an attempt is leased only if none of its canvas points is in flight
 *   (any template, revision or agent), its colors are unlocked, the agent is
 *   available and its energy is not already committed;
 * - the manager never sends an attempt twice: `started` is journaled BEFORE
 *   the canvas write, so after a crash an attempt whose result is uncertain
 *   is reconciled from a fresh canvas read, never retried blindly. A pixel
 *   is written again only by a NEW attempt planned after the canvas showed
 *   it incorrect;
 * - this is NOT "exactly once": a write whose answer was lost may have been
 *   applied. A writer that honours the attempt id as idempotency key
 *   (CanvasWriter.idempotentWrites) makes a resent attempt harmless, but this
 *   manager does not resend; reconciliation reports what the canvas shows
 *   ("observed-correct"), not proof that this attempt painted it;
 * - the energy of APPLIED pixels is spent once, at finish, with the attempt
 *   id as operation id; an unknown outcome makes the agent's resources
 *   uncertain until a newer observation;
 * - operations of one manager are serialized (one at a time); one manager
 *   per data directory (the directory lock is the caller's).
 */

import type {
  AgentId,
  Attempt,
  AttemptId,
  AttemptJournal,
  AttemptManager,
  CanvasPointKey,
  CanvasSnapshot,
  HistoryEntry,
  HistoryStore,
  JournalEvent,
  LeaseRequest,
  PixelResult,
  PixelWriteOutcome,
  ProjectId,
  RecoveryReport,
  ResourceManager,
  ResourceObservation,
  TemplateId,
  Timestamp,
} from '../contracts/index.js';
import { TRANSPARENT, UNKNOWN } from '../contracts/index.js';

export type AttemptErrorCode =
  | 'NOT_RECOVERED'
  | 'UNKNOWN_ATTEMPT'
  | 'INVALID_TRANSITION'
  | 'OVERLAP'
  | 'INSUFFICIENT_ENERGY'
  | 'RESOURCES_UNCERTAIN'
  | 'AGENT_UNAVAILABLE'
  | 'COLOR_LOCKED'
  | 'LEASE_EXPIRED'
  | 'STALE_SNAPSHOT'
  | 'INVALID_INPUT';

export class AttemptError extends Error {
  readonly code: AttemptErrorCode;

  constructor(code: AttemptErrorCode, message: string) {
    super(message);
    this.name = 'AttemptError';
    this.code = code;
  }
}

const OPEN_STATES: ReadonlySet<Attempt['state']> = new Set(['leased', 'started', 'needs-reconciliation']);
const pointKey = (p: { readonly x: number; readonly y: number }): CanvasPointKey => `${p.x},${p.y}`;
const eventAttemptId = (event: JournalEvent): AttemptId => (event.type === 'leased' ? event.attempt.attemptId : event.attemptId);

/**
 * The state machine: the attempt after `event`, or the reason the event is
 * not a valid transition. Pure; used live and to replay the journal.
 */
export function transition(attempt: Attempt | undefined, event: JournalEvent): Attempt | string {
  if (event.type === 'leased') return attempt === undefined ? event.attempt : `attempt ${event.attempt.attemptId} leased twice`;
  if (attempt === undefined) return `event ${event.type} for unknown attempt ${event.attemptId}`;
  const from = attempt.state;
  const results = (outcomes: readonly PixelWriteOutcome[]): Attempt['results'] => outcomes.map((o) => ({ taskId: o.taskId, result: o.status }));
  switch (event.type) {
    case 'started':
      if (from === 'leased') return { ...attempt, state: 'started', startedAt: event.at };
      break;
    case 'finished':
      if (from === 'started') return { ...attempt, state: 'finished', closedAt: event.at, results: results(event.outcomes) };
      break;
    case 'failed':
      if (from === 'leased' || from === 'started') return { ...attempt, state: 'failed', closedAt: event.at, results: results(event.outcomes), reason: event.reason };
      break;
    case 'cancelled':
      if (from === 'leased') return { ...attempt, state: 'cancelled', closedAt: event.at, reason: event.reason };
      break;
    case 'needs-reconciliation':
      if (from === 'started' || from === 'leased') return { ...attempt, state: 'needs-reconciliation', needsReconciliationAt: event.at, reason: event.reason };
      break;
    case 'reconciled':
      if (from === 'started' || from === 'needs-reconciliation') return { ...attempt, state: 'finished', closedAt: event.at, results: event.results };
      break;
  }
  return `invalid transition ${from} -> ${event.type} for ${event.attemptId}`;
}

export function historyOf(attempt: Attempt, state: HistoryEntry['state'], at: Timestamp): HistoryEntry {
  const count = (r: PixelResult): number => attempt.results.filter((x) => x.result === r).length;
  return {
    at,
    agent: attempt.agent,
    templateId: attempt.templateId,
    revision: attempt.revision,
    attemptId: attempt.attemptId,
    state,
    applied: count('applied'),
    alreadyCorrect: count('already-correct'),
    rejected: count('rejected'),
    unknown: count('unknown') + count('observed-unknown'),
    observedCorrect: count('observed-correct'),
    observedIncorrect: count('observed-incorrect'),
  };
}

function observedResult(seen: number, expected: number): 'observed-correct' | 'observed-incorrect' | 'observed-unknown' {
  if (seen === expected) return 'observed-correct';
  const valid = seen === TRANSPARENT || (Number.isInteger(seen) && seen >= 0 && seen <= 0xffffff);
  return seen === UNKNOWN || !valid ? 'observed-unknown' : 'observed-incorrect';
}

export interface AttemptManagerDeps {
  readonly journal: AttemptJournal;
  readonly history: HistoryStore;
  /** Single source of energy: checked before leasing, spent at finish. */
  readonly resources: ResourceManager;
  /** Must be unique across restarts (e.g. a UUID): ids are never reused. */
  readonly newAttemptId: () => AttemptId;
}

export function createAttemptManager(deps: AttemptManagerDeps): AttemptManager {
  const { journal, history, resources } = deps;
  const cost = resources.rules.energy.costPerPixel;
  const attempts = new Map<AttemptId, Attempt>();
  const open = new Set<AttemptId>();
  const uncertain = new Map<AgentId, Timestamp>();
  let recovered = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** One operation at a time: a lease checks overlap against every committed lease. */
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  }

  function attemptOf(id: AttemptId): Attempt {
    const attempt = attempts.get(id);
    if (attempt === undefined) throw new AttemptError('UNKNOWN_ATTEMPT', `unknown attempt ${id}`);
    return attempt;
  }

  function store(attempt: Attempt): void {
    attempts.set(attempt.attemptId, attempt);
    if (OPEN_STATES.has(attempt.state)) open.add(attempt.attemptId);
    else open.delete(attempt.attemptId);
  }

  /** Journal first (durable), then the in-memory state. */
  async function commit(event: JournalEvent): Promise<Attempt> {
    const next = transition(attempts.get(eventAttemptId(event)), event);
    if (typeof next === 'string') throw new AttemptError('INVALID_TRANSITION', next);
    await journal.append(event);
    store(next);
    return next;
  }

  function markUncertain(agent: AgentId, at: Timestamp): void {
    uncertain.set(agent, Math.max(uncertain.get(agent) ?? at, at));
  }

  function requireRecovered(): void {
    if (!recovered) throw new AttemptError('NOT_RECOVERED', 'call recover() first (journal not replayed)');
  }

  async function close(id: AttemptId, outcomes: readonly PixelWriteOutcome[], now: Timestamp, failure: string | null, reported: ResourceObservation | undefined): Promise<Attempt> {
    requireRecovered();
    const attempt = attemptOf(id);
    const tasks = new Set(attempt.writes.map((w) => w.taskId));
    if (outcomes.some((o) => !tasks.has(o.taskId)) || new Set(outcomes.map((o) => o.taskId)).size !== outcomes.length) {
      throw new AttemptError('INVALID_INPUT', 'outcomes must refer to the attempt tasks, once each');
    }
    if (failure === null && outcomes.length !== attempt.writes.length) throw new AttemptError('INVALID_INPUT', 'a finished attempt needs an outcome for every task');
    if (attempt.state === 'leased' && outcomes.length > 0) throw new AttemptError('INVALID_INPUT', 'an attempt never started has no outcome');
    const closed = await commit(
      failure === null ? { type: 'finished', attemptId: id, at: now, outcomes } : { type: 'failed', attemptId: id, at: now, reason: failure, outcomes },
    );
    const applied = outcomes.filter((o) => o.status === 'applied').length;
    if (reported !== undefined) {
      // Reported with the write result: it includes the spending (never recorded on top).
      try {
        if (reported.agent !== attempt.agent) throw new Error('observation of another agent');
        resources.observe(reported);
      } catch {
        markUncertain(attempt.agent, now);
      }
    } else if (applied > 0) {
      try {
        resources.recordSpend(attempt.agent, { operationId: attempt.attemptId, energy: applied * cost, at: now }, now);
      } catch {
        // The ledger refused it (e.g. contradicted by an observation): the spending is unknown.
        markUncertain(attempt.agent, now);
      }
    }
    // A started attempt whose every pixel is not accounted for: energy spent unknown.
    if (attempt.state === 'started' && (outcomes.some((o) => o.status === 'unknown') || outcomes.length < attempt.writes.length)) markUncertain(attempt.agent, now);
    await history.append(historyOf(closed, failure === null ? 'finished' : 'failed', now));
    return closed;
  }

  async function cancelOne(id: AttemptId, reason: string, now: Timestamp): Promise<Attempt> {
    const closed = await commit({ type: 'cancelled', attemptId: id, at: now, reason });
    await history.append(historyOf(closed, 'cancelled', now));
    return closed;
  }

  async function toReconciliation(attempt: Attempt, reason: string, now: Timestamp): Promise<Attempt> {
    const changed = await commit({ type: 'needs-reconciliation', attemptId: attempt.attemptId, at: now, reason });
    markUncertain(attempt.agent, now);
    return changed;
  }

  const manager: AttemptManager = {
    recover: (now) =>
      serialized(async (): Promise<RecoveryReport> => {
        const loaded = await journal.load();
        attempts.clear();
        open.clear();
        uncertain.clear();
        let inconsistent = 0;
        for (const event of loaded.events) {
          const next = transition(attempts.get(eventAttemptId(event)), event);
          if (typeof next === 'string') inconsistent++;
          else store(next);
        }
        recovered = true;
        // The spends recorded before the restart are gone: every agent that
        // started an attempt needs an observation newer than its last close.
        for (const attempt of attempts.values()) {
          if (attempt.startedAt !== null && attempt.closedAt !== null) markUncertain(attempt.agent, attempt.closedAt);
        }
        const released: AttemptId[] = [];
        const toReconcile: AttemptId[] = [];
        // A damaged journal may have lost a "started" event: reconcile rather than assume.
        const damaged = loaded.corruptLines.length > 0 || inconsistent > 0;
        for (const id of [...open]) {
          const attempt = attemptOf(id);
          if (attempt.state === 'leased' && !damaged) {
            await cancelOne(id, 'recovered: never started', now);
            released.push(id);
          } else if (attempt.state === 'needs-reconciliation') {
            markUncertain(attempt.agent, now);
            toReconcile.push(id);
          } else {
            await toReconciliation(attempt, damaged ? 'recovered from a damaged journal' : 'recovered: result unknown', now);
            toReconcile.push(id);
          }
        }
        return { released, toReconcile, discardedTailBytes: loaded.discardedTailBytes, corruptLines: loaded.corruptLines, inconsistentEvents: inconsistent };
      }),

    lease: (request: LeaseRequest) =>
      serialized(async () => {
        requireRecovered();
        const { agent, writes, now, ttlMs } = request;
        if (writes.length === 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now)) {
          throw new AttemptError('INVALID_INPUT', 'a lease needs writes, a positive integer ttl and an integer time');
        }
        const points = writes.map((w) => pointKey(w.point));
        if (new Set(points).size !== points.length) throw new AttemptError('INVALID_INPUT', 'a canvas point appears twice in the batch');
        if (new Set(writes.map((w) => w.taskId)).size !== writes.length) throw new AttemptError('INVALID_INPUT', 'a task id appears twice in the batch');
        const busy = manager.inFlight();
        const overlap = points.filter((p) => busy.has(p)).length;
        if (overlap > 0) throw new AttemptError('OVERLAP', `${overlap} point(s) already in flight: the whole batch is refused`);
        const since = uncertain.get(agent);
        const observed = resources.observed(agent);
        if (since !== undefined && (observed === undefined || observed.observedAt <= since)) {
          throw new AttemptError('RESOURCES_UNCERTAIN', 'an attempt ended with an unknown energy spending: observe the resources again first');
        }
        const state = resources.stateAt(agent, now, now);
        if (state.availability.status !== 'available') throw new AttemptError('AGENT_UNAVAILABLE', `agent ${agent} is unavailable`);
        const unlocked = new Set(state.unlockedColors);
        const locked = writes.filter((w) => !unlocked.has(w.color)).length;
        if (locked > 0) throw new AttemptError('COLOR_LOCKED', `${locked} write(s) use a color the agent has not unlocked`);
        const energyCost = writes.length * cost;
        const available = state.energy - manager.committedEnergy(agent);
        if (energyCost > available) throw new AttemptError('INSUFFICIENT_ENERGY', `needs ${energyCost}, ${available} available after open attempts`);
        return commit({
          type: 'leased',
          attempt: {
            attemptId: deps.newAttemptId(),
            agent,
            projectId: request.projectId,
            templateId: request.templateId,
            revision: request.revision,
            writes: writes.map((w) => ({ taskId: w.taskId, point: { x: w.point.x, y: w.point.y }, color: w.color })),
            energyCost,
            state: 'leased',
            leasedAt: now,
            expiresAt: now + ttlMs,
            startedAt: null,
            needsReconciliationAt: null,
            closedAt: null,
            results: [],
            reason: null,
          },
        });
      }),

    start: (id, now) =>
      serialized(async () => {
        requireRecovered();
        const attempt = attemptOf(id);
        if (attempt.state === 'leased' && now >= attempt.expiresAt) throw new AttemptError('LEASE_EXPIRED', `attempt ${id} expired at ${attempt.expiresAt}: not started`);
        return commit({ type: 'started', attemptId: id, at: now });
      }),

    finish: (id, outcomes, now, reported) => serialized(() => close(id, outcomes, now, null, reported)),
    fail: (id, reason, outcomes, now, reported) => serialized(() => close(id, outcomes, now, reason, reported)),

    cancel: (id, reason, now) =>
      serialized(async () => {
        requireRecovered();
        return cancelOne(id, reason, now);
      }),

    expire: (now) =>
      serialized(async () => {
        requireRecovered();
        const changed: Attempt[] = [];
        for (const id of [...open]) {
          const attempt = attemptOf(id);
          if (attempt.expiresAt > now) continue;
          if (attempt.state === 'leased') changed.push(await cancelOne(id, 'lease expired before start', now));
          else if (attempt.state === 'started') changed.push(await toReconciliation(attempt, 'lease expired after start: result unknown', now));
        }
        return changed;
      }),

    revisionChanged: (projectId: ProjectId, templateId: TemplateId, revision, now) =>
      serialized(async () => {
        requireRecovered();
        const changed: Attempt[] = [];
        for (const id of [...open]) {
          const attempt = attemptOf(id);
          if (attempt.projectId !== projectId || attempt.templateId !== templateId || attempt.revision >= revision) continue;
          if (attempt.state === 'leased') changed.push(await cancelOne(id, `superseded by revision ${revision}`, now));
          else if (attempt.state === 'started') changed.push(await toReconciliation(attempt, `superseded by revision ${revision} while started`, now));
        }
        return changed;
      }),

    reconcile: (id, snapshot: CanvasSnapshot, now) =>
      serialized(async () => {
        requireRecovered();
        const attempt = attemptOf(id);
        if (attempt.state !== 'started' && attempt.state !== 'needs-reconciliation') throw new AttemptError('INVALID_TRANSITION', `attempt ${id} is ${attempt.state}`);
        const after = Math.max(attempt.startedAt ?? attempt.leasedAt, attempt.needsReconciliationAt ?? 0);
        if (snapshot.observedAt <= after) throw new AttemptError('STALE_SNAPSHOT', `reconciliation needs a canvas read taken after ${after}`);
        const results = attempt.writes.map((w) => ({ taskId: w.taskId, result: observedResult(snapshot.get(w.point) as number, w.color) }));
        const closed = await commit({ type: 'reconciled', attemptId: id, at: now, results });
        // What this attempt spent is unknown: the resources must be observed again.
        markUncertain(attempt.agent, now);
        await history.append(historyOf(closed, 'reconciled', now));
        return closed;
      }),

    get: (id) => attempts.get(id),
    open: () => [...open].map(attemptOf),
    inFlight() {
      const points = new Set<CanvasPointKey>();
      for (const id of open) for (const w of attemptOf(id).writes) points.add(pointKey(w.point));
      return points;
    },
    committedEnergy(agent) {
      // Needs-reconciliation attempts are covered by the uncertainty rule instead.
      let total = 0;
      for (const id of open) {
        const a = attemptOf(id);
        if (a.agent === agent && (a.state === 'leased' || a.state === 'started')) total += a.energyCost;
      }
      return total;
    },
    resourcesUncertainSince: (agent) => uncertain.get(agent) ?? null,
  };
  return manager;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory journal (tests, simulator): same contract as the file journal, not durable. */
export function createMemoryJournal(): AttemptJournal & { readonly events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return {
    events,
    async load() {
      return { events: events.map(copy), discardedTailBytes: 0, corruptLines: [] };
    },
    async append(event) {
      events.push(copy(event));
    },
  };
}

/** In-memory history store (tests, simulator). */
export function createMemoryHistory(): HistoryStore & { readonly entries: HistoryEntry[] } {
  const entries: HistoryEntry[] = [];
  return {
    entries,
    async append(entry) {
      entries.push({ ...entry });
    },
    async query(q) {
      return entries
        .filter((e) => (q.templateId === undefined || e.templateId === q.templateId) && (q.agent === undefined || e.agent === q.agent) && (q.since === undefined || e.at >= q.since))
        .slice(-q.limit);
    },
  };
}
