/**
 * Derived work planning, attempts, journal and history. Layer 4.
 *
 * Remaining work is never stored pixel by pixel: it is derived from the
 * template revision, the strategy order (order keys) and a canvas snapshot
 * (the canvas is the source of truth). Only attempts (journal) and history
 * are persisted.
 *
 * Phase 1B.6 (contracts v7): planning by order keys with an explicit policy
 * for unknown pixels and stale data; attempts with explicit states and
 * reconciliation; no promise of exactly-once execution.
 *
 * Phase 1B.7 (contracts v8): sequence numbers, checkpoints and journal
 * generations (compaction), closed attempts kept as summaries, canvas read
 * required after damage.
 *
 * Phase 1B.8 (contracts v9): after damage, a timestamp alone never
 * suffices: every lease carries its evidence (a canvas read newer than the
 * damage in which each leased point has a valid value), and an uncertain
 * attempt closes only when each of its pixels was observed; journal
 * statistics and automatic compaction.
 */

import type { CanvasSnapshot, CanvasSource, PixelWrite, PixelWriteOutcome } from './canvas.js';
import type { AgentId, AttemptId, ProjectId, Rgb, TemplateId, Timestamp } from './primitives.js';
import type { FreshnessPolicy, ProgressBasis } from './progress.js';
import type { AgentResourceState, ResourceObservation, ResourceRules } from './resources.js';
import type { Template } from './template.js';

// ───────────────────────── Work planner ─────────────────────────

/** What to do with pixels the snapshot cannot tell: never treated as correct. */
export type UnknownPixelPolicy =
  /** Leave them alone until observed (default choice of callers that cannot risk a useless write). */
  | 'skip'
  /** Paint them as if incorrect (pessimistic: may repaint a correct pixel). */
  | 'include';

/** Canvas point key used for in-flight work: `${x},${y}` (whatever template, revision or color). */
export type CanvasPointKey = string;

export interface PlanRequest {
  readonly agent: AgentId;
  readonly snapshot: CanvasSnapshot;
  /** The agent's resource state at `now` (from the ResourceManager: single source of energy). */
  readonly resources: AgentResourceState;
  readonly rules: ResourceRules;
  /** Upper bound of the batch (EngineConfig.maxBatchSize). */
  readonly maxBatch: number;
  /** Canvas points of every open attempt (any agent, template or revision): never offered again. */
  readonly inFlight: ReadonlySet<CanvasPointKey>;
  /** Energy already committed by the agent's open attempts. */
  readonly committedEnergy: number;
  readonly unknownPixels: UnknownPixelPolicy;
  /** Freshness policy by snapshot source (stale or future snapshots are refused). */
  readonly freshness?: Readonly<Partial<Record<CanvasSource, FreshnessPolicy>>>;
  /** Maximum age of the resource observation (exceeded: refused). */
  readonly maxResourceAgeMs?: number;
  /**
   * Time of the agent's last attempt with an uncertain result: its energy
   * spent is unknown, so planning waits for a resource observation newer
   * than it.
   */
  readonly resourcesUncertainSince?: Timestamp | null;
  /**
   * Phase 1B.8: damage floor of the journal (AttemptManager.damage()). A
   * snapshot taken at or before it is refused, and unknown pixels are never
   * proposed while it is set, whatever the policy.
   */
  readonly damageFloor?: Timestamp | null;
  readonly now: Timestamp;
}

export type PlanRefusalCode =
  | 'STALE_SNAPSHOT'
  | 'FUTURE_SNAPSHOT'
  | 'COORDINATE_SYSTEM_MISMATCH'
  | 'INVALID_RESOURCES'
  | 'STALE_RESOURCES'
  | 'RESOURCES_UNCERTAIN'
  | 'AGENT_UNAVAILABLE'
  | 'SNAPSHOT_BEFORE_DAMAGE'
  | 'INVALID_REQUEST';

export interface PlanResult {
  /**
   * ok: writes proposed; waiting: work exists but the energy budget is 0;
   * nothing-to-do: no candidate (all correct, unknown skipped, colors
   * unavailable or in flight); refused: see refusals (no writes).
   */
  readonly status: 'ok' | 'waiting' | 'nothing-to-do' | 'refused';
  /** In strategy order; ids are deterministic. */
  readonly writes: readonly PixelWrite[];
  readonly refusals: readonly { readonly code: PlanRefusalCode; readonly message: string }[];
  /** Pixels that could be painted now by this agent (before the batch limit). */
  readonly candidates: number;
  /** Pixels per color the agent cannot paint (not unlocked). */
  readonly unavailableColors: readonly { readonly color: Rgb; readonly pixels: number }[];
  readonly skippedInFlight: number;
  readonly skippedUnknown: number;
  /** Pixels affordable now: floor((energy - committed) / cost). */
  readonly budget: number;
  /** When `waiting`: milliseconds until one more pixel is affordable (null: never by regeneration). */
  readonly waitMs: number | null;
  readonly warnings: readonly string[];
  readonly basis: ProgressBasis | null;
}

/** A template prepared for planning: order keys built once per revision and strategy. */
export interface PreparedTemplate {
  readonly template: Template;
  /** Where the random order came from ('computed' for the other strategies). */
  readonly keySource: 'computed' | 'cache' | 'generated';
  readonly keyProblem: string | null;
  /** Bytes held by the keys (rank table of the random strategy). */
  readonly keyBytes: number;
}

export interface WorkPlanner {
  /**
   * Next pixels of a template in strategy order that are incorrect (or
   * unknown, by policy) in the snapshot, paintable by the agent, not in
   * flight, within the energy budget. Deterministic; scans the template,
   * never generates the full order.
   */
  nextBatch(prepared: PreparedTemplate, request: PlanRequest): PlanResult;
}

// ───────────────────────── Attempts ─────────────────────────

/**
 * leased: reserved, not sent; started: sent to the canvas writer (result
 * possibly unknown); finished / failed / cancelled: closed;
 * needs-reconciliation: started but its result is uncertain (crash,
 * expired lease, unknown outcome): only a fresh canvas read can close it.
 */
export type AttemptState = 'leased' | 'started' | 'finished' | 'failed' | 'cancelled' | 'needs-reconciliation';

/** Result of one pixel once the attempt is closed. */
export type PixelResult =
  | PixelWriteOutcome['status']
  /** Reconciliation: the canvas shows the expected color (not proof that THIS attempt painted it). */
  | 'observed-correct'
  | 'observed-incorrect'
  | 'observed-unknown';

export interface Attempt {
  readonly attemptId: AttemptId;
  readonly agent: AgentId;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly writes: readonly PixelWrite[];
  /** Energy committed by the attempt (writes x costPerPixel). */
  readonly energyCost: number;
  readonly state: AttemptState;
  readonly leasedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly startedAt: Timestamp | null;
  /**
   * When the attempt was sent to reconciliation (crash, expiry, revision
   * change): only a canvas read taken AFTER this time can close it.
   */
  readonly needsReconciliationAt: Timestamp | null;
  readonly closedAt: Timestamp | null;
  readonly results: readonly { readonly taskId: PixelWrite['taskId']; readonly result: PixelResult }[];
  readonly reason: string | null;
}

/** Append-only journal entries (one checksummed line each, with a sequence number). */
export type JournalEvent =
  | { readonly type: 'leased'; readonly attempt: Attempt }
  | { readonly type: 'started'; readonly attemptId: AttemptId; readonly at: Timestamp }
  | { readonly type: 'finished'; readonly attemptId: AttemptId; readonly at: Timestamp; readonly outcomes: readonly PixelWriteOutcome[] }
  | { readonly type: 'failed'; readonly attemptId: AttemptId; readonly at: Timestamp; readonly reason: string; readonly outcomes: readonly PixelWriteOutcome[] }
  | { readonly type: 'cancelled'; readonly attemptId: AttemptId; readonly at: Timestamp; readonly reason: string }
  | { readonly type: 'needs-reconciliation'; readonly attemptId: AttemptId; readonly at: Timestamp; readonly reason: string }
  | {
      readonly type: 'reconciled';
      readonly attemptId: AttemptId;
      readonly at: Timestamp;
      readonly results: readonly { readonly taskId: PixelWrite['taskId']; readonly result: 'observed-correct' | 'observed-incorrect' | 'observed-unknown' }[];
    }
  /**
   * The journal was found damaged at `at`: from then on every lease must
   * carry evidence newer than the damage (Phase 1B.8; in 1B.7: a newer read).
   */
  | { readonly type: 'canvas-read-required'; readonly at: Timestamp; readonly reason: string }
  /**
   * Phase 1B.7 only (still read): a read that lifted the requirement. Since
   * Phase 1B.8 it has NO effect: a timestamp alone never lifts the damage.
   */
  | { readonly type: 'canvas-verified'; readonly at: Timestamp; readonly observedAt: Timestamp };

/**
 * A closed attempt kept as a summary (Phase 1B.7): no pixels, so that the
 * memory and the checkpoints stay small. Retained up to a configurable
 * number; the journal generations and the history keep the details.
 */
export interface ClosedAttempt {
  readonly attemptId: AttemptId;
  readonly agent: AgentId;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly state: 'finished' | 'failed' | 'cancelled';
  readonly leasedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly closedAt: Timestamp;
  readonly pixels: number;
  /** Pixels reported applied (energy spent through the ResourceManager, operation id = attempt id). */
  readonly applied: number;
  /** Closed by reconciliation (observed results, spending unknown). */
  readonly reconciled: boolean;
}

/**
 * Logical state of the attempts (Phase 1B.7): what a full replay of the
 * journal produces, and what a checkpoint stores. Rebuilding from a
 * checkpoint plus the later events must give the same state.
 */
/** Damage seen in the journal: a floor for every later lease and plan (Phase 1B.8). */
export interface JournalDamage {
  readonly at: Timestamp;
  readonly reason: string;
}

export interface JournalState {
  /** 2 since Phase 1B.8 (a schema-1 checkpoint is read and converted). */
  readonly schemaVersion: 2;
  /** Sequence number of the last event included (0: none). */
  readonly lastSeq: number;
  /** Open attempts, complete (leased, started, needs-reconciliation), by attempt id. */
  readonly open: readonly Attempt[];
  /** Retained summaries of closed attempts, by close time then id. */
  readonly closed: readonly ClosedAttempt[];
  /** Closed summaries dropped by the retention (never their uncertainty, kept below). */
  readonly purgedClosed: number;
  /**
   * Per agent: last close of an attempt that was started. The spends
   * recorded in memory do not survive a restart: after a recovery, the
   * agent needs a resource observation newer than this. Explicit, so that
   * it survives the retention of the summaries.
   */
  readonly lastSpendAt: readonly { readonly agent: AgentId; readonly at: Timestamp }[];
  /**
   * Damage seen (null: none). It is never lifted by a timestamp: every
   * lease must carry evidence newer than it, covering each leased point.
   */
  readonly damage: JournalDamage | null;
  /** Damaged journal generations: never deleted by the retention. */
  readonly preservedGenerations: readonly number[];
}

/** Receives the recovered state: at most one checkpoint, then the later events in order. */
export interface JournalVisitor {
  checkpoint(state: JournalState): void;
  /** `seq` is null for a line written before Phase 1B.7 (no sequence number). */
  event(event: JournalEvent, seq: number | null): void;
}

export interface JournalLoadReport {
  /** Generation read (0: the journal of Phase 1B.6, without checkpoint). */
  readonly generation: number;
  readonly fromCheckpoint: boolean;
  /** Last sequence number seen (checkpoint or events). */
  readonly lastSeq: number;
  /** A torn last line (interrupted append): ignored. */
  readonly discardedTailBytes: number;
  /** Damaged lines BEFORE the end (checksum or format): reported, never silently skipped. */
  readonly corruptLines: readonly number[];
  /** Missing or out-of-order sequence numbers. */
  readonly sequenceGaps: number;
  /** Other damage that makes the state uncertain (e.g. checkpoint fallback). */
  readonly problems: readonly string[];
}

export interface CompactionReport {
  readonly previousGeneration: number;
  readonly generation: number;
  readonly lastSeq: number;
  readonly checkpointBytes: number;
  readonly openAttempts: number;
  readonly closedSummaries: number;
  /** Older generations deleted by the retention. */
  readonly removedGenerations: readonly number[];
  /** Deletions that failed: retried at the next compaction (never fatal). */
  readonly retentionPending: readonly number[];
}

/** Size of the active generation (Phase 1B.8: automatic compaction). */
export interface JournalStats {
  readonly generation: number;
  /** Events and bytes of the active generation (since its checkpoint), counted from the load on. */
  readonly activeEvents: number;
  readonly activeBytes: number;
  /** Free space where the journal is written; null when unknown (never assumed enough). */
  readonly freeBytes: number | null;
}

export interface AttemptJournal {
  load(visitor: JournalVisitor): Promise<JournalLoadReport>;
  stats(): Promise<JournalStats>;
  /** Durable before returning (the attempt state machine relies on it); returns the sequence number. */
  append(event: JournalEvent): Promise<number>;
  /**
   * Writes `state` as the checkpoint of a new generation, publishes it, then
   * applies the retention. Never deletes data before the new generation is
   * verified and published; an interruption leaves the previous one in use.
   * Appends and compactions of one journal never overlap (serialized).
   */
  compact(state: JournalState): Promise<CompactionReport>;
}

export interface HistoryEntry {
  readonly at: Timestamp;
  readonly agent: AgentId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly attemptId: AttemptId;
  readonly state: 'finished' | 'failed' | 'cancelled' | 'reconciled';
  readonly applied: number;
  readonly alreadyCorrect: number;
  readonly rejected: number;
  readonly unknown: number;
  readonly observedCorrect: number;
  readonly observedIncorrect: number;
}

export interface HistoryQuery {
  readonly templateId?: TemplateId;
  readonly agent?: AgentId;
  readonly since?: Timestamp;
  readonly limit: number;
}

/** Separate, append-only operation history (never compacted away). */
export interface HistoryStore {
  append(entry: HistoryEntry): Promise<void>;
  query(query: HistoryQuery): Promise<readonly HistoryEntry[]>;
}

export interface LeaseRequest {
  readonly agent: AgentId;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly writes: readonly PixelWrite[];
  readonly now: Timestamp;
  readonly ttlMs: number;
  /**
   * Phase 1B.8: the canvas read the batch was planned from. Required while
   * the journal is damaged: newer than the damage, with a valid value at
   * every leased point.
   */
  readonly evidence?: CanvasSnapshot;
}

export interface RecoveryReport {
  /** Leased, never started: cancelled (nothing was sent). */
  readonly released: readonly AttemptId[];
  /** Started without a closing event: to reconcile against a fresh canvas read. */
  readonly toReconcile: readonly AttemptId[];
  readonly generation: number;
  readonly fromCheckpoint: boolean;
  readonly discardedTailBytes: number;
  readonly corruptLines: readonly number[];
  readonly sequenceGaps: number;
  /** Journal events that were not valid transitions (ignored, reported). */
  readonly inconsistentEvents: number;
  readonly problems: readonly string[];
  /** Damage of any kind: open attempts are reconciled, compaction is refused. */
  readonly damaged: boolean;
  /** Damage floor (null: none): leases then need evidence newer than it. */
  readonly damage: JournalDamage | null;
}

export interface CompactOptions {
  /** Closed summaries kept (oldest dropped first); default: all. */
  readonly maxClosedSummaries?: number;
}

/**
 * Automatic compaction (Phase 1B.8). Checked after an operation that
 * closes attempts, inside the manager's serialized queue (never two at a
 * time), never during recovery, never on a damaged journal.
 */
export interface AutoCompactionPolicy {
  /** false: manual compaction only (diagnostics). */
  readonly enabled: boolean;
  /** Compact when the active generation holds at least this many events... */
  readonly maxActiveEvents?: number;
  /** ...or this many bytes... */
  readonly maxActiveBytes?: number;
  /** ...or when the last checkpoint (or the recovery) is older than this. */
  readonly maxAgeMs?: number;
  /** Skip while the open attempts hold more pixels than this (the checkpoint would not shrink). */
  readonly maxOpenWrites?: number;
  /** Skip unless the free space is known and at least this plus twice the estimated checkpoint. */
  readonly minFreeBytes?: number;
  readonly maxClosedSummaries?: number;
}

export interface CompactionStatus {
  readonly lastAt: Timestamp | null;
  readonly lastReport: CompactionReport | null;
  /** Last failed or skipped attempt, with its reason. */
  readonly lastProblem: { readonly at: Timestamp; readonly kind: 'failed' | 'skipped'; readonly reason: string } | null;
  readonly automatic: number;
}

export interface AttemptManager {
  /** Re-reads the journal (restart): never resumes an attempt; see RecoveryReport. */
  recover(now: Timestamp): Promise<RecoveryReport>;
  /** Refuses the whole batch if any point is already in flight (OVERLAP) or the energy is not available. */
  lease(request: LeaseRequest): Promise<Attempt>;
  /** Journaled BEFORE the canvas write. */
  start(attemptId: AttemptId, now: Timestamp): Promise<Attempt>;
  /**
   * Records the outcomes. The energy of applied pixels is spent once
   * (operation id = attempt id), at `now`, UNLESS `reported` is given: a
   * resource observation returned with the write result already includes
   * the spending, so it is observed instead (never both). Such an
   * observation must not be given to the ResourceManager separately.
   */
  finish(attemptId: AttemptId, outcomes: readonly PixelWriteOutcome[], now: Timestamp, reported?: ResourceObservation): Promise<Attempt>;
  fail(attemptId: AttemptId, reason: string, outcomes: readonly PixelWriteOutcome[], now: Timestamp, reported?: ResourceObservation): Promise<Attempt>;
  /** Only an attempt never started can be cancelled. */
  cancel(attemptId: AttemptId, reason: string, now: Timestamp): Promise<Attempt>;
  /** Stop an operation already dispatched: retain its reservation until reconciliation. */
  interrupt(attemptId: AttemptId, reason: string, now: Timestamp): Promise<Attempt>;
  /** Expired leases: leased ones are cancelled, started ones need reconciliation. */
  expire(now: Timestamp): Promise<readonly Attempt[]>;
  /** A new revision of a template: older open attempts are cancelled (never started) or sent to reconciliation. */
  revisionChanged(projectId: ProjectId, templateId: TemplateId, revision: number, now: Timestamp): Promise<readonly Attempt[]>;
  /**
   * Closes an uncertain attempt from fresh canvas reads: never retried
   * blindly. Each read must be newer than the start and, once the attempt
   * was sent to reconciliation, newer than that time (a read taken between
   * the start and a crash may predate the write). Phase 1B.8: the attempt
   * closes only when EVERY one of its pixels has a valid value in one of the
   * reads (the newest valid one counts); otherwise INCOMPLETE_OBSERVATION
   * and the attempt stays open (its points stay reserved).
   */
  reconcile(attemptId: AttemptId, snapshots: CanvasSnapshot | readonly CanvasSnapshot[], now: Timestamp): Promise<Attempt>;
  /** Open attempts complete; closed ones as summaries (while retained). */
  get(attemptId: AttemptId): Attempt | ClosedAttempt | undefined;
  open(): readonly Attempt[];
  /** Canvas points of open attempts (leased, started, needs-reconciliation). */
  inFlight(): ReadonlySet<CanvasPointKey>;
  committedEnergy(agent: AgentId): number;
  /**
   * Last time an attempt of this agent ended with an uncertain energy
   * spending (null: none). After recover(), also the last close of any
   * started attempt in the journal: the spends recorded before a restart
   * are not kept, so a newer observation is required.
   */
  resourcesUncertainSince(agent: AgentId): Timestamp | null;
  /** Damage floor (null: none): leases need evidence newer than it, covering their points. */
  damage(): JournalDamage | null;
  /** The logical state (what a checkpoint stores). */
  state(): JournalState;
  /** Writes a checkpoint and starts a new journal generation; refused on a damaged journal (repair first). */
  compact(now: Timestamp, options?: CompactOptions): Promise<CompactionReport>;
  /** Manual and automatic compactions: last result, last failure or skip. */
  compactionStatus(): CompactionStatus;
  /**
   * False after a failure that leaves the journal in an unknown state (e.g.
   * an interrupted publish): every operation is then refused until a new
   * process recovers (JOURNAL_UNAVAILABLE).
   */
  usable(): boolean;
}
