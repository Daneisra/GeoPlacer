/**
 * GeoPlacer Phase 1B — proposed core interfaces (draft v2).
 * Status: PROPOSED (ADR 0002). Not compiled by the project build; checked with
 * tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess.
 * Target: packages/core (no I/O, no service-specific code, no DOM/Node types).
 */

// ───────────────────────── Shared primitives ─────────────────────────

type Brand<T, B extends string> = T & { readonly __brand: B };
export type TemplateId = Brand<string, 'TemplateId'>;
export type AgentId = Brand<string, 'AgentId'>;
/** Stable pixel-task key: taskIdOf(templateId, revision, x, y, color). */
export type TaskId = Brand<string, 'TaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;

/** 24-bit color 0xRRGGBB. GeoPixels accepts any hex color; Wplace uses a fixed palette. */
export type Rgb = Brand<number, 'Rgb'>;
/** Transparent pixel at the API level (TemplatePixel, CanvasPixel). */
export const TRANSPARENT = -1 as const;
/** Storage sentinel for a transparent pixel inside TemplateImage.pixels (outside the 24-bit RGB range). */
export const TRANSPARENT_U32 = 0xffffffff;
/** Canvas pixel that could not be read (outside bounds, not loaded). */
export const UNKNOWN = -2 as const;
export type TemplatePixel = Rgb | typeof TRANSPARENT;
export type CanvasPixel = Rgb | typeof TRANSPARENT | typeof UNKNOWN;

/** Minimal abort signal (structurally compatible with DOM/Node AbortSignal). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/** Injected time source, so every time-dependent rule is testable. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignalLike): Promise<void>;
}

/** Engine-wide configuration. V1 server enforces maxActiveAgents = 1; simulator tests may raise it. */
export interface EngineConfig {
  readonly maxActiveAgents: number;
  readonly leaseTtlMs: number;
  /** Upper bound of pixels planned per batch (bounded work window). */
  readonly maxBatchSize: number;
}
export const DEFAULT_MAX_ACTIVE_AGENTS = 1;

// ───────────────────────── Geometry ─────────────────────────

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle: x in [minX, minX + width), y in [minY, minY + height), whatever the y direction. */
export interface CanvasRect {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/** GeoPixels userscripts suggest y grows upward; Wplace tiles grow downward. */
export interface CoordinateSystem {
  readonly yAxis: 'down' | 'up';
  readonly bounds?: CanvasRect;
}

/**
 * The single, tested projection between template image space (top-down,
 * row-major) and canvas space. Every other module goes through it.
 */
export interface Projection {
  imageToCanvas(ix: number, iy: number, placement: TemplatePlacement, system: CoordinateSystem): CanvasPoint;
  canvasToImage(point: CanvasPoint, placement: TemplatePlacement, system: CoordinateSystem): { readonly ix: number; readonly iy: number };
  templateBounds(image: TemplateImage, placement: TemplatePlacement, system: CoordinateSystem): CanvasRect;
}

// ───────────────────────── Palette ─────────────────────────

/** A catalog of colors (for quantisation and the UI). What an agent can paint comes from ResourceSnapshot.unlockedColors only. */
export interface Palette {
  readonly id: string;
  readonly colors: readonly { readonly rgb: Rgb; readonly name?: string; readonly unlockCost?: number }[];
}

export type ColorMetric = 'oklab' | 'rgb-euclidean';

export interface QuantizeOptions {
  readonly metric: ColorMetric;
  /** Source pixels with alpha below this value become TRANSPARENT. */
  readonly alphaThreshold: number;
}

export interface PaletteManager {
  nearest(rgb: Rgb, palette: Palette, metric: ColorMetric): Rgb;
  /** Convert decoded RGBA pixels (row-major, top-down) into a template image. */
  quantize(rgba: Uint8ClampedArray, width: number, height: number, palette: Palette, options: QuantizeOptions): TemplateImage;
  missingColors(image: TemplateImage, available: ReadonlySet<Rgb>): ReadonlySet<Rgb>;
}

// ───────────────────────── Templates ─────────────────────────

/**
 * Row-major, top-down: pixel (ix, iy) is pixels[iy * width + ix], holding a
 * 24-bit RGB value or TRANSPARENT_U32. Read it through TemplateImageReader,
 * which maps TRANSPARENT_U32 to TRANSPARENT.
 */
export interface TemplateImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;
}

export interface TemplateImageReader {
  pixelAt(image: TemplateImage, ix: number, iy: number): TemplatePixel;
}

export interface TemplatePlacement {
  /** Canvas position of image pixel (0, 0), the top-left corner as seen on screen. */
  readonly topLeft: CanvasPoint;
}

export type DrawingStrategyId =
  | 'top-to-bottom'
  | 'bottom-to-top'
  | 'left-to-right'
  | 'right-to-left'
  | 'color-by-color'
  | 'outline-first'
  | 'center-out'
  | 'random';

export interface StrategyConfig {
  readonly id: DrawingStrategyId;
  /** Seed of the random strategy (deterministic and replayable). */
  readonly seed?: number;
  readonly colorOrder?: readonly Rgb[];
}

export type TemplateStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Template {
  readonly id: TemplateId;
  readonly name: string;
  /** Incremented on every image/placement change; attempts of older revisions are void. */
  readonly revision: number;
  readonly image: TemplateImage;
  readonly placement: TemplatePlacement;
  /** Higher first. */
  readonly priority: number;
  readonly status: TemplateStatus;
  readonly strategy: StrategyConfig;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TemplateManager {
  list(): readonly Template[];
  get(id: TemplateId): Template | undefined;
  create(input: Pick<Template, 'name' | 'image' | 'placement' | 'priority' | 'strategy'>): Template;
  update(id: TemplateId, patch: Partial<Pick<Template, 'name' | 'image' | 'placement' | 'priority' | 'strategy'>>): Template;
  pause(id: TemplateId): Template;
  resume(id: TemplateId): Template;
  /** Forget progress history; the canvas remains the source of truth. */
  reset(id: TemplateId): Template;
}

// ───────────────────────── Strategies ─────────────────────────

/**
 * Pure and deterministic: returns the drawing order as image pixel indices
 * (iy * width + ix) of the non-transparent pixels. Computed once per
 * (revision, strategy) and cached; ~1.4 s and ~55 MB for 2000x2000.
 */
export interface DrawingStrategy {
  readonly id: DrawingStrategyId;
  order(image: TemplateImage, config: StrategyConfig): Uint32Array;
}

// ───────────────────────── Canvas access ─────────────────────────

export interface CanvasSnapshot {
  readonly rect: CanvasRect;
  readonly takenAt: number;
  get(point: CanvasPoint): CanvasPixel;
}

export interface PixelWrite {
  readonly taskId: TaskId;
  readonly point: CanvasPoint;
  readonly color: Rgb;
}

export type PixelWriteOutcome =
  | { readonly taskId: TaskId; readonly status: 'applied' }
  | { readonly taskId: TaskId; readonly status: 'already-correct' }
  | { readonly taskId: TaskId; readonly status: 'rejected'; readonly reason: 'no-energy' | 'color-locked' | 'out-of-bounds' | 'rate-limited' | 'other' }
  | { readonly taskId: TaskId; readonly status: 'unknown' };

export interface ApplyResult {
  readonly attemptId: AttemptId;
  readonly outcomes: readonly PixelWriteOutcome[];
  readonly resources?: ResourceSnapshot;
}

export interface CanvasCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly maxPixelsPerWrite: number;
  /** True when the provider ignores a repeated attemptId. */
  readonly idempotentWrites: boolean;
}

/**
 * The only boundary between the engine and a canvas. V1 implementations:
 * SimulatedCanvasProvider (read + write) and SnapshotCanvasProvider
 * (read-only, from an image imported by the user). No public-service writer.
 */
export interface CanvasProvider {
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly capabilities: CanvasCapabilities;
  readRegion(rect: CanvasRect, signal?: AbortSignalLike): Promise<CanvasSnapshot>;
  applyPixels(agent: AgentId, writes: readonly PixelWrite[], options: { readonly attemptId: AttemptId; readonly signal?: AbortSignalLike }): Promise<ApplyResult>;
}

// ───────────────────────── Accounts / agents ─────────────────────────

export type AccountStatus = 'inactive' | 'ready' | 'cooldown' | 'expired' | 'suspended' | 'error';

/** Public view of an agent: never holds credentials (kept by a server-side SessionStore). */
export interface AccountSession {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly expiresAt?: number;
  readonly lastCheckedAt?: number;
}

export interface AccountManager {
  list(): readonly AccountSession[];
  get(id: AgentId): AccountSession | undefined;
  /** Throws when EngineConfig.maxActiveAgents would be exceeded. */
  activate(id: AgentId): AccountSession;
  deactivate(id: AgentId): AccountSession;
  activeAgents(): readonly AccountSession[];
}

// ───────────────────────── Resources ─────────────────────────

export type UpgradeKind = 'max-energy' | 'regen-speed' | 'energy-pack' | 'color-unlock';

/** Configurable per service; never hard-coded in the engine. */
export interface ResourceModel {
  readonly maxEnergy: number;
  readonly regenIntervalMs: number;
  readonly upgradeCosts: Readonly<Record<UpgradeKind, number>>;
}

export interface ResourceSnapshot {
  readonly energy: number;
  readonly maxEnergy: number;
  readonly currency: number;
  /** The single source of truth for the colors an agent can paint. */
  readonly unlockedColors: ReadonlySet<Rgb>;
  readonly observedAt: number;
}

export interface ResourceManager {
  observe(agent: AgentId, snapshot: ResourceSnapshot): void;
  latest(agent: AgentId): ResourceSnapshot | undefined;
  predictEnergy(agent: AgentId, at: number): number;
  timeUntil(agent: AgentId, energy: number, now: number): number;
  /** The single place where spending is recorded (no double counting). */
  recordSpend(agent: AgentId, energy: number, at: number): void;
}

export interface UpgradeProposal {
  readonly agent: AgentId;
  readonly kind: UpgradeKind;
  readonly cost: number;
  readonly rationale: string;
}

/** Only proposes. Any real spending requires an explicit UserConfirmation. */
export interface UpgradePlanner {
  propose(agent: AgentId, snapshot: ResourceSnapshot, model: ResourceModel): readonly UpgradeProposal[];
}

export interface UserConfirmation {
  readonly proposal: UpgradeProposal;
  readonly confirmedBy: 'user';
  readonly confirmedAt: number;
}

// ───────────────────────── Work planning & attempts ─────────────────────────

/**
 * Remaining work is never stored pixel by pixel: it is derived from
 * (template revision, strategy order, fresh canvas snapshot), because the
 * canvas is the source of truth (other players repaint it). Only in-flight
 * attempts, template state and history are persisted.
 */
export interface WorkPlanner {
  /**
   * Next pixels of a template, in strategy order, that differ from the
   * snapshot, are paintable by the agent and are not already in flight.
   * At most `max` items: a bounded window, never the whole template.
   */
  nextBatch(template: Template, snapshot: CanvasSnapshot, max: number, canPaint: (color: Rgb) => boolean, inFlight: ReadonlySet<TaskId>): readonly PixelWrite[];
}

export type AttemptState = 'leased' | 'started' | 'finished' | 'released' | 'reconciled';

export interface Attempt {
  readonly attemptId: AttemptId;
  readonly agent: AgentId;
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly writes: readonly PixelWrite[];
  readonly state: AttemptState;
  readonly leasedAt: number;
  readonly expiresAt: number;
  readonly outcomes?: readonly PixelWriteOutcome[];
}

/** Append-only journal entries (one JSON object per line; a torn last line is ignored on load). */
export type JournalEvent =
  | { readonly type: 'leased'; readonly attempt: Attempt }
  | { readonly type: 'started'; readonly attemptId: AttemptId; readonly at: number }
  | { readonly type: 'finished'; readonly attemptId: AttemptId; readonly outcomes: readonly PixelWriteOutcome[]; readonly at: number }
  | { readonly type: 'released'; readonly attemptId: AttemptId; readonly reason: string; readonly at: number }
  | { readonly type: 'reconciled'; readonly attemptId: AttemptId; readonly outcomes: readonly PixelWriteOutcome[]; readonly at: number };

export interface AttemptJournal {
  /** Replays the journal; returns the attempts still open plus how many trailing bytes were discarded. */
  load(): Promise<{ readonly open: readonly Attempt[]; readonly discardedTailBytes: number }>;
  append(event: JournalEvent): Promise<void>;
  /** Rewrites the journal with open attempts only (atomic); closed ones already live in the history. */
  compact(open: readonly Attempt[]): Promise<void>;
}

export interface HistoryEntry {
  readonly at: number;
  readonly agent: AgentId;
  readonly templateId: TemplateId;
  readonly attemptId: AttemptId;
  readonly applied: number;
  readonly alreadyCorrect: number;
  readonly rejected: number;
  readonly unknown: number;
}

/** Separate, rotated, append-only operation history (never compacted away). */
export interface HistoryStore {
  append(entry: HistoryEntry): Promise<void>;
  query(filter: { readonly templateId?: TemplateId; readonly agent?: AgentId; readonly since?: number; readonly limit: number }): Promise<readonly HistoryEntry[]>;
}

export interface AttemptManager {
  /** Builds and journals a lease; tasks in flight are excluded from later batches. */
  lease(agent: AgentId, template: Template, writes: readonly PixelWrite[], now: number): Promise<Attempt>;
  markStarted(attemptId: AttemptId, now: number): Promise<void>;
  finish(attemptId: AttemptId, outcomes: readonly PixelWriteOutcome[], now: number): Promise<void>;
  release(attemptId: AttemptId, reason: string, now: number): Promise<void>;
  inFlight(templateId: TemplateId): ReadonlySet<TaskId>;
  /**
   * Restart/crash recovery. Leased-but-not-started attempts are released.
   * Started-but-not-finished attempts are reconciled against a fresh canvas
   * read (pixel already correct => applied), never blindly retried.
   */
  recover(canvas: CanvasProvider, now: number): Promise<{ readonly released: number; readonly reconciled: number }>;
}

// ───────────────────────── Progress & estimates ─────────────────────────

export interface ColorProgress {
  readonly total: number;
  readonly correct: number;
}

export interface ProgressSnapshot {
  readonly templateId: TemplateId;
  readonly revision: number;
  readonly total: number;
  readonly correct: number;
  readonly wrongColor: number;
  readonly missing: number;
  readonly unknown: number;
  readonly percent: number;
  readonly byColor: ReadonlyMap<Rgb, ColorProgress>;
  readonly computedAt: number;
}

export interface ProgressCalculator {
  compute(template: Template, snapshot: CanvasSnapshot, system: CoordinateSystem, now: number): ProgressSnapshot;
}

/** Separate from progress: needs agents and resources. */
export interface EtaEstimator {
  /** Milliseconds to paint `remaining` pixels with the given agents, or null if impossible (no agent, no color). */
  estimate(remaining: number, agents: readonly AgentId[], resources: ResourceManager, model: ResourceModel, now: number): number | null;
}

// ───────────────────────── Scheduler & events ─────────────────────────

export type EngineEvent =
  | { readonly type: 'progress'; readonly progress: ProgressSnapshot; readonly etaMs: number | null }
  | { readonly type: 'resources'; readonly agent: AgentId; readonly resources: ResourceSnapshot }
  | { readonly type: 'agent-status'; readonly agent: AgentId; readonly status: AccountStatus }
  | { readonly type: 'attempt'; readonly entry: HistoryEntry }
  | { readonly type: 'error'; readonly message: string };

export interface EventSink {
  emit(event: EngineEvent): void;
}

export interface SchedulerDependencies {
  readonly config: EngineConfig;
  readonly clock: Clock;
  readonly canvas: CanvasProvider;
  readonly accounts: AccountManager;
  readonly resources: ResourceManager;
  readonly templates: TemplateManager;
  readonly planner: WorkPlanner;
  readonly attempts: AttemptManager;
  readonly history: HistoryStore;
  readonly events: EventSink;
}

export interface TickReport {
  readonly at: number;
  readonly attempts: number;
  readonly applied: number;
  readonly nextTickAt: number | null;
}

/** Works on a collection of agents; the number active is bounded by EngineConfig.maxActiveAgents. */
export interface TaskScheduler {
  tick(): Promise<TickReport>;
  start(): void;
  stop(): Promise<void>;
}

// ───────────────────────── Compile-time usage check ─────────────────────────

declare const deps: SchedulerDependencies;

async function example(): Promise<void> {
  const agent = 'agent-1' as AgentId;
  const template = deps.templates.list()[0];
  if (!template) return;
  const rect = new ProjectionUser().bounds(template, deps.canvas.coordinateSystem);
  const snapshot = await deps.canvas.readRegion(rect);
  const unlocked = deps.resources.latest(agent)?.unlockedColors ?? new Set<Rgb>();
  const batch = deps.planner.nextBatch(template, snapshot, deps.config.maxBatchSize, (c) => unlocked.has(c), deps.attempts.inFlight(template.id));
  const attempt = await deps.attempts.lease(agent, template, batch, deps.clock.now());
  await deps.attempts.markStarted(attempt.attemptId, deps.clock.now());
  const result = await deps.canvas.applyPixels(agent, attempt.writes, { attemptId: attempt.attemptId });
  await deps.attempts.finish(attempt.attemptId, result.outcomes, deps.clock.now());
}

declare const projection: Projection;
class ProjectionUser {
  bounds(template: Template, system: CoordinateSystem): CanvasRect {
    return projection.templateBounds(template.image, template.placement, system);
  }
}
void example;
