/**
 * Logical state of the attempts (Phase 1B.7): one pure reducer used live by
 * the AttemptManager, to replay a whole journal, and to continue from a
 * checkpoint. "Checkpoint + later events" and "full replay" go through the
 * same code, which is what makes them equivalent.
 */

import type { AgentId, Attempt, AttemptId, ClosedAttempt, JournalDamage, JournalEvent, JournalState, PixelWriteOutcome, Timestamp } from '../contracts/index.js';

export const OPEN_STATES: ReadonlySet<Attempt['state']> = new Set(['leased', 'started', 'needs-reconciliation']);

export const eventAttemptId = (event: JournalEvent): AttemptId | null =>
  event.type === 'leased' ? event.attempt.attemptId : event.type === 'canvas-read-required' || event.type === 'canvas-verified' ? null : event.attemptId;

/**
 * The attempt state machine: the attempt after `event`, or the reason the
 * event is not a valid transition. Pure.
 */
export function transition(attempt: Attempt | undefined, event: JournalEvent): Attempt | string {
  if (event.type === 'canvas-read-required' || event.type === 'canvas-verified') return `${event.type} is not an attempt event`;
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

/** Summary of a closed attempt. */
export function summarize(attempt: Attempt): ClosedAttempt {
  if (OPEN_STATES.has(attempt.state) || attempt.closedAt === null) throw new Error(`attempt ${attempt.attemptId} is not closed`);
  let applied = 0;
  let reconciled = false;
  for (const r of attempt.results) {
    if (r.result === 'applied') applied++;
    else if (r.result === 'observed-correct' || r.result === 'observed-incorrect' || r.result === 'observed-unknown') reconciled = true;
  }
  return {
    attemptId: attempt.attemptId,
    agent: attempt.agent,
    projectId: attempt.projectId,
    templateId: attempt.templateId,
    revision: attempt.revision,
    state: attempt.state as ClosedAttempt['state'],
    leasedAt: attempt.leasedAt,
    startedAt: attempt.startedAt,
    closedAt: attempt.closedAt,
    pixels: attempt.writes.length,
    applied,
    reconciled,
  };
}

const byClose = (a: ClosedAttempt, b: ClosedAttempt): number => a.closedAt - b.closedAt || (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0);
const byLease = (a: Attempt, b: Attempt): number => a.leasedAt - b.leasedAt || (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0);

export class JournalStateBuilder {
  private readonly openMap = new Map<AttemptId, Attempt>();
  private readonly closedMap = new Map<AttemptId, ClosedAttempt>();
  private readonly lastSpend = new Map<AgentId, Timestamp>();
  private readonly preserved = new Set<number>();
  private seq = 0;
  private purged = 0;
  private damageFloor: JournalDamage | null = null;

  static from(state: JournalState): JournalStateBuilder {
    const b = new JournalStateBuilder();
    for (const a of state.open) b.openMap.set(a.attemptId, a);
    for (const c of state.closed) b.closedMap.set(c.attemptId, c);
    for (const { agent, at } of state.lastSpendAt) b.lastSpend.set(agent, at);
    for (const g of state.preservedGenerations) b.preserved.add(g);
    b.seq = state.lastSeq;
    b.purged = state.purgedClosed;
    b.damageFloor = state.damage;
    return b;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** The attempt after `event` (closed or not), null for a state event, or the reason it is invalid. No change. */
  peek(event: JournalEvent): Attempt | null | string {
    if (event.type === 'canvas-read-required') return Number.isSafeInteger(event.at) ? null : 'invalid time';
    // Phase 1B.7 event, still accepted when replayed, without effect since 1B.8:
    // a timestamp alone never lifts the damage.
    if (event.type === 'canvas-verified') return null;
    const id = eventAttemptId(event)!;
    if (this.closedMap.has(id)) return event.type === 'leased' ? `attempt ${id} leased twice` : `event ${event.type} for closed attempt ${id}`;
    return transition(this.openMap.get(id), event);
  }

  /** Applies `event` (sequence number `seq`, or the next one); returns the reason when it is not valid (state unchanged, sequence advanced). */
  apply(event: JournalEvent, seq: number | null = null): string | null {
    const next = this.peek(event);
    this.seq = seq ?? this.seq + 1;
    if (typeof next === 'string') return next;
    if (next === null) {
      if (event.type === 'canvas-read-required' && (this.damageFloor === null || event.at >= this.damageFloor.at)) this.damageFloor = { at: event.at, reason: event.reason };
      return null;
    }
    if (OPEN_STATES.has(next.state)) this.openMap.set(next.attemptId, next);
    else {
      this.openMap.delete(next.attemptId);
      this.closedMap.set(next.attemptId, summarize(next));
      if (next.startedAt !== null) this.lastSpend.set(next.agent, Math.max(this.lastSpend.get(next.agent) ?? 0, next.closedAt!));
    }
    return null;
  }

  get(id: AttemptId): Attempt | ClosedAttempt | undefined {
    return this.openMap.get(id) ?? this.closedMap.get(id);
  }

  getOpen(id: AttemptId): Attempt | undefined {
    return this.openMap.get(id);
  }

  openAttempts(): IterableIterator<Attempt> {
    return this.openMap.values();
  }

  get openCount(): number {
    return this.openMap.size;
  }

  get closedCount(): number {
    return this.closedMap.size;
  }

  lastSpendAt(): ReadonlyMap<AgentId, Timestamp> {
    return this.lastSpend;
  }

  /** Damage floor (null: none): never lifted by a timestamp. */
  get damage(): JournalDamage | null {
    return this.damageFloor;
  }

  preserveGeneration(generation: number): void {
    this.preserved.add(generation);
  }

  /** Drops the oldest closed summaries beyond `max` (their uncertainty is kept in lastSpendAt). */
  purgeClosed(max: number): number {
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('maxClosedSummaries must be a non-negative integer');
    const excess = this.closedMap.size - max;
    if (excess <= 0) return 0;
    const oldest = [...this.closedMap.values()].sort(byClose).slice(0, excess);
    for (const c of oldest) this.closedMap.delete(c.attemptId);
    this.purged += excess;
    return excess;
  }

  toState(): JournalState {
    return {
      schemaVersion: 2,
      lastSeq: this.seq,
      open: [...this.openMap.values()].sort(byLease),
      closed: [...this.closedMap.values()].sort(byClose),
      purgedClosed: this.purged,
      lastSpendAt: [...this.lastSpend.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([agent, at]) => ({ agent, at })),
      damage: this.damageFloor,
      preservedGenerations: [...this.preserved].sort((a, b) => a - b),
    };
  }
}

/** Replays events from an optional checkpoint: the reference "full replay". */
export function replayJournal(checkpoint: JournalState | null, events: readonly { readonly event: JournalEvent; readonly seq: number | null }[]): { readonly state: JournalState; readonly inconsistent: number } {
  const builder = checkpoint === null ? new JournalStateBuilder() : JournalStateBuilder.from(checkpoint);
  let inconsistent = 0;
  for (const { event, seq } of events) if (builder.apply(event, seq) !== null) inconsistent++;
  return { state: builder.toState(), inconsistent };
}
