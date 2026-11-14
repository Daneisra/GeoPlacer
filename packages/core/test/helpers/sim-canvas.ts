/**
 * Minimal LOCAL simulated canvas for the attempt tests (memory only, no
 * network): a writer with energy per agent, an optional idempotency by
 * attempt id, and fault injection around the write. The rules are the
 * synthetic SIMULATED_RULES; nothing here describes a real service.
 */

import type {
  AgentId,
  ApplyResult,
  AttemptId,
  CanvasRect,
  CanvasSnapshot,
  CanvasWriter,
  PixelWrite,
  PixelWriteOutcome,
  ResourceObservation,
  Rgb,
  Timestamp,
} from '../../src/index.js';
import { TRANSPARENT, createArraySnapshot } from '../../src/index.js';

/** Where the next write fails: before touching the canvas, or after applying it (answer lost). */
export type WriteFault = 'before-apply' | 'answer-lost';

export class SimulatedWriteError extends Error {
  constructor(readonly fault: WriteFault) {
    super(`simulated write fault: ${fault}`);
  }
}

export class SimCanvas implements CanvasWriter {
  readonly maxPixelsPerWrite = 10_000;
  readonly pixels: Int32Array;
  readonly energy = new Map<AgentId, number>();
  readonly unlocked = new Map<AgentId, readonly Rgb[]>();
  /** Writes actually applied per canvas point (detects double application). */
  readonly appliedAt = new Map<string, number>();
  readonly faults: WriteFault[] = [];
  private readonly seen = new Map<AttemptId, ApplyResult>();
  calls = 0;

  constructor(
    readonly rect: CanvasRect,
    readonly idempotentWrites: boolean,
  ) {
    this.pixels = new Int32Array(rect.width * rect.height).fill(TRANSPARENT);
  }

  private index(x: number, y: number): number {
    const { minX, minY, width, height } = this.rect;
    return x < minX || y < minY || x >= minX + width || y >= minY + height ? -1 : (y - minY) * width + (x - minX);
  }

  /** Paints directly (another actor, vandalism). */
  set(x: number, y: number, color: number): void {
    this.pixels[this.index(x, y)] = color;
  }

  at(x: number, y: number): number {
    return this.pixels[this.index(x, y)]!;
  }

  async applyPixels(agent: AgentId, writes: readonly PixelWrite[], options: { readonly attemptId: AttemptId }): Promise<ApplyResult> {
    this.calls++;
    const fault = this.faults.shift();
    if (fault === 'before-apply') throw new SimulatedWriteError(fault);
    const previous = this.seen.get(options.attemptId);
    if (previous !== undefined && this.idempotentWrites) return previous;
    const unlocked = new Set(this.unlocked.get(agent) ?? []);
    const outcomes: PixelWriteOutcome[] = writes.map((w) => {
      const i = this.index(w.point.x, w.point.y);
      if (i < 0) return { taskId: w.taskId, status: 'rejected', reason: 'out-of-bounds' };
      if (!unlocked.has(w.color)) return { taskId: w.taskId, status: 'rejected', reason: 'color-locked' };
      if (this.pixels[i] === w.color) return { taskId: w.taskId, status: 'already-correct' };
      const energy = this.energy.get(agent) ?? 0;
      if (energy < 1) return { taskId: w.taskId, status: 'rejected', reason: 'no-energy' };
      this.energy.set(agent, energy - 1);
      this.pixels[i] = w.color;
      const key = `${w.point.x},${w.point.y}`;
      this.appliedAt.set(key, (this.appliedAt.get(key) ?? 0) + 1);
      return { taskId: w.taskId, status: 'applied' };
    });
    const result: ApplyResult = { attemptId: options.attemptId, outcomes };
    this.seen.set(options.attemptId, result);
    if (fault === 'answer-lost') throw new SimulatedWriteError(fault);
    return result;
  }

  snapshot(observedAt: Timestamp): CanvasSnapshot {
    return createArraySnapshot({ rect: this.rect, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt, pixels: this.pixels.slice() });
  }

  observe(agent: AgentId, observedAt: Timestamp): ResourceObservation {
    return {
      type: 'resource-observation',
      agent,
      observedAt,
      energy: this.energy.get(agent) ?? 0,
      currency: 0,
      unlockedColors: [...(this.unlocked.get(agent) ?? [])],
      upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
      availability: { status: 'available' },
    };
  }
}
