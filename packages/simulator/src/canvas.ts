/**
 * SimulatedCanvasProvider (Phase 1B.7): a local, in-memory canvas behind
 * the CanvasReader / CanvasWriter / ReadWriteCanvasProvider contracts.
 * Independent of any real service: no network, synthetic rules supplied by
 * the caller.
 *
 * - Bounds (a canvas rectangle) and coordinate system are explicit; points
 *   outside the bounds are UNKNOWN when read and rejected when written.
 * - Snapshots are copies dated by the injected clock, with `readRow`.
 * - Energy follows the core rule functions (stateFromObservation, advance,
 *   consumeEnergy) with the injected clock: the same model as the engine.
 * - Writes: in order, per pixel: out of bounds -> rejected; color not
 *   unlocked -> rejected; already the color -> already-correct (free);
 *   not enough energy -> rejected no-energy; otherwise applied.
 * - Optional idempotency by attempt id (a repeated attempt is not applied
 *   again: its first result is returned).
 * - Deterministic faults, queued and consumed one per write call: failure
 *   before applying, partial application then failure, answer lost after
 *   applying, all rejected, outcomes reported unknown.
 * - External actors: paint / erase / a scripted edit (another player).
 */

import type {
  AbortSignalLike,
  AgentAvailability,
  AgentId,
  AgentResourceState,
  ApplyResult,
  AttemptId,
  CanvasPoint,
  CanvasReader,
  CanvasRect,
  CanvasSnapshot,
  CanvasWriter,
  CoordinateSystem,
  PixelRejectionReason,
  PixelWrite,
  PixelWriteOutcome,
  ReadWriteCanvasProvider,
  ResourceObservation,
  ResourceRules,
  Rgb,
  TimeSource,
  UpgradeLevels,
} from '@geoplacer/core';
import { TRANSPARENT, UNKNOWN, advance, assertCoordinateSystem, assertRect, consumeEnergy, createArraySnapshot, stateFromObservation } from '@geoplacer/core';

export type SimulatedFault =
  /** No fault for this call (to place the next faults at a given write). */
  | { readonly kind: 'none' }
  /** The call fails before touching the canvas (nothing applied). */
  | { readonly kind: 'fail-before' }
  /** The first `applied` writes are processed, then the call fails (answer lost). */
  | { readonly kind: 'partial'; readonly applied: number }
  /** Everything is processed, then the answer is lost (the call fails). */
  | { readonly kind: 'answer-lost' }
  /** Every write is rejected with `reason` (nothing applied). */
  | { readonly kind: 'reject'; readonly reason: PixelRejectionReason }
  /** Everything is processed, but every outcome is reported 'unknown'. */
  | { readonly kind: 'unknown-outcomes' }
  /**
   * The write hangs (request sent, no answer yet) until releaseHeld() or
   * the abort signal. `appliedBefore`: the pixels land when the hold
   * starts (the answer is what is pending), otherwise only on release.
   * Aborted: the call fails (answer lost), whatever was applied.
   */
  | { readonly kind: 'hold'; readonly appliedBefore: boolean };

export class SimulatedCanvasError extends Error {
  readonly fault: SimulatedFault['kind'] | 'aborted';

  constructor(fault: SimulatedFault['kind'] | 'aborted', message: string) {
    super(message);
    this.name = 'SimulatedCanvasError';
    this.fault = fault;
  }
}

export interface SimulatedAgent {
  readonly agent: AgentId;
  readonly energy: number;
  readonly unlockedColors: readonly Rgb[];
  readonly upgrades?: UpgradeLevels;
  readonly currency?: number;
}

export interface SimulatedCanvasOptions {
  readonly id?: string;
  /** Canvas bounds (canvas coordinates). */
  readonly bounds: CanvasRect;
  readonly coordinateSystem: CoordinateSystem;
  readonly rules: ResourceRules;
  /** Its sleep() (a ManualClock) is needed for a write latency. */
  readonly clock: TimeSource & { readonly sleep?: (ms: number) => Promise<void> };
  /** Time a write takes on the (virtual) clock before it is applied (default 0). */
  readonly writeLatencyMs?: number;
  readonly idempotentWrites?: boolean;
  readonly maxPixelsPerWrite?: number;
  /** Initial value of every pixel (default: empty). */
  readonly fill?: number;
}

/** What happened to the canvas (tests: who wrote what, how many times). */
export interface CanvasEvent {
  readonly at: number;
  readonly kind: 'applied' | 'external';
  readonly point: CanvasPoint;
  readonly color: number;
  readonly agent: AgentId | null;
  readonly attemptId: AttemptId | null;
}

export class SimulatedCanvasProvider implements ReadWriteCanvasProvider {
  readonly id: string;
  readonly mode = 'read-write' as const;
  readonly reader: CanvasReader;
  readonly writer: CanvasWriter;
  readonly bounds: CanvasRect;
  readonly coordinateSystem: CoordinateSystem;
  private readonly pixels: Int32Array;
  private readonly rules: ResourceRules;
  private readonly clock: SimulatedCanvasOptions['clock'];
  private readonly latency: number;
  private held: (() => void) | null = null;
  private readonly agents = new Map<AgentId, AgentResourceState>();
  private readonly results = new Map<AttemptId, ApplyResult>();
  private readonly faults: SimulatedFault[] = [];
  readonly events: CanvasEvent[] = [];
  /** Write calls received (including failed and repeated ones). */
  writeCalls = 0;

  constructor(options: SimulatedCanvasOptions) {
    assertRect(options.bounds, 'bounds');
    assertCoordinateSystem(options.coordinateSystem);
    this.id = options.id ?? 'simulated-canvas';
    this.bounds = options.bounds;
    this.coordinateSystem = options.coordinateSystem;
    this.rules = options.rules;
    this.clock = options.clock;
    this.latency = options.writeLatencyMs ?? 0;
    if (!Number.isSafeInteger(this.latency) || this.latency < 0) throw new Error('writeLatencyMs must be a non-negative integer');
    if (this.latency > 0 && this.clock.sleep === undefined) throw new Error('a write latency needs a clock with sleep()');
    this.pixels = new Int32Array(options.bounds.width * options.bounds.height).fill(options.fill ?? TRANSPARENT);
    const idempotentWrites = options.idempotentWrites ?? false;
    const maxPixelsPerWrite = options.maxPixelsPerWrite ?? 10_000;
    if (!Number.isSafeInteger(maxPixelsPerWrite) || maxPixelsPerWrite < 1) throw new Error('maxPixelsPerWrite must be a positive integer');
    this.reader = {
      coordinateSystem: this.coordinateSystem,
      readRegion: (rect, signal) => this.readRegion(rect, signal),
    };
    this.writer = {
      maxPixelsPerWrite,
      idempotentWrites,
      applyPixels: (agent, writes, writeOptions) => this.applyPixels(agent, writes, writeOptions.attemptId, idempotentWrites, maxPixelsPerWrite, writeOptions.signal),
    };
  }

  private index(p: CanvasPoint): number {
    const { minX, minY, width, height } = this.bounds;
    const x = p.x - minX;
    const y = p.y - minY;
    return Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y) && x >= 0 && y >= 0 && x < width && y < height ? y * width + x : -1;
  }

  // ───────── Agents ─────────

  /** Registers (or resets) an agent with its resources at the current time. */
  addAgent(a: SimulatedAgent): void {
    const observation: ResourceObservation = {
      type: 'resource-observation',
      agent: a.agent,
      observedAt: this.clock.now(),
      energy: a.energy,
      currency: a.currency ?? 0,
      unlockedColors: [...a.unlockedColors],
      upgrades: a.upgrades ?? { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
      availability: { status: 'available' },
      regenProgressMs: 0,
    };
    this.agents.set(a.agent, stateFromObservation(this.rules, observation));
  }

  private stateOf(agent: AgentId): AgentResourceState {
    const s = this.agents.get(agent);
    if (s === undefined) throw new Error(`unknown simulated agent ${agent}`);
    const now = this.clock.now();
    const advanced = advance(this.rules, s, now, now);
    this.agents.set(agent, advanced);
    return advanced;
  }

  /** Makes an agent unavailable until `until` (null: indefinitely), or available again. */
  setAvailability(agent: AgentId, availability: AgentAvailability): void {
    const s = this.stateOf(agent);
    this.agents.set(agent, { ...s, availability });
  }

  /** A ResourceSource over this provider (the scheduler's port). */
  resourceSource(): { observe(agent: AgentId): Promise<ResourceObservation> } {
    return { observe: async (agent) => this.observe(agent) };
  }

  /** Releases a write held by a 'hold' fault. */
  releaseHeld(): void {
    const release = this.held;
    this.held = null;
    release?.();
  }

  /** A dead caller (crashed process): its held write is forgotten and never answers. */
  forgetHeld(): void {
    this.held = null;
  }

  /** True while a write is held. */
  get holding(): boolean {
    return this.held !== null;
  }

  /** What the provider reports about an agent now (an observation, exact). */
  observe(agent: AgentId): ResourceObservation {
    const s = this.stateOf(agent);
    return {
      type: 'resource-observation',
      agent,
      observedAt: this.clock.now(),
      energy: s.energy,
      currency: s.currency,
      unlockedColors: [...s.unlockedColors],
      upgrades: s.upgrades,
      availability: s.availability,
      regenProgressMs: s.regenProgressMs,
    };
  }

  // ───────── Faults and external actors ─────────

  /** Queues faults, consumed one per write call, in order. */
  injectFaults(...faults: SimulatedFault[]): void {
    this.faults.push(...faults);
  }

  get pendingFaults(): number {
    return this.faults.length;
  }

  /** Another actor paints (no energy, no agent). */
  paint(point: CanvasPoint, color: Rgb): void {
    const i = this.index(point);
    if (i < 0) throw new Error('point outside the canvas bounds');
    this.pixels[i] = color;
    this.events.push({ at: this.clock.now(), kind: 'external', point: { x: point.x, y: point.y }, color, agent: null, attemptId: null });
  }

  /** Another actor erases a pixel (empty again). */
  erase(point: CanvasPoint): void {
    const i = this.index(point);
    if (i < 0) throw new Error('point outside the canvas bounds');
    this.pixels[i] = TRANSPARENT;
    this.events.push({ at: this.clock.now(), kind: 'external', point: { x: point.x, y: point.y }, color: TRANSPARENT, agent: null, attemptId: null });
  }

  /** Pixel value at a canvas point (UNKNOWN outside the bounds). */
  at(point: CanvasPoint): number {
    const i = this.index(point);
    return i < 0 ? UNKNOWN : this.pixels[i]!;
  }

  /** How many times agents applied a pixel at `point`. */
  appliedCount(point: CanvasPoint): number {
    return this.events.filter((e) => e.kind === 'applied' && e.point.x === point.x && e.point.y === point.y).length;
  }

  // ───────── Reader ─────────

  private async readRegion(rect: CanvasRect, signal?: AbortSignalLike): Promise<CanvasSnapshot> {
    if (signal?.aborted === true) throw new SimulatedCanvasError('aborted', 'read aborted');
    assertRect(rect);
    const out = new Int32Array(rect.width * rect.height).fill(UNKNOWN);
    const { minX, minY, width } = this.bounds;
    const x0 = Math.max(rect.minX, minX);
    const x1 = Math.min(rect.minX + rect.width, minX + width);
    const y0 = Math.max(rect.minY, minY);
    const y1 = Math.min(rect.minY + rect.height, minY + this.bounds.height);
    for (let y = y0; y < y1 && x1 > x0; y++) {
      const from = (y - minY) * width + (x0 - minX);
      out.set(this.pixels.subarray(from, from + (x1 - x0)), (y - rect.minY) * rect.width + (x0 - rect.minX));
    }
    return createArraySnapshot({ rect, coordinateSystem: this.coordinateSystem, source: 'simulated', observedAt: this.clock.now(), pixels: out });
  }

  /** The whole canvas as a snapshot (convenience). */
  snapshot(): Promise<CanvasSnapshot> {
    return this.readRegion(this.bounds);
  }

  // ───────── Writer ─────────

  private applyAll(agent: AgentId, writes: readonly PixelWrite[], attemptId: AttemptId): PixelWriteOutcome[] {
    const unlocked = new Set<number>(this.stateOf(agent).unlockedColors);
    return writes.map((w) => this.writeOne(agent, w, unlocked, attemptId));
  }

  private async applyHeld(agent: AgentId, writes: readonly PixelWrite[], attemptId: AttemptId, appliedBefore: boolean, signal?: AbortSignalLike): Promise<ApplyResult> {
    let outcomes = appliedBefore ? this.applyAll(agent, writes, attemptId) : null;
    const aborted = await new Promise<boolean>((resolve) => {
      this.held = () => resolve(false);
      signal?.addEventListener('abort', () => resolve(true));
    });
    this.held = null;
    if (aborted) throw new SimulatedCanvasError('aborted', 'write aborted while waiting for the answer');
    outcomes ??= this.applyAll(agent, writes, attemptId);
    const result: ApplyResult = { attemptId, outcomes, resources: this.observe(agent) };
    this.results.set(attemptId, result);
    return result;
  }

  private writeOne(agent: AgentId, w: PixelWrite, unlocked: ReadonlySet<number>, attemptId: AttemptId): PixelWriteOutcome {
    const i = this.index(w.point);
    const reject = (reason: PixelRejectionReason): PixelWriteOutcome => ({ taskId: w.taskId, status: 'rejected', reason });
    if (i < 0) return reject('out-of-bounds');
    if (!unlocked.has(w.color)) return reject('color-locked');
    if (this.pixels[i] === w.color) return { taskId: w.taskId, status: 'already-correct' };
    const now = this.clock.now();
    const state = this.stateOf(agent);
    const cost = this.rules.energy.costPerPixel;
    if (state.energy < cost) return reject('no-energy');
    this.agents.set(agent, consumeEnergy(this.rules, state, now, cost, now).state);
    this.pixels[i] = w.color;
    this.events.push({ at: now, kind: 'applied', point: { x: w.point.x, y: w.point.y }, color: w.color, agent, attemptId });
    return { taskId: w.taskId, status: 'applied' };
  }

  private async applyPixels(agent: AgentId, writes: readonly PixelWrite[], attemptId: AttemptId, idempotent: boolean, max: number, signal?: AbortSignalLike): Promise<ApplyResult> {
    this.writeCalls++;
    if (signal?.aborted === true) throw new SimulatedCanvasError('aborted', 'write aborted');
    if (writes.length > max) throw new Error(`at most ${max} pixels per write`);
    const fault = this.faults.shift();
    if (this.latency > 0) await this.clock.sleep!(this.latency);
    if (fault?.kind === 'fail-before') throw new SimulatedCanvasError('fail-before', 'simulated failure before applying');
    const previous = this.results.get(attemptId);
    if (previous !== undefined && idempotent) return previous;
    if (fault?.kind === 'reject') {
      const result: ApplyResult = { attemptId, outcomes: writes.map((w) => ({ taskId: w.taskId, status: 'rejected', reason: fault.reason })), resources: this.observe(agent) };
      this.results.set(attemptId, result);
      return result;
    }
    if (fault?.kind === 'hold') return this.applyHeld(agent, writes, attemptId, fault.appliedBefore, signal);
    const unlocked = new Set<number>(this.stateOf(agent).unlockedColors);
    const count = fault?.kind === 'partial' ? Math.max(0, Math.min(fault.applied, writes.length)) : writes.length;
    const outcomes: PixelWriteOutcome[] = [];
    for (let k = 0; k < count; k++) outcomes.push(this.writeOne(agent, writes[k]!, unlocked, attemptId));
    if (fault?.kind === 'partial') throw new SimulatedCanvasError('partial', `simulated failure after ${count} of ${writes.length} pixels`);
    const result: ApplyResult = {
      attemptId,
      outcomes: fault?.kind === 'unknown-outcomes' ? writes.map((w) => ({ taskId: w.taskId, status: 'unknown' })) : outcomes,
      resources: this.observe(agent),
    };
    this.results.set(attemptId, result);
    if (fault?.kind === 'answer-lost') throw new SimulatedCanvasError('answer-lost', 'simulated loss of the answer after applying');
    return result;
  }
}
