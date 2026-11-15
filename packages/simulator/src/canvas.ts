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
 * - Phase 1B.9, durable world: with a `commit` hook, every change (a write,
 *   an external edit, an agent update) is STAGED, handed to the hook, and
 *   made visible only once the hook has resolved; a write answers only
 *   after that. All changes are serialized. `initial` restores a saved
 *   world. Event and result tracking can be turned off or bounded.
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
  /** Restores a saved world (pixels in the bounds raster, agent states); `fill` is then ignored. */
  readonly initial?: { readonly pixels: Int32Array; readonly agents: readonly AgentResourceState[] };
  /**
   * Durable world (Phase 1B.9): called with each change before it becomes
   * visible. If it throws, nothing changes (a write then fails as if
   * before applying). Synchronous edits (paint, erase, addAgent,
   * setAvailability) are refused: use their asynchronous forms.
   */
  readonly commit?: (change: WorldCommit) => Promise<void>;
  /** Keeps `events` (default true; a server turns it off: it grows with every pixel). */
  readonly trackEvents?: boolean;
  /** Results remembered for idempotent replays (default: all; a server bounds it). */
  readonly rememberResults?: number;
}

/** A pixel change of the world: index in the bounds raster (row-major), new value. */
export interface WorldPixel {
  readonly index: number;
  readonly color: number;
}

/**
 * One durable change of the simulated world (Phase 1B.9), handed to the
 * `commit` hook BEFORE it becomes visible (and before a write answers).
 */
export type WorldCommit =
  | { readonly kind: 'write'; readonly at: number; readonly attemptId: AttemptId; readonly agent: AgentId; readonly pixels: readonly WorldPixel[]; readonly state: AgentResourceState }
  | { readonly kind: 'external'; readonly at: number; readonly pixels: readonly WorldPixel[] }
  | { readonly kind: 'agent'; readonly at: number; readonly reason: string; readonly state: AgentResourceState };

/** A consistent view of the world (inside `withWorld`): never kept after the callback. */
export interface WorldView {
  readonly bounds: CanvasRect;
  readonly pixels: Int32Array;
  readonly agents: readonly AgentResourceState[];
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
  private readonly commitHook: SimulatedCanvasOptions['commit'];
  private readonly trackEvents: boolean;
  private readonly rememberResults: number;
  /** Serializes every change (staging, commit, publication). */
  private queue: Promise<unknown> = Promise.resolve();
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
    this.commitHook = options.commit;
    this.trackEvents = options.trackEvents ?? true;
    this.rememberResults = options.rememberResults ?? Number.POSITIVE_INFINITY;
    if (!(this.rememberResults >= 0)) throw new Error('rememberResults must be >= 0');
    const size = options.bounds.width * options.bounds.height;
    if (options.initial === undefined) {
      this.pixels = new Int32Array(size).fill(options.fill ?? TRANSPARENT);
    } else {
      if (options.initial.pixels.length !== size) throw new Error(`initial pixels: ${options.initial.pixels.length} values for a ${options.bounds.width}x${options.bounds.height} canvas`);
      this.pixels = Int32Array.from(options.initial.pixels);
      for (const state of options.initial.agents) {
        if (state.rules.id !== options.rules.id || state.rules.version !== options.rules.version) throw new Error(`initial agent ${state.agent}: state for other rules`);
        this.agents.set(state.agent, state);
      }
    }
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

  private assertMemoryOnly(what: string): void {
    if (this.commitHook !== undefined) throw new Error(`${what} is synchronous: on a durable world use its asynchronous form`);
  }

  /** Runs `fn` after every change already queued, before any later one. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async publish(change: WorldCommit): Promise<void> {
    if (this.commitHook !== undefined) await this.commitHook(change);
  }

  /** A consistent view of the world, with every change held until `fn` resolves (checkpoints). */
  withWorld<T>(fn: (view: WorldView) => Promise<T> | T): Promise<T> {
    return this.exclusive(() => fn({ bounds: this.bounds, pixels: this.pixels, agents: [...this.agents.values()] }));
  }

  private initialState(a: SimulatedAgent): AgentResourceState {
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
    return stateFromObservation(this.rules, observation);
  }

  /** Registers (or resets) an agent with its resources at the current time. */
  addAgent(a: SimulatedAgent): void {
    this.assertMemoryOnly('addAgent');
    this.agents.set(a.agent, this.initialState(a));
  }

  /** Registers (or resets) an agent; durable (Phase 1B.9). */
  setAgent(a: SimulatedAgent, reason = 'agent configured'): Promise<AgentResourceState> {
    return this.exclusive(async () => {
      const state = this.initialState(a);
      await this.publish({ kind: 'agent', at: this.clock.now(), reason, state });
      this.agents.set(a.agent, state);
      return state;
    });
  }

  /**
   * Replaces an agent's state with `update(current, now)` (a simulated
   * upgrade, a correction); durable. The update must keep the agent and
   * the rules.
   */
  updateAgent(agent: AgentId, update: (current: AgentResourceState, now: number) => AgentResourceState, reason: string): Promise<AgentResourceState> {
    return this.exclusive(async () => {
      const current = this.stateOf(agent);
      const now = this.clock.now();
      const state = update(current, now);
      if (state.agent !== agent || state.rules.id !== this.rules.id || state.rules.version !== this.rules.version) throw new Error('updateAgent: the update changed the agent or the rules');
      await this.publish({ kind: 'agent', at: now, reason, state });
      this.agents.set(agent, state);
      return state;
    });
  }

  /** The agent's resource state, advanced to now (the world's truth, for simulated upgrades). */
  agentState(agent: AgentId): AgentResourceState {
    return this.stateOf(agent);
  }

  /** Simulated agents. */
  agentIds(): AgentId[] {
    return [...this.agents.keys()];
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
    this.assertMemoryOnly('setAvailability');
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

  private record(event: CanvasEvent): void {
    if (this.trackEvents) this.events.push(event);
  }

  /** Another actor paints (no energy, no agent). */
  paint(point: CanvasPoint, color: Rgb): void {
    this.assertMemoryOnly('paint');
    const i = this.index(point);
    if (i < 0) throw new Error('point outside the canvas bounds');
    this.pixels[i] = color;
    this.record({ at: this.clock.now(), kind: 'external', point: { x: point.x, y: point.y }, color, agent: null, attemptId: null });
  }

  /** Another actor erases a pixel (empty again). */
  erase(point: CanvasPoint): void {
    this.assertMemoryOnly('erase');
    const i = this.index(point);
    if (i < 0) throw new Error('point outside the canvas bounds');
    this.pixels[i] = TRANSPARENT;
    this.record({ at: this.clock.now(), kind: 'external', point: { x: point.x, y: point.y }, color: TRANSPARENT, agent: null, attemptId: null });
  }

  /** Another actor edits several pixels at once (color, or TRANSPARENT to erase); durable. */
  editExternal(changes: readonly { readonly point: CanvasPoint; readonly color: number }[]): Promise<WorldPixel[]> {
    return this.exclusive(async () => {
      const staged = new Map<number, number>();
      for (const c of changes) {
        const i = this.index(c.point);
        if (i < 0) throw new Error('point outside the canvas bounds');
        staged.set(i, c.color);
      }
      const pixels = [...staged].map(([index, color]) => ({ index, color }));
      const at = this.clock.now();
      await this.publish({ kind: 'external', at, pixels });
      for (const p of pixels) {
        this.pixels[p.index] = p.color;
        this.record({ at, kind: 'external', point: this.pointOf(p.index), color: p.color, agent: null, attemptId: null });
      }
      return pixels;
    });
  }

  /** Canvas point of a raster index. */
  pointOf(index: number): CanvasPoint {
    const { minX, minY, width } = this.bounds;
    return { x: minX + (index % width), y: minY + Math.floor(index / width) };
  }

  /** Pixel value at a canvas point (UNKNOWN outside the bounds). */
  at(point: CanvasPoint): number {
    const i = this.index(point);
    return i < 0 ? UNKNOWN : this.pixels[i]!;
  }

  /** How many times agents applied a pixel at `point` (needs `trackEvents`). */
  appliedCount(point: CanvasPoint): number {
    if (!this.trackEvents) throw new Error('appliedCount needs trackEvents');
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

  private remember(attemptId: AttemptId, result: ApplyResult): void {
    if (this.rememberResults === 0) return;
    this.results.delete(attemptId);
    this.results.set(attemptId, result);
    while (this.results.size > this.rememberResults) this.results.delete(this.results.keys().next().value!);
  }

  /**
   * Applies the first `count` writes as ONE change: staged without touching
   * the world, committed, then made visible. Outcomes for all `count` writes.
   */
  private stageAndApply(agent: AgentId, writes: readonly PixelWrite[], attemptId: AttemptId, count: number): Promise<PixelWriteOutcome[]> {
    return this.exclusive(async () => {
      let state = this.stateOf(agent);
      const unlocked = new Set<number>(state.unlockedColors);
      const now = this.clock.now();
      const cost = this.rules.energy.costPerPixel;
      const staged = new Map<number, number>();
      const outcomes: PixelWriteOutcome[] = [];
      for (let k = 0; k < count; k++) {
        const w = writes[k]!;
        const i = this.index(w.point);
        const reject = (reason: PixelRejectionReason): PixelWriteOutcome => ({ taskId: w.taskId, status: 'rejected', reason });
        if (i < 0) outcomes.push(reject('out-of-bounds'));
        else if (!unlocked.has(w.color)) outcomes.push(reject('color-locked'));
        else if ((staged.get(i) ?? this.pixels[i]) === w.color) outcomes.push({ taskId: w.taskId, status: 'already-correct' });
        else if (state.energy < cost) outcomes.push(reject('no-energy'));
        else {
          state = consumeEnergy(this.rules, state, now, cost, now).state;
          staged.set(i, w.color);
          outcomes.push({ taskId: w.taskId, status: 'applied' });
        }
      }
      const pixels = [...staged].map(([index, color]) => ({ index, color }));
      await this.publish({ kind: 'write', at: now, attemptId, agent, pixels, state });
      this.agents.set(agent, state);
      for (const p of pixels) {
        this.pixels[p.index] = p.color;
        this.record({ at: now, kind: 'applied', point: this.pointOf(p.index), color: p.color, agent, attemptId });
      }
      return outcomes;
    });
  }

  private async applyHeld(agent: AgentId, writes: readonly PixelWrite[], attemptId: AttemptId, appliedBefore: boolean, signal?: AbortSignalLike): Promise<ApplyResult> {
    let outcomes = appliedBefore ? await this.stageAndApply(agent, writes, attemptId, writes.length) : null;
    const aborted = await new Promise<boolean>((resolve) => {
      this.held = () => resolve(false);
      signal?.addEventListener('abort', () => resolve(true));
    });
    this.held = null;
    if (aborted) throw new SimulatedCanvasError('aborted', 'write aborted while waiting for the answer');
    outcomes ??= await this.stageAndApply(agent, writes, attemptId, writes.length);
    const result: ApplyResult = { attemptId, outcomes, resources: this.observe(agent) };
    this.remember(attemptId, result);
    return result;
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
      this.remember(attemptId, result);
      return result;
    }
    if (fault?.kind === 'hold') return this.applyHeld(agent, writes, attemptId, fault.appliedBefore, signal);
    const count = fault?.kind === 'partial' ? Math.max(0, Math.min(fault.applied, writes.length)) : writes.length;
    const outcomes = await this.stageAndApply(agent, writes, attemptId, count);
    if (fault?.kind === 'partial') throw new SimulatedCanvasError('partial', `simulated failure after ${count} of ${writes.length} pixels`);
    const result: ApplyResult = {
      attemptId,
      outcomes: fault?.kind === 'unknown-outcomes' ? writes.map((w) => ({ taskId: w.taskId, status: 'unknown' })) : outcomes,
      resources: this.observe(agent),
    };
    this.remember(attemptId, result);
    if (fault?.kind === 'answer-lost') throw new SimulatedCanvasError('answer-lost', 'simulated loss of the answer after applying');
    return result;
  }
}
