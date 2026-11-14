/**
 * Canvas access, with read and write capabilities kept separate. Layer 2.
 *
 * A read-only provider (an imported snapshot) has no writer at all, so it
 * cannot receive a placement by mistake: the scheduler only accepts a
 * ReadWriteCanvasProvider (checked at compile time).
 *
 * V1 implementations: SimulatedCanvasProvider (read-write, local simulator)
 * and an imported-snapshot provider (read-only). No public-service writer.
 */

import type { CanvasPoint, CanvasRect, CoordinateSystem } from './geometry.js';
import type { AbortSignalLike, AgentId, AttemptId, CanvasPixel, Rgb, TaskId, Timestamp } from './primitives.js';
import type { ResourceSnapshot } from './resources.js';

/**
 * Where canvas data comes from. Progress computed from 'imported-snapshot'
 * is a measurement at observedAt; from 'simulated' it is a simulation.
 */
export type CanvasSource = 'simulated' | 'imported-snapshot';

export interface CanvasSnapshot {
  readonly rect: CanvasRect;
  readonly source: CanvasSource;
  /** When the pixels were observed (an imported snapshot can be stale). */
  readonly observedAt: Timestamp;
  get(point: CanvasPoint): CanvasPixel;
}

export interface CanvasReader {
  readonly coordinateSystem: CoordinateSystem;
  readRegion(rect: CanvasRect, signal?: AbortSignalLike): Promise<CanvasSnapshot>;
}

export interface PixelWrite {
  readonly taskId: TaskId;
  readonly point: CanvasPoint;
  readonly color: Rgb;
}

export type PixelRejectionReason = 'no-energy' | 'color-locked' | 'out-of-bounds' | 'rate-limited' | 'other';

export type PixelWriteOutcome =
  | { readonly taskId: TaskId; readonly status: 'applied' }
  | { readonly taskId: TaskId; readonly status: 'already-correct' }
  | { readonly taskId: TaskId; readonly status: 'rejected'; readonly reason: PixelRejectionReason }
  | { readonly taskId: TaskId; readonly status: 'unknown' };

export interface ApplyResult {
  readonly attemptId: AttemptId;
  readonly outcomes: readonly PixelWriteOutcome[];
  /** Resources reported by the canvas after the write, when available. */
  readonly resources?: ResourceSnapshot;
}

export interface WriteOptions {
  /** Idempotency key: a writer that supports it ignores a repeated attempt. */
  readonly attemptId: AttemptId;
  readonly signal?: AbortSignalLike;
}

export interface CanvasWriter {
  readonly maxPixelsPerWrite: number;
  /** True when a repeated attemptId is ignored. */
  readonly idempotentWrites: boolean;
  applyPixels(agent: AgentId, writes: readonly PixelWrite[], options: WriteOptions): Promise<ApplyResult>;
}

export interface ReadOnlyCanvasProvider {
  readonly id: string;
  readonly mode: 'read-only';
  readonly reader: CanvasReader;
}

export interface ReadWriteCanvasProvider {
  readonly id: string;
  readonly mode: 'read-write';
  readonly reader: CanvasReader;
  readonly writer: CanvasWriter;
}

export type CanvasProvider = ReadOnlyCanvasProvider | ReadWriteCanvasProvider;
