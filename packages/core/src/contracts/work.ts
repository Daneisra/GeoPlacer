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
 */

import type { CanvasSnapshot, CanvasSource, PixelWrite, PixelWriteOutcome } from './canvas.js';
import type { AgentId, AttemptId, ProjectId, Rgb, TemplateId, Timestamp } from './primitives.js';
import type { FreshnessPolicy, ProgressBasis } from './progress.js';
import type { AgentResourceState, ResourceRules } from './resources.js';
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
  readonly closedAt: Timestamp | null;
  readonly results: readonly { readonly taskId: PixelWrite['taskId']; readonly result: PixelResult }[];
  readonly reason: string | null;
}

/** Append-only journal entries (one JSON line each). */
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
    };

export interface JournalLoad {
  readonly events: readonly JournalEvent[];
  /** A torn last line (interrupted append): ignored. */
  readonly discardedTailBytes: number;
  /** Damaged lines BEFORE the end (checksum or format): reported, never silently skipped. */
  readonly corruptLines: readonly number[];
}

export interface AttemptJournal {
  load(): Promise<JournalLoad>;
  /** Durable before returning (the attempt state machine relies on it). */
  append(event: JournalEvent): Promise<void>;
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
}

export interface RecoveryReport {
  /** Leased, never started: cancelled (nothing was sent). */
  readonly released: readonly AttemptId[];
  /** Started without a closing event: to reconcile against a fresh canvas read. */
  readonly toReconcile: readonly AttemptId[];
  readonly discardedTailBytes: number;
  readonly corruptLines: readonly number[];
  /** Journal events that were not valid transitions (ignored, reported). */
  readonly inconsistentEvents: number;
}

export interface AttemptManager {
  /** Re-reads the journal (restart): never resumes an attempt; see RecoveryReport. */
  recover(now: Timestamp): Promise<RecoveryReport>;
  /** Refuses the whole batch if any point is already in flight (OVERLAP) or the energy is not available. */
  lease(request: LeaseRequest): Promise<Attempt>;
  /** Journaled BEFORE the canvas write. */
  start(attemptId: AttemptId, now: Timestamp): Promise<Attempt>;
  /** Records the outcomes; spends the energy of applied pixels once (operation id = attempt id). */
  finish(attemptId: AttemptId, outcomes: readonly PixelWriteOutcome[], now: Timestamp): Promise<Attempt>;
  fail(attemptId: AttemptId, reason: string, outcomes: readonly PixelWriteOutcome[], now: Timestamp): Promise<Attempt>;
  /** Only an attempt never started can be cancelled. */
  cancel(attemptId: AttemptId, reason: string, now: Timestamp): Promise<Attempt>;
  /** Expired leases: leased ones are cancelled, started ones need reconciliation. */
  expire(now: Timestamp): Promise<readonly Attempt[]>;
  /** A new revision of a template: older open attempts are cancelled (never started) or sent to reconciliation. */
  revisionChanged(projectId: ProjectId, templateId: TemplateId, revision: number, now: Timestamp): Promise<readonly Attempt[]>;
  /** Closes an uncertain attempt from a fresh canvas read: never retried blindly. */
  reconcile(attemptId: AttemptId, snapshot: CanvasSnapshot, now: Timestamp): Promise<Attempt>;
  get(attemptId: AttemptId): Attempt | undefined;
  open(): readonly Attempt[];
  /** Canvas points of open attempts (leased, started, needs-reconciliation). */
  inFlight(): ReadonlySet<CanvasPointKey>;
  committedEnergy(agent: AgentId): number;
  /** Last time an attempt of this agent ended with an uncertain energy spending (null: none). */
  resourcesUncertainSince(agent: AgentId): Timestamp | null;
}
