/**
 * Progress and time estimates. Layer 3.
 *
 * Phase 1B.4 (contracts v4): progress classifies every eligible pixel as
 * correct, incorrect (known wrong color or empty) or unknown, keeps the
 * provenance and age of the canvas snapshot, and never counts an unknown
 * pixel as correct. The ETA is a theoretical estimate with explicit
 * assumptions, or null with the reasons why.
 */

import type { CanvasSnapshot, CanvasSource } from './canvas.js';
import type { AgentId, Rgb, Timestamp } from './primitives.js';
import type { AgentResourceState, ResourceRules } from './resources.js';
import type { Template } from './template.js';

// ───────────────────────── Snapshot provenance and freshness ─────────────────────────

/**
 * What a measurement is: a simulation, or an observation imported from an
 * image taken at `observedAt`. V1 has no real-time canvas reader: nothing is
 * ever presented as a live reading.
 */
export type ObservationKind = 'simulation' | 'imported-observation';

/** Maximum acceptable age of a snapshot, configured per source (no global default). */
export interface FreshnessPolicy {
  readonly maxAgeMs: number;
}

/**
 * fresh / stale: age within / beyond the policy of the snapshot's source;
 * not-evaluated: no policy for that source, so the age was NOT judged (the
 * snapshot is never presented as current: ageMs says how old it is);
 * future: observedAt is after `now` (inconsistent clocks).
 */
export type FreshnessStatus = 'fresh' | 'stale' | 'not-evaluated' | 'future';

export interface SnapshotFreshness {
  readonly status: FreshnessStatus;
  /** now - observedAt (negative when `future`). */
  readonly ageMs: number;
  /** Policy applied, or null when not evaluated. */
  readonly maxAgeMs: number | null;
}

export interface ProgressBasis {
  readonly source: CanvasSource;
  readonly kind: ObservationKind;
  readonly observedAt: Timestamp;
  readonly freshness: SnapshotFreshness;
}

// ───────────────────────── Progress ─────────────────────────

/** total = correct + incorrect + unknown; incorrect = wrongColor + missing. */
export interface PixelCounts {
  /** Eligible pixels: non-transparent template pixels inside the canvas bounds. */
  readonly total: number;
  /** Observed with the expected color. */
  readonly correct: number;
  /** Observed, not the expected color (known work). */
  readonly incorrect: number;
  /** Part of `incorrect`: another color. */
  readonly wrongColor: number;
  /** Part of `incorrect`: an empty (transparent) canvas pixel. */
  readonly missing: number;
  /** No reliable observation: outside the snapshot, unreadable, or an invalid value. Never counted as correct. */
  readonly unknown: number;
}

export interface ColorProgress extends PixelCounts {
  /** Expected template color. */
  readonly color: Rgb;
}

/**
 * no-eligible-pixels: nothing to paint (fully transparent, or entirely
 * outside the canvas); complete: every eligible pixel observed correct;
 * incomplete: at least one known incorrect pixel; undetermined: no known
 * incorrect pixel, but some are unknown.
 */
export type CompletionState = 'no-eligible-pixels' | 'complete' | 'incomplete' | 'undetermined';

export interface ProgressSnapshot extends PixelCounts {
  readonly templateId: Template['id'];
  readonly revision: number;
  readonly basis: ProgressBasis;
  /** Part of `unknown`: values that are neither a 24-bit color nor a sentinel. */
  readonly invalidObservations: number;
  /** Template pixels not counted in `total`. */
  readonly excluded: { readonly transparent: number; readonly outsideCanvas: number };
  /** correct / total x 100; null when total is 0. */
  readonly conformityPercent: number | null;
  /** (correct + incorrect) / total x 100: share of eligible pixels actually observed; null when total is 0. */
  readonly coveragePercent: number | null;
  readonly completion: CompletionState;
  /** By expected color, colors with at least one eligible pixel, by increasing RGB value. */
  readonly byColor: readonly ColorProgress[];
  readonly computedAt: Timestamp;
}

export interface ProgressOptions {
  /** Freshness policy by snapshot source; a source without policy is reported `not-evaluated`. */
  readonly freshness?: Readonly<Partial<Record<CanvasSource, FreshnessPolicy>>>;
}

export interface ProgressCalculator {
  /**
   * Depends only on the template revision (image, placement, coordinate
   * system) and the snapshot: never on the drawing strategy, its seed, the
   * pixel order or the agents. The snapshot must be in the template's
   * coordinate system (convert explicitly otherwise).
   */
  compute(template: ProgressTemplate, snapshot: CanvasSnapshot, now: Timestamp): ProgressSnapshot;
}

export type ProgressTemplate = Pick<Template, 'id' | 'revision' | 'image' | 'placement' | 'coordinateSystem'>;

// ───────────────────────── ETA ─────────────────────────

/**
 * One agent for the ETA: its resource state (observed or computed by the
 * ResourceManager, the single source of energy predictions). Agents differ
 * by their states (energy, upgrade levels, palette, availability); they
 * share the rules of the provider.
 */
export interface EtaAgent {
  readonly id: AgentId;
  readonly state: AgentResourceState;
}

/** Configured pause window [start, end): nobody paints. */
export interface EtaPause {
  readonly start: Timestamp;
  readonly end: Timestamp;
}

export interface EtaParameters {
  /** Rules of the provider: energy cost per pixel, capacity, regeneration (one rule set per estimate). */
  readonly rules: ResourceRules;
  /** Cadence: minimum milliseconds between two pixels of the same agent (0 = no limit). */
  readonly msPerPixel: number;
  /** Below this observation coverage of the eligible pixels, no ETA (no default: the caller decides). */
  readonly minCoveragePercent: number;
  readonly pauses?: readonly EtaPause[];
  /**
   * Maximum age of the agents' resource observations; older ones raise
   * STALE_RESOURCES. Without it, a non-zero age raises
   * RESOURCE_AGE_NOT_EVALUATED (never a silent assumption).
   */
  readonly maxResourceAgeMs?: number;
}

export type EtaUnavailableCode =
  /** No agent, or none able to paint at all. */
  | 'NO_AGENT'
  /** Colors with remaining work that no agent has unlocked. */
  | 'COLORS_UNAVAILABLE'
  /** An agent can never hold the energy of one pixel. */
  | 'INSUFFICIENT_ENERGY'
  /** Invalid or inconsistent parameters or resources. */
  | 'INVALID_PARAMETERS'
  /** Too few eligible pixels observed (coverage below minCoveragePercent). */
  | 'INSUFFICIENT_OBSERVATION'
  /** The snapshot is stale for its source's freshness policy. */
  | 'STALE_SNAPSHOT'
  /** The estimate exceeds the safe integer range of milliseconds. */
  | 'OUT_OF_RANGE';

export interface EtaUnavailableReason {
  readonly code: EtaUnavailableCode;
  readonly message: string;
  readonly colors?: readonly Rgb[];
  readonly agents?: readonly AgentId[];
}

export interface EtaAssignment {
  readonly agent: AgentId;
  readonly pixels: number;
}

export interface EtaWarning {
  /**
   * FRESHNESS_NOT_EVALUATED: no freshness policy for the snapshot's source;
   * SIMULATED_RESOURCES: computed on simulated resource states (hypothetical);
   * RESOURCE_AGE_NOT_EVALUATED: resource observations have an age and no
   * maxResourceAgeMs was given; STALE_RESOURCES: some are older than it.
   * The energy is projected from those observations: spending elsewhere
   * since then is unknown.
   */
  readonly code: 'FRESHNESS_NOT_EVALUATED' | 'SIMULATED_RESOURCES' | 'RESOURCE_AGE_NOT_EVALUATED' | 'STALE_RESOURCES';
  readonly message: string;
}

export interface EtaResult {
  /** Always a theoretical estimate under `assumptions`, never a measured performance. */
  readonly kind: 'theoretical-estimate';
  /** Milliseconds from `computedAt`; null when unavailable (never replaced by an arbitrary value). */
  readonly durationMs: number | null;
  readonly finishAt: Timestamp | null;
  /** Empty when durationMs is not null. */
  readonly unavailable: readonly EtaUnavailableReason[];
  /** Pixels still to paint: known incorrect + unknown (unknown ones are assumed wrong). */
  readonly workPixels: number;
  readonly unknownCountedAsWork: number;
  /** Split of the work between agents behind the estimate (empty when unavailable or no work). */
  readonly assignments: readonly EtaAssignment[];
  readonly assumptions: readonly string[];
  /** Conditions the reader must see; they do not prevent the estimate. */
  readonly warnings: readonly EtaWarning[];
  readonly basis: ProgressBasis;
  readonly computedAt: Timestamp;
}

export interface EtaEstimator {
  estimate(progress: ProgressSnapshot, agents: readonly EtaAgent[], parameters: EtaParameters, now: Timestamp): EtaResult;
}
