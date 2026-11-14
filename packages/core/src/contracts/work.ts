/**
 * Derived work planning, attempts, journal and history. Layer 3.
 *
 * Remaining work is never stored pixel by pixel: it is derived from the
 * template revision, the strategy order and a fresh canvas snapshot (the
 * canvas is the source of truth). Only in-flight attempts, template state and
 * history are persisted.
 */

import type { CanvasSnapshot, PixelWrite, PixelWriteOutcome, ReadWriteCanvasProvider } from './canvas.js';
import type { AgentId, AttemptId, Rgb, TaskId, TemplateId, Timestamp } from './primitives.js';
import type { Template } from './template.js';

export interface WorkPlanner {
  /**
   * Next pixels of a template, in strategy order, that differ from the
   * snapshot, are paintable by the agent and are not in flight. At most
   * `max` items: a bounded window, never the whole template. Deterministic.
   */
  nextBatch(
    template: Template,
    snapshot: CanvasSnapshot,
    max: number,
    canPaint: (color: Rgb) => boolean,
    inFlight: ReadonlySet<TaskId>
  ): readonly PixelWrite[];
}

export type AttemptState = 'leased' | 'started' | 'finished' | 'released' | 'reconciled';

export interface Attempt {
  readonly attemptId: AttemptId;
  readonly agent: AgentId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly writes: readonly PixelWrite[];
  readonly state: AttemptState;
  readonly leasedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly outcomes?: readonly PixelWriteOutcome[];
}

/** Append-only journal entries, one JSON object per line; a torn last line is ignored on load. */
export type JournalEvent =
  | { readonly type: 'leased'; readonly attempt: Attempt }
  | { readonly type: 'started'; readonly attemptId: AttemptId; readonly at: Timestamp }
  | { readonly type: 'finished'; readonly attemptId: AttemptId; readonly outcomes: readonly PixelWriteOutcome[]; readonly at: Timestamp }
  | { readonly type: 'released'; readonly attemptId: AttemptId; readonly reason: string; readonly at: Timestamp }
  | { readonly type: 'reconciled'; readonly attemptId: AttemptId; readonly outcomes: readonly PixelWriteOutcome[]; readonly at: Timestamp };

export interface AttemptJournal {
  /** Replays the journal: open attempts plus the number of discarded trailing bytes (torn write). */
  load(): Promise<{ readonly open: readonly Attempt[]; readonly discardedTailBytes: number }>;
  append(event: JournalEvent): Promise<void>;
  /** Atomically rewrites the journal with the open attempts only (closed ones live in the history). */
  compact(open: readonly Attempt[]): Promise<void>;
}

export interface HistoryEntry {
  readonly at: Timestamp;
  readonly agent: AgentId;
  readonly templateId: TemplateId;
  readonly attemptId: AttemptId;
  readonly applied: number;
  readonly alreadyCorrect: number;
  readonly rejected: number;
  readonly unknown: number;
}

export interface HistoryQuery {
  readonly templateId?: TemplateId;
  readonly agent?: AgentId;
  readonly since?: Timestamp;
  readonly limit: number;
}

/** Separate, rotated, append-only operation history (never compacted away). */
export interface HistoryStore {
  append(entry: HistoryEntry): Promise<void>;
  query(query: HistoryQuery): Promise<readonly HistoryEntry[]>;
}

export interface RecoveryReport {
  readonly released: number;
  readonly reconciled: number;
}

export interface AttemptManager {
  /** Journals a lease; its tasks are excluded from later batches until it closes. */
  lease(agent: AgentId, template: Template, writes: readonly PixelWrite[], now: Timestamp): Promise<Attempt>;
  /** Journaled before the canvas write. */
  markStarted(attemptId: AttemptId, now: Timestamp): Promise<void>;
  finish(attemptId: AttemptId, outcomes: readonly PixelWriteOutcome[], now: Timestamp): Promise<void>;
  release(attemptId: AttemptId, reason: string, now: Timestamp): Promise<void>;
  inFlight(templateId: TemplateId): ReadonlySet<TaskId>;
  /**
   * Restart/crash recovery: leased-but-not-started attempts are released;
   * started-but-not-finished attempts are reconciled against a fresh canvas
   * read, never blindly retried. Resources must then be re-observed.
   */
  recover(canvas: ReadWriteCanvasProvider, now: Timestamp): Promise<RecoveryReport>;
}
