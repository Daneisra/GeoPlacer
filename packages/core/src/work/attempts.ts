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
 *   per data directory (the directory lock is the caller's);
 * - Phase 1B.7: the state is the pure JournalStateBuilder (shared with the
 *   full replay and the checkpoints); closed attempts are kept as summaries;
 *   compaction is refused on a damaged generation;
 * - Phase 1B.8: after damage, every lease carries its evidence (a read
 *   newer than the damage with a valid value at each leased point); an
 *   uncertain attempt closes only when each of its pixels was observed;
 *   automatic compaction by policy.
 */

import type {
  AgentId,
  Attempt,
  AttemptId,
  AttemptJournal,
  AttemptManager,
  AutoCompactionPolicy,
  CanvasPointKey,
  CompactionReport,
  CompactionStatus,
  CanvasSnapshot,
  HistoryEntry,
  HistoryStore,
  JournalEvent,
  JournalLoadReport,
  JournalState,
  JournalStats,
  JournalVisitor,
  LeaseRequest,
  PixelResult,
  PixelWrite,
  PixelWriteOutcome,
  ProjectId,
  RecoveryReport,
  ResourceManager,
  ResourceObservation,
  TemplateId,
  Timestamp,
} from '../contracts/index.js';
import { TRANSPARENT } from '../contracts/index.js';
import { JournalStateBuilder } from './journal-state.js';

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
  | 'EVIDENCE_REQUIRED'
  | 'INCOMPLETE_OBSERVATION'
  | 'JOURNAL_DAMAGED'
  | 'JOURNAL_UNAVAILABLE'
  | 'INVALID_INPUT';

export class AttemptError extends Error {
  readonly code: AttemptErrorCode;

  constructor(code: AttemptErrorCode, message: string) {
    super(message);
    this.name = 'AttemptError';
    this.code = code;
  }
}

const pointKey = (p: { readonly x: number; readonly y: number }): CanvasPointKey => `${p.x},${p.y}`;

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

/** A valid observed value: a 24-bit color or empty (not UNKNOWN, not garbage). */
export function isObservedValue(seen: number): boolean {
  return seen === TRANSPARENT || (Number.isInteger(seen) && seen >= 0 && seen <= 0xffffff);
}

export interface AttemptManagerDeps {
  readonly journal: AttemptJournal;
  readonly history: HistoryStore;
  /** Single source of energy: checked before leasing, spent at finish. */
  readonly resources: ResourceManager;
  /** Must be unique across restarts (e.g. a UUID): ids are never reused. */
  readonly newAttemptId: () => AttemptId;
  /** Automatic compaction (Phase 1B.8); absent or disabled: manual only. */
  readonly autoCompaction?: AutoCompactionPolicy;
}

/** Rough checkpoint size, to check the free space before compacting. */
function estimateCheckpointBytes(state: JournalStateBuilder): number {
  let writes = 0;
  for (const a of state.openAttempts()) writes += a.writes.length;
  return 4096 + writes * 120 + state.openCount * 400 + state.closedCount * 300;
}

export function createAttemptManager(deps: AttemptManagerDeps): AttemptManager {
  const { journal, history, resources } = deps;
  const cost = resources.rules.energy.costPerPixel;
  let state = new JournalStateBuilder();
  const uncertain = new Map<AgentId, Timestamp>();
  let recovered = false;
  /** The loaded generation is damaged: compaction refused (repair first). */
  let damaged = false;
  /** False once the journal is in an unknown state (interrupted publish...). */
  let usable = true;
  let lastCompactionAt: Timestamp | null = null;
  let compaction: CompactionStatus = { lastAt: null, lastReport: null, lastProblem: null, automatic: 0 };
  let queue: Promise<unknown> = Promise.resolve();

  /** One operation at a time: a lease checks overlap against every committed lease; compactions never overlap. */
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  }

  function openOf(id: AttemptId): Attempt {
    const attempt = state.getOpen(id);
    if (attempt !== undefined) return attempt;
    const closed = state.get(id);
    if (closed !== undefined) throw new AttemptError('INVALID_TRANSITION', `attempt ${id} is ${closed.state}`);
    throw new AttemptError('UNKNOWN_ATTEMPT', `unknown attempt ${id}`);
  }

  const isUnloaded = (error: unknown): boolean => (error as { code?: string }).code === 'NOT_LOADED';

  /** Journal first (durable), then the in-memory state. Returns the attempt after the event (complete, even when closed). */
  async function commit(event: JournalEvent): Promise<Attempt> {
    const next = state.peek(event);
    if (typeof next === 'string') throw new AttemptError('INVALID_TRANSITION', next);
    let seq: number;
    try {
      seq = await journal.append(event);
    } catch (error) {
      if (isUnloaded(error)) {
        usable = false;
        throw new AttemptError('JOURNAL_UNAVAILABLE', 'the journal is in an unknown state: restart (recover) to continue');
      }
      throw error;
    }
    state.apply(event, seq);
    return next as Attempt;
  }

  function markUncertain(agent: AgentId, at: Timestamp): void {
    uncertain.set(agent, Math.max(uncertain.get(agent) ?? at, at));
  }

  function guard(): void {
    if (!recovered) throw new AttemptError('NOT_RECOVERED', 'call recover() first (journal not replayed)');
    if (!usable) throw new AttemptError('JOURNAL_UNAVAILABLE', 'the journal is in an unknown state: restart (recover) to continue');
  }

  async function doCompact(now: Timestamp, maxClosedSummaries: number | undefined): Promise<CompactionReport> {
    if (damaged) throw new AttemptError('JOURNAL_DAMAGED', 'the journal generation is damaged: compaction refused, repair it first (journal tool)');
    if (maxClosedSummaries !== undefined) state.purgeClosed(maxClosedSummaries);
    try {
      const report = await journal.compact(state.toState());
      lastCompactionAt = now;
      compaction = { ...compaction, lastAt: now, lastReport: report };
      return report;
    } catch (error) {
      compaction = { ...compaction, lastProblem: { at: now, kind: 'failed', reason: error instanceof Error ? error.message : String(error) } };
      // An interrupted publish can leave the journal unloaded: no more appends until a recovery.
      await journal.stats().catch((e: unknown) => {
        if (isUnloaded(e)) usable = false;
      });
      throw error;
    }
  }

  /** Automatic compaction, after an operation that closed attempts (its own effects already done). */
  async function maybeCompact(now: Timestamp): Promise<void> {
    const p = deps.autoCompaction;
    if (p === undefined || !p.enabled || damaged || !usable) return;
    const stats = await journal.stats();
    const due =
      (p.maxActiveEvents !== undefined && stats.activeEvents >= p.maxActiveEvents) ||
      (p.maxActiveBytes !== undefined && stats.activeBytes >= p.maxActiveBytes) ||
      (p.maxAgeMs !== undefined && lastCompactionAt !== null && now - lastCompactionAt >= p.maxAgeMs && stats.activeEvents > 0);
    if (!due) return;
    const skip = (reason: string): void => {
      compaction = { ...compaction, lastProblem: { at: now, kind: 'skipped', reason } };
    };
    let openWrites = 0;
    for (const a of state.openAttempts()) openWrites += a.writes.length;
    if (p.maxOpenWrites !== undefined && openWrites > p.maxOpenWrites) return skip(`open attempts hold ${openWrites} pixels (> ${p.maxOpenWrites})`);
    if (p.minFreeBytes !== undefined) {
      if (stats.freeBytes === null) return skip('free disk space unknown');
      const needed = p.minFreeBytes + 2 * estimateCheckpointBytes(state);
      if (stats.freeBytes < needed) return skip(`not enough free disk space (${stats.freeBytes} < ${needed} bytes)`);
    }
    try {
      await doCompact(now, p.maxClosedSummaries);
      compaction = { ...compaction, automatic: compaction.automatic + 1 };
    } catch {
      // Recorded in the status; the operation that triggered it already succeeded.
    }
  }

  async function close(id: AttemptId, outcomes: readonly PixelWriteOutcome[], now: Timestamp, failure: string | null, reported: ResourceObservation | undefined): Promise<Attempt> {
    guard();
    const attempt = openOf(id);
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
    await maybeCompact(now);
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

  /** Throws unless `evidence` proves every write point was observed after the damage. */
  function checkEvidence(writes: readonly PixelWrite[], evidence: CanvasSnapshot | undefined): void {
    const damage = state.damage;
    if (damage === null) return;
    if (evidence === undefined) throw new AttemptError('EVIDENCE_REQUIRED', `the journal was damaged at ${damage.at}: a lease needs the canvas read it was planned from`);
    if (evidence.observedAt <= damage.at) throw new AttemptError('EVIDENCE_REQUIRED', `the canvas read (${evidence.observedAt}) is not newer than the damage (${damage.at})`);
    const unseen = writes.filter((w) => !isObservedValue(evidence.get(w.point) as number)).length;
    if (unseen > 0) throw new AttemptError('EVIDENCE_REQUIRED', `${unseen} leased point(s) have no valid value in the canvas read`);
  }

  const manager: AttemptManager = {
    recover: (now) =>
      serialized(async (): Promise<RecoveryReport> => {
        let builder = new JournalStateBuilder();
        let inconsistent = 0;
        const loaded = await journal.load({
          checkpoint(checkpoint) {
            builder = JournalStateBuilder.from(checkpoint);
          },
          event(event, seq) {
            if (builder.apply(event, seq) !== null) inconsistent++;
          },
        });
        state = builder;
        uncertain.clear();
        recovered = true;
        usable = true;
        lastCompactionAt = now;
        // The spends recorded before the restart are gone: every agent that
        // started an attempt needs an observation newer than its last close.
        for (const [agent, at] of state.lastSpendAt()) markUncertain(agent, at);
        damaged = loaded.corruptLines.length > 0 || loaded.sequenceGaps > 0 || loaded.problems.length > 0 || inconsistent > 0;
        if (damaged) {
          // An event may be lost (a lease, a start): from now on every lease
          // needs evidence newer than this, covering its points.
          await commit({ type: 'canvas-read-required', at: now, reason: 'recovered from a damaged journal' });
        }
        const released: AttemptId[] = [];
        const toReconcile: AttemptId[] = [];
        for (const attempt of [...state.openAttempts()]) {
          const id = attempt.attemptId;
          if (attempt.state === 'leased' && !damaged) {
            await cancelOne(id, 'recovered: never started', now);
            released.push(id);
          } else if (attempt.state === 'needs-reconciliation') {
            markUncertain(attempt.agent, now);
            toReconcile.push(id);
          } else {
            // A damaged journal may have lost a "started" event: reconcile rather than assume.
            await toReconciliation(attempt, damaged ? 'recovered from a damaged journal' : 'recovered: result unknown', now);
            toReconcile.push(id);
          }
        }
        return {
          released,
          toReconcile,
          generation: loaded.generation,
          fromCheckpoint: loaded.fromCheckpoint,
          discardedTailBytes: loaded.discardedTailBytes,
          corruptLines: loaded.corruptLines,
          sequenceGaps: loaded.sequenceGaps,
          inconsistentEvents: inconsistent,
          problems: loaded.problems,
          damaged,
          damage: state.damage,
        };
      }),

    lease: (request: LeaseRequest) =>
      serialized(async () => {
        guard();
        const { agent, writes, now, ttlMs } = request;
        if (writes.length === 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now)) {
          throw new AttemptError('INVALID_INPUT', 'a lease needs writes, a positive integer ttl and an integer time');
        }
        const points = writes.map((w) => pointKey(w.point));
        if (new Set(points).size !== points.length) throw new AttemptError('INVALID_INPUT', 'a canvas point appears twice in the batch');
        if (new Set(writes.map((w) => w.taskId)).size !== writes.length) throw new AttemptError('INVALID_INPUT', 'a task id appears twice in the batch');
        checkEvidence(writes, request.evidence);
        const busy = manager.inFlight();
        const overlap = points.filter((p) => busy.has(p)).length;
        if (overlap > 0) throw new AttemptError('OVERLAP', `${overlap} point(s) already in flight: the whole batch is refused`);
        const since = uncertain.get(agent);
        const observed = resources.observed(agent);
        if (since !== undefined && (observed === undefined || observed.observedAt <= since)) {
          throw new AttemptError('RESOURCES_UNCERTAIN', 'an attempt ended with an unknown energy spending: observe the resources again first');
        }
        const resourcesNow = resources.stateAt(agent, now, now);
        if (resourcesNow.availability.status !== 'available') throw new AttemptError('AGENT_UNAVAILABLE', `agent ${agent} is unavailable`);
        const unlocked = new Set(resourcesNow.unlockedColors);
        const locked = writes.filter((w) => !unlocked.has(w.color)).length;
        if (locked > 0) throw new AttemptError('COLOR_LOCKED', `${locked} write(s) use a color the agent has not unlocked`);
        const energyCost = writes.length * cost;
        const available = resourcesNow.energy - manager.committedEnergy(agent);
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
        guard();
        const attempt = openOf(id);
        if (attempt.state === 'leased' && now >= attempt.expiresAt) throw new AttemptError('LEASE_EXPIRED', `attempt ${id} expired at ${attempt.expiresAt}: not started`);
        return commit({ type: 'started', attemptId: id, at: now });
      }),

    finish: (id, outcomes, now, reported) => serialized(() => close(id, outcomes, now, null, reported)),
    fail: (id, reason, outcomes, now, reported) => serialized(() => close(id, outcomes, now, reason, reported)),

    cancel: (id, reason, now) =>
      serialized(async () => {
        guard();
        openOf(id);
        const closed = await cancelOne(id, reason, now);
        await maybeCompact(now);
        return closed;
      }),

    expire: (now) =>
      serialized(async () => {
        guard();
        const changed: Attempt[] = [];
        for (const attempt of [...state.openAttempts()]) {
          if (attempt.expiresAt > now) continue;
          if (attempt.state === 'leased') changed.push(await cancelOne(attempt.attemptId, 'lease expired before start', now));
          else if (attempt.state === 'started') changed.push(await toReconciliation(attempt, 'lease expired after start: result unknown', now));
        }
        if (changed.length > 0) await maybeCompact(now);
        return changed;
      }),

    revisionChanged: (projectId: ProjectId, templateId: TemplateId, revision, now) =>
      serialized(async () => {
        guard();
        const changed: Attempt[] = [];
        for (const attempt of [...state.openAttempts()]) {
          if (attempt.projectId !== projectId || attempt.templateId !== templateId || attempt.revision >= revision) continue;
          if (attempt.state === 'leased') changed.push(await cancelOne(attempt.attemptId, `superseded by revision ${revision}`, now));
          else if (attempt.state === 'started') changed.push(await toReconciliation(attempt, `superseded by revision ${revision} while started`, now));
        }
        if (changed.length > 0) await maybeCompact(now);
        return changed;
      }),

    reconcile: (id, snapshots, now) =>
      serialized(async () => {
        guard();
        const attempt = openOf(id);
        if (attempt.state !== 'started' && attempt.state !== 'needs-reconciliation') throw new AttemptError('INVALID_TRANSITION', `attempt ${id} is ${attempt.state}`);
        const after = Math.max(attempt.startedAt ?? attempt.leasedAt, attempt.needsReconciliationAt ?? 0);
        const reads = (Array.isArray(snapshots) ? snapshots : [snapshots]) as readonly CanvasSnapshot[];
        if (reads.length === 0) throw new AttemptError('INVALID_INPUT', 'reconciliation needs at least one canvas read');
        const stale = reads.filter((r) => r.observedAt <= after).length;
        if (stale > 0) throw new AttemptError('STALE_SNAPSHOT', `reconciliation needs canvas reads taken after ${after} (${stale} older)`);
        // Newest read first: the most recent valid value of each pixel counts.
        const newestFirst = [...reads].sort((a, b) => b.observedAt - a.observedAt);
        const results: { taskId: PixelWrite['taskId']; result: 'observed-correct' | 'observed-incorrect' }[] = [];
        let missing = 0;
        for (const w of attempt.writes) {
          let seen: number | null = null;
          for (const r of newestFirst) {
            const v = r.get(w.point) as number;
            if (isObservedValue(v)) {
              seen = v;
              break;
            }
          }
          if (seen === null) missing++;
          else results.push({ taskId: w.taskId, result: seen === w.color ? 'observed-correct' : 'observed-incorrect' });
        }
        if (missing > 0) {
          throw new AttemptError('INCOMPLETE_OBSERVATION', `${missing} of ${attempt.writes.length} pixel(s) have no valid value in the reads: the attempt stays open`);
        }
        const closed = await commit({ type: 'reconciled', attemptId: id, at: now, results });
        // What this attempt spent is unknown: the resources must be observed again.
        markUncertain(attempt.agent, now);
        await history.append(historyOf(closed, 'reconciled', now));
        await maybeCompact(now);
        return closed;
      }),

    compact: (now, options = {}) =>
      serialized(async () => {
        guard();
        return doCompact(now, options.maxClosedSummaries);
      }),

    get: (id) => state.get(id),
    open: () => [...state.openAttempts()],
    inFlight() {
      const points = new Set<CanvasPointKey>();
      for (const a of state.openAttempts()) for (const w of a.writes) points.add(pointKey(w.point));
      return points;
    },
    committedEnergy(agent) {
      // Needs-reconciliation attempts are covered by the uncertainty rule instead.
      let total = 0;
      for (const a of state.openAttempts()) if (a.agent === agent && (a.state === 'leased' || a.state === 'started')) total += a.energyCost;
      return total;
    },
    resourcesUncertainSince: (agent) => uncertain.get(agent) ?? null,
    damage: () => state.damage,
    state: () => state.toState(),
    compactionStatus: () => compaction,
    usable: () => usable,
  };
  return manager;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * In-memory journal (tests, simulator): same contract as the file journal,
 * not durable. `events` are those of the current generation (after the
 * checkpoint); their sequence numbers follow the checkpoint's. `freeBytes`
 * is what stats() reports (default: effectively unlimited).
 */
export function createMemoryJournal(options: { readonly freeBytes?: number | null } = {}): AttemptJournal & { events: JournalEvent[]; checkpoint: JournalState | null; generation: number } {
  const journal = {
    events: [] as JournalEvent[],
    checkpoint: null as JournalState | null,
    generation: 0,
    async load(visitor: JournalVisitor): Promise<JournalLoadReport> {
      const base = journal.checkpoint?.lastSeq ?? 0;
      if (journal.checkpoint !== null) visitor.checkpoint(copy(journal.checkpoint));
      journal.events.forEach((e, i) => visitor.event(copy(e), base + i + 1));
      return { generation: journal.generation, fromCheckpoint: journal.checkpoint !== null, lastSeq: base + journal.events.length, discardedTailBytes: 0, corruptLines: [], sequenceGaps: 0, problems: [] };
    },
    async stats(): Promise<JournalStats> {
      let bytes = 0;
      for (const e of journal.events) bytes += JSON.stringify(e).length + 30;
      return { generation: journal.generation, activeEvents: journal.events.length, activeBytes: bytes, freeBytes: options.freeBytes === undefined ? Number.MAX_SAFE_INTEGER : options.freeBytes };
    },
    async append(event: JournalEvent): Promise<number> {
      journal.events.push(copy(event));
      return (journal.checkpoint?.lastSeq ?? 0) + journal.events.length;
    },
    async compact(next: JournalState): Promise<CompactionReport> {
      const previousGeneration = journal.generation;
      journal.checkpoint = copy(next);
      journal.events = [];
      journal.generation++;
      return { previousGeneration, generation: journal.generation, lastSeq: next.lastSeq, checkpointBytes: JSON.stringify(next).length, openAttempts: next.open.length, closedSummaries: next.closed.length, removedGenerations: [], retentionPending: [] };
    },
  };
  return journal;
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
