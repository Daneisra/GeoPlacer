/**
 * Single-agent scheduler (Phase 1B.8). Layer 5 (top).
 *
 * The scheduler only COORDINATES the existing components: templates
 * (current revision), the WorkPlanner (next batch), the AttemptManager and
 * its journal (leases, starts, closes, reconciliation), the ResourceManager
 * (the only energy model), progress and ETA, and a read-write canvas
 * provider (the local simulator in this phase). It never re-implements
 * their rules.
 *
 * V1 runs ONE active agent; the configuration keeps a list of agents so
 * that the multi-agent case stays expressible, but a scheduler refuses
 * more than `maxActiveAgents` (1 in production).
 */

import type { CanvasPoint } from './geometry.js';
import type { ReadWriteCanvasProvider } from './canvas.js';
import type { AbortSignalLike, AgentId, AttemptId, Clock, ProjectId, TemplateId, Timestamp } from './primitives.js';
import type { CanvasSource } from './canvas.js';
import type { EtaPause, EtaUnavailableReason, FreshnessPolicy, ProgressSnapshot } from './progress.js';
import type { Hasher } from './ports.js';
import type { OrderCacheStore } from './strategy.js';
import type { ResourceManager, ResourceObservation } from './resources.js';
import type { Template, TemplateRef } from './template.js';
import type { AttemptManager, UnknownPixelPolicy } from './work.js';

/**
 * stopped: not running (initial and final); initializing: journal recovery
 * and first reads; running: planning and writing; paused: on request, no
 * new attempt; waiting-resources: not enough energy, or the agent is
 * unavailable, until a computed time; waiting-reconciliation: uncertain
 * attempts wait for a canvas read that covers them; completed: the canvas
 * matches the template (full coverage, no incorrect pixel, no open
 * attempt); error: needs an intervention (blocked work, unusable journal,
 * failing provider...).
 */
export type SchedulerState = 'stopped' | 'initializing' | 'running' | 'paused' | 'waiting-resources' | 'waiting-reconciliation' | 'waiting-observation' | 'completed' | 'error';

/** The current revision of a template (a TemplateManager: `(await load(ref)).template`). */
export interface TemplateSource {
  current(ref: TemplateRef): Promise<Template>;
}

/** What the provider reports about an agent now (the simulator in this phase). */
export interface ResourceSource {
  observe(agent: AgentId, signal?: AbortSignalLike): Promise<ResourceObservation>;
}

export interface SchedulerConfig {
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  /** V1: exactly one. Kept as a list for the multi-agent case (not activated). */
  readonly agents: readonly AgentId[];
  /** EngineConfig.maxActiveAgents: 1 in production V1. */
  readonly maxActiveAgents: number;
  readonly maxBatchSize: number;
  /** Wait until the energy allows min(minBatchSize, pixels left) before leasing (>= 1). */
  readonly minBatchSize: number;
  readonly leaseTtlMs: number;
  readonly unknownPixels: UnknownPixelPolicy;
  readonly freshness?: Readonly<Partial<Record<CanvasSource, FreshnessPolicy>>>;
  /** Resources older than this are observed again before planning. */
  readonly maxResourceAgeMs: number;
  readonly eta: { readonly msPerPixel: number; readonly minCoveragePercent: number; readonly pauses?: readonly EtaPause[] };
  /** Wait before retrying a reconciliation whose reads were not new enough or incomplete. */
  readonly reconcileRetryMs: number;
  /** Longest single wait (the revision and the canvas are re-checked at least this often). */
  readonly maxWaitMs: number;
  /** Errors kept in the status. */
  readonly maxRecentErrors: number;
  /** Safety net: the loop stops in error after this many cycles (tests; null: unlimited). */
  readonly maxCycles: number | null;
  /**
   * Phase 1B.10 (optional, default 'full'): 'incremental' reclassifies only
   * the pixels whose observed value changed since the previous cycle, and
   * is compared with the full computation every `verifyEvery` cycles (on any
   * difference the full result is used and the state rebuilt).
   */
  readonly progressMode?: 'full' | 'incremental';
  /** Keep observing an authorized scope instead of ending when no eligible work is visible. */
  readonly watchOnIdle?: boolean;
}

/**
 * Phase 1C.0: cooperative scheduling. A cycle is CPU work between rare real I/O waits: without
 * yields, the whole cycle (canvas copy, progress, plan) blocks the host's event loop. With this
 * option the scheduler awaits `yieldTo()` between the phases of a cycle, and long computations
 * are cut into slices of about `slicePixels` pixels with a yield between slices.
 *
 * Consistency: every slice of a cycle works on the SAME snapshot (a copy taken at the start of
 * the cycle): changes made meanwhile (an outside actor, a write) are seen at the next cycle, as
 * for any read. Pause, stop and a new template revision are checked after the last yield, before
 * any lease: a plan computed for an old revision or before a pause is never leased.
 */
export interface CooperativeOptions {
  /** Lets other work run (Node: setImmediate). */
  yieldTo(): Promise<void>;
  /** Pixels of work between two yields inside a long computation (positive integer). */
  readonly slicePixels: number;
}

export interface SchedulerDependencies {
  readonly clock: Clock;
  /** Must be writable: a read-only snapshot provider is rejected at compile time. */
  readonly canvas: ReadWriteCanvasProvider;
  readonly templates: TemplateSource;
  readonly resourceSource: ResourceSource;
  readonly resources: ResourceManager;
  readonly attempts: AttemptManager;
  /** Optional policy veto on a planned group, before any reservation is created. */
  readonly groupWait?: (group: { size: number; candidates: number; progress: ProgressSnapshot }) => string | null;
  /** To prepare the random order (and its verified cache); optional. */
  readonly hasher?: Hasher;
  readonly orderCache?: OrderCacheStore;
  /** Phase 1C.0 (optional): absent, a cycle never yields on its own (behaviour before 1C.0). */
  readonly cooperative?: CooperativeOptions;
}

export interface SchedulerError {
  readonly at: Timestamp;
  readonly code: string;
  readonly message: string;
}

/** Structured state of a cycle (also the payload of the future WebSocket events). */
export interface SchedulerStatus {
  readonly at: Timestamp;
  readonly state: SchedulerState;
  /** Why the scheduler waits, is paused, completed or failed. */
  readonly reason: string | null;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly revision: number | null;
  readonly agent: AgentId;
  readonly cycles: number;
  /** Estimated work queue: pixels to paint (incorrect + unknown counted as work). */
  readonly workPixels: number | null;
  readonly correct: number | null;
  readonly incorrect: number | null;
  readonly unknown: number | null;
  /** Conformity of the eligible pixels, in percent (null: nothing eligible or no read yet). */
  readonly progressPercent: number | null;
  readonly openAttempts: number;
  /** Attempts whose result is still uncertain (started or to reconcile). */
  readonly uncertainAttempts: readonly AttemptId[];
  readonly energy: number | null;
  /** When the next batch is expected to be possible (energy or availability), null when not waiting. */
  readonly nextAvailabilityAt: Timestamp | null;
  readonly eta: { readonly durationMs: number | null; readonly finishAt: Timestamp | null; readonly unavailable: readonly EtaUnavailableReason[] } | null;
  /** Date and origin of the observations behind this status. */
  readonly observations: {
    readonly canvas: { readonly at: Timestamp; readonly source: CanvasSource } | null;
    readonly resources: { readonly at: Timestamp; readonly kind: string } | null;
  };
  /** Pixels applied and attempts closed since start. */
  readonly applied: number;
  readonly attemptsClosed: number;
  readonly recentErrors: readonly SchedulerError[];
}

export type SchedulerEvent =
  | { readonly type: 'state'; readonly at: Timestamp; readonly from: SchedulerState; readonly to: SchedulerState; readonly reason: string | null }
  | { readonly type: 'cycle'; readonly status: SchedulerStatus }
  | { readonly type: 'attempt'; readonly at: Timestamp; readonly attemptId: AttemptId; readonly state: string; readonly pixels: number; readonly applied: number }
  | { readonly type: 'progress'; readonly at: Timestamp; readonly progress: ProgressSnapshot }
  | { readonly type: 'error'; readonly error: SchedulerError };

export interface StopOptions {
  /**
   * Abort the operation in progress (the write is signalled). A started
   * attempt is never abandoned silently: it is reconciled when a covering
   * read is possible, otherwise reported open in the status.
   */
  readonly abort?: boolean;
}

/** Control interface, independent of any UI. */
export interface TaskScheduler {
  /** Recovers the journal, then runs the loop in the background (resolves once started). */
  start(): Promise<void>;
  /** No new attempt after the current one; resolves when paused. */
  pause(): Promise<void>;
  resume(): void;
  /** Stops after (or, with abort, during) the current operation; resolves when stopped. */
  stop(options?: StopOptions): Promise<SchedulerStatus>;
  status(): SchedulerStatus;
  /** Events (state changes, cycles, attempts, progress, errors); the returned callback unsubscribes. */
  subscribe(listener: (event: SchedulerEvent) => void): () => void;
  /** Resolves when the loop ends (completed, error or stopped). */
  done(): Promise<SchedulerStatus>;
  /** One cycle without the loop (tests and diagnostics); recovers first when needed. */
  step(): Promise<SchedulerStatus>;
}

/** Points of a canvas region (tests). */
export type CanvasPoints = readonly CanvasPoint[];
