/**
 * Progress and time estimates. Layer 3.
 */

import type { CanvasSnapshot, CanvasSource } from './canvas.js';
import type { AgentId, Rgb, TemplateId, Timestamp } from './primitives.js';
import type { ResourceManager, ResourceModel } from './resources.js';
import type { Template } from './template.js';

export interface ColorProgress {
  readonly total: number;
  readonly correct: number;
}

/** What the progress was measured on: a simulation, or an imported snapshot observed at a given time. */
export interface ProgressBasis {
  readonly source: CanvasSource;
  readonly observedAt: Timestamp;
}

export interface ProgressSnapshot {
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly basis: ProgressBasis;
  readonly total: number;
  readonly correct: number;
  /** Canvas has another color. */
  readonly wrongColor: number;
  /** Canvas pixel is empty. */
  readonly missing: number;
  /** Canvas pixel could not be read. */
  readonly unknown: number;
  readonly percent: number;
  readonly byColor: ReadonlyMap<Rgb, ColorProgress>;
  readonly computedAt: Timestamp;
}

export interface ProgressCalculator {
  /** The basis is taken from the snapshot (source and observedAt). */
  compute(template: Template, snapshot: CanvasSnapshot, now: Timestamp): ProgressSnapshot;
}

/** Separate from progress: depends on agents and resources. */
export interface EtaEstimator {
  /** Milliseconds to paint `remaining` pixels, or null when impossible (no agent, missing colors). */
  estimate(remaining: number, agents: readonly AgentId[], resources: ResourceManager, model: ResourceModel, now: Timestamp): number | null;
}
