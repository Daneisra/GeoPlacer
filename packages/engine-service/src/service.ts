/**
 * EngineService (Phase 1B.9): the orchestration service of the server.
 *
 * It only WIRES the existing components (TemplateManager, WorkPlanner and
 * AttemptManager through the scheduler, AttemptJournal, ResourceManager,
 * progress, ETA, UpgradePlanner) to the ONLY canvas provider of V1, the
 * local SimulatedCanvasProvider, made durable by FileWorldStore. It
 * re-implements no rule: it decides which command is allowed in which
 * state, keeps the settings, and feeds the event stream.
 *
 * One data directory = one engine: the directory lock (plus the named pipe
 * guard on Windows) is taken first; a second instance is refused.
 */

import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentId,
  AttemptId,
  AttemptManager,
  CanvasRect,
  ProgressSnapshot,
  ProjectId,
  ResourceManager,
  ResourceRules,
  SchedulerConfig,
  SchedulerEvent,
  SchedulerState,
  SchedulerStatus,
  TaskScheduler,
  Template,
  TemplateId,
  TemplateManager,
  TemplateRef,
  UpgradeProposal,
} from '@geoplacer/core';
import {
  DEFAULT_AUTO_COMPACTION,
  TRANSPARENT,
  advance,
  applyConfirmedUpgrade,
  asProjectId,
  asTemplateId,
  capacityOf,
  computeProgress,
  confirmUpgrade,
  createAttemptManager,
  createResourceManager,
  createScheduler,
  createTemplateManager,
  proposeUpgrades,
  regenIntervalOf,
  stateFingerprint,
} from '@geoplacer/core';
import {
  FileAttemptJournal,
  FileHistoryStore,
  NodeTemplateStorage,
  acquireDataDirectoryLock,
  diagnoseJournal,
  nodeSha256Hasher,
  pngjsCodec,
  randomIdSource,
  systemClock,
  type DataDirectoryLock,
} from '@geoplacer/adapters-node';
import { SimulatedCanvasProvider, type WorldCommit } from '@geoplacer/simulator';
import { monotonicClock, type MonotonicClock } from './clock.js';
import { EngineEventHub, type EngineEventEnvelope } from './events.js';
import {
  DEMO_PALETTE,
  SIMULATED_AGENT,
  SIMULATION_PROJECT,
  STRATEGIES,
  loadSettings,
  rulesOf,
  saveSettings,
  validateSettings,
  worldIdentityChanged,
  type AgentSettings,
  type EngineSettings,
  type RunSettings,
  type SimulatorSettings,
} from './settings.js';
import { FileWorldStore, WorldStoreError, type FileWorldStoreOptions, type WorldIdentity } from './world-store.js';
import { assertNoRestoreInProgress, createBackup, type BackupManifest } from './backup.js';
import { DEMO_POSITION, DEMO_SETTINGS, DEMO_STRATEGY, DEMO_TEMPLATE_NAME, DEMO_WIDTH, DEMO_HEIGHT, demoRgba } from './demo.js';

export type EngineErrorCode =
  | 'NO_TEMPLATE_SELECTED'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_OUTSIDE_CANVAS'
  | 'ENGINE_BUSY'
  | 'NOT_RUNNING'
  | 'NOT_PAUSED'
  | 'PAUSED_USE_RESUME'
  | 'COMPACTION_IN_PROGRESS'
  | 'COMPACTION_REFUSED'
  | 'WORLD_UNAVAILABLE'
  | 'WORLD_RESET_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'STALE_PROPOSAL'
  | 'UPGRADE_REFUSED'
  | 'INVALID_REQUEST'
  | 'BACKUP_FAILED'
  | 'DEMO_NEEDS_EMPTY_PROJECT'
  | 'ENGINE_CLOSED';

/** A refused command: stable code, HTTP status suggestion, readable message. */
export class EngineServiceError extends Error {
  readonly code: EngineErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: EngineErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'EngineServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Scheduler states in which the loop is alive. */
const ACTIVE: ReadonlySet<SchedulerState> = new Set(['initializing', 'running', 'paused', 'waiting-resources', 'waiting-reconciliation']);
/** Default: world checkpoint after this many logged changes. */
export const WORLD_CHECKPOINT_RECORDS = 2_000;
const RECENT_ATTEMPTS = 100;
const MAX_REGION_PIXELS = 2048 * 2048;

export interface EngineServiceOptions {
  /** Data directory of the engine (locked for the life of the service). */
  readonly dataDir: string;
  /** Default: real time, monotonic (never before the saved world). */
  readonly clock?: MonotonicClock;
  /** Event grouping interval (default 250 ms). */
  readonly eventIntervalMs?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test hook: options of the world store (named steps of the crash tests). */
  readonly worldStore?: FileWorldStoreOptions;
  /** World checkpoint after this many logged changes (default WORLD_CHECKPOINT_RECORDS). */
  readonly worldCheckpointRecords?: number;
  /** Where backups are written (default: `<dataDir>/../sauvegardes`); never chosen by a client. */
  readonly backupDir?: string;
}

export interface CommandResult {
  /** False when the command found the engine already in the requested state (idempotent). */
  readonly changed: boolean;
  readonly status: EngineStatus;
}

export interface TemplateInfo {
  readonly templateId: string;
  readonly name: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly paintablePixels: number;
  readonly strategy: string;
  readonly placement: { readonly x: number; readonly y: number } | null;
  readonly updatedAt: number;
}

export interface EngineStatus {
  /** V1: always a local simulation. */
  readonly mode: 'simulation';
  readonly state: SchedulerState;
  readonly reason: string | null;
  readonly stream: string;
  readonly seq: number;
  readonly selection: TemplateInfo | null;
  readonly commands: { readonly start: boolean; readonly pause: boolean; readonly resume: boolean; readonly stop: boolean };
  readonly scheduler: SchedulerStatus | null;
  readonly world: {
    readonly available: boolean;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly width: number;
    readonly height: number;
    readonly generation: number | null;
    readonly changesSinceCheckpoint: number | null;
  };
  readonly journal: { readonly openAttempts: number; readonly toReconcileAtStart: number; readonly damaged: boolean; readonly compacting: boolean };
  readonly instance: { readonly lock: string; readonly guard: string; readonly guardDetail: string | null };
  readonly settings: EngineSettings;
  readonly lastActivityAt: number | null;
}

export interface CanvasRegion {
  readonly stream: string;
  /** Events with a sequence number up to this one are already included. */
  readonly seq: number;
  readonly rect: CanvasRect;
  /** True when the default region (the selected template) was too large for one read: its top-left part. */
  readonly truncated: boolean;
  readonly observedAt: number;
  /** Little-endian int32 per pixel (0xRRGGBB, -1 empty), row-major, base64. */
  readonly data: string;
}

export interface ResourcesView {
  readonly agent: string;
  readonly simulated: true;
  readonly observedAt: number;
  readonly energy: number;
  readonly capacity: number;
  readonly regenIntervalMs: number;
  readonly costPerPixel: number;
  readonly currency: number;
  readonly upgrades: { readonly maxEnergy: number; readonly regenSpeed: number; readonly energyPacks: number };
  readonly unlockedColors: readonly number[];
  readonly lockedColors: readonly { readonly color: number; readonly cost: number }[];
  readonly nextEnergyAt: number | null;
  readonly proposals: readonly UpgradeProposal[];
  /** Why no proposal could be computed (no template selected...), null otherwise. */
  readonly proposalsUnavailable: string | null;
}

interface AttemptRecord {
  readonly attemptId: string;
  readonly state: string;
  readonly pixels: number;
  readonly applied: number;
  readonly at: number;
}

export class EngineService {
  readonly root: string;
  private readonly lock: DataDirectoryLock;
  private readonly clock: MonotonicClock;
  private readonly hub: EngineEventHub;
  private readonly log: NonNullable<EngineServiceOptions['log']>;
  readonly templates: TemplateManager;
  private readonly journal: FileAttemptJournal;
  private readonly history: FileHistoryStore;
  private settingsValue: EngineSettings;
  private rules: ResourceRules;
  private world: { canvas: SimulatedCanvasProvider; store: FileWorldStore } | null = null;
  private worldError: { code: string; message: string } | null = null;
  private resources!: ResourceManager;
  private attempts!: AttemptManager;
  private scheduler: TaskScheduler | null = null;
  private schedulerEnded = true;
  private unsubscribe: (() => void) | null = null;
  private stopping: Promise<CommandResult> | null = null;
  private starting: Promise<CommandResult> | null = null;
  private compacting = false;
  private checkpointing: Promise<void> | null = null;
  private toReconcileAtStart = 0;
  private journalDamaged = false;
  private lastProgress: ProgressSnapshot | null = null;
  private lastActivityAt: number | null = null;
  private readonly recent: AttemptRecord[] = [];
  private proposalBase: { readonly state: ReturnType<SimulatedCanvasProvider['agentState']>; readonly proposals: readonly UpgradeProposal[] } | null = null;
  private closed = false;
  private readonly worldStoreOptions: FileWorldStoreOptions;
  private readonly checkpointRecords: number;
  private readonly backupDir: string;
  private backingUp = false;
  /** Decoded templates by id (current revision only), a few at most. */
  private readonly templateCache = new Map<string, Template>();

  private constructor(root: string, lock: DataDirectoryLock, settings: EngineSettings, clock: MonotonicClock, options: EngineServiceOptions) {
    this.root = root;
    this.lock = lock;
    this.settingsValue = settings;
    this.rules = rulesOf(settings.simulator);
    this.clock = clock;
    this.log = options.log ?? (() => undefined);
    this.worldStoreOptions = options.worldStore ?? {};
    this.checkpointRecords = options.worldCheckpointRecords ?? WORLD_CHECKPOINT_RECORDS;
    this.backupDir = path.resolve(options.backupDir ?? path.join(root, '..', 'sauvegardes'));
    this.hub = new EngineEventHub({ intervalMs: options.eventIntervalMs ?? 250, now: () => this.clock.now() });
    this.templates = createTemplateManager({ storage: new NodeTemplateStorage(lock), hasher: nodeSha256Hasher, codec: pngjsCodec, ids: randomIdSource, clock: systemClock });
    this.journal = new FileAttemptJournal(lock);
    this.history = new FileHistoryStore(lock);
  }

  /** Opens the engine on `dataDir`; throws DataDirectoryLockedError when another instance holds it. */
  static async open(options: EngineServiceOptions): Promise<EngineService> {
    const root = path.resolve(options.dataDir);
    // An interrupted restore must be finished (or rolled back) first (Phase 1B.10).
    await assertNoRestoreInProgress(root);
    const lock = await acquireDataDirectoryLock(root);
    try {
      const settings = await loadSettings(root);
      const service = new EngineService(root, lock, settings, options.clock ?? monotonicClock(), options);
      await service.openWorld();
      await service.newManagers();
      const selection = settings.selection;
      if (selection !== null) await service.currentTemplate(service.ref(selection.templateId)).catch(() => service.log('warn', `selected template ${selection.templateId} cannot be loaded`));
      return service;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  // ───────────────────────── World ─────────────────────────

  private identity(s: SimulatorSettings = this.settingsValue.simulator): WorldIdentity {
    return { bounds: { minX: 0, minY: 0, width: s.width, height: s.height }, coordinateSystem: { yAxis: 'down' }, rules: { id: this.rules.id, version: this.rules.version } };
  }

  private worldDir(): string {
    return path.join(this.root, 'world');
  }

  /** Opens the durable simulated world; on damage or mismatch the engine stays usable for diagnosis and reset. */
  private async openWorld(): Promise<void> {
    const identity = this.identity();
    let store: FileWorldStore | null = null;
    const commit = async (change: WorldCommit): Promise<void> => {
      await store!.append(change);
      if (change.kind !== 'agent') this.hub.canvas(change.pixels);
    };
    const options = { bounds: identity.bounds, coordinateSystem: identity.coordinateSystem, rules: this.rules, clock: this.clock, writeLatencyMs: this.settingsValue.simulator.writeLatencyMs, commit, trackEvents: false, rememberResults: 0 };
    try {
      const opened = await FileWorldStore.open(this.worldDir(), identity, this.worldStoreOptions);
      let canvas: SimulatedCanvasProvider;
      if (opened.kind === 'fresh') {
        canvas = new SimulatedCanvasProvider(options);
        store = await canvas.withWorld((view) => FileWorldStore.create(this.worldDir(), identity, view, this.worldStoreOptions));
        await canvas.setAgent(this.agentSeed(this.settingsValue.agent), 'simulated agent created');
        this.log('info', 'simulated world created');
      } else {
        store = opened.store;
        for (const a of opened.world.agents) this.clock.atLeast(a.at);
        canvas = new SimulatedCanvasProvider({ ...options, initial: opened.world });
        if (!canvas.agentIds().includes(SIMULATED_AGENT)) await canvas.setAgent(this.agentSeed(this.settingsValue.agent), 'simulated agent created');
        this.log('info', `simulated world restored (generation ${opened.report.generation}, ${opened.report.replayed} change(s) replayed${opened.report.tornTailCut ? ', torn last change cut off' : ''})`);
      }
      this.world = { canvas, store };
      this.worldError = null;
    } catch (error) {
      if (!(error instanceof WorldStoreError)) throw error;
      this.world = null;
      this.worldError = { code: error.code, message: error.message };
      this.log('error', `simulated world unavailable: ${error.message}`);
    }
  }

  private agentSeed(a: AgentSettings) {
    return { agent: SIMULATED_AGENT, energy: a.startEnergy, currency: a.startCurrency, unlockedColors: this.rules.palette.initialColors };
  }

  private requireWorld(): { canvas: SimulatedCanvasProvider; store: FileWorldStore } {
    if (this.world === null) throw new EngineServiceError('WORLD_UNAVAILABLE', 409, `the simulated world is unavailable (${this.worldError?.code ?? 'unknown'}): ${this.worldError?.message ?? ''} An explicit reset is needed.`);
    return this.world;
  }

  /** A checkpoint of the world when its log grows (never two at a time). */
  private maybeCheckpoint(): void {
    const w = this.world;
    if (w === null || this.checkpointing !== null || w.store.recordsSinceCheckpoint < this.checkpointRecords) return;
    this.checkpointing = w.canvas
      .withWorld((view) => w.store.checkpoint(view))
      .catch((error: unknown) => this.log('error', `world checkpoint failed: ${String(error)}`))
      .finally(() => {
        this.checkpointing = null;
      });
  }

  // ───────────────────────── Managers and scheduler ─────────────────────────

  /** A fresh ResourceManager and AttemptManager over the journal (like a new process), recovered. */
  private async newManagers(): Promise<void> {
    this.resources = createResourceManager(this.rules);
    this.attempts = createAttemptManager({
      journal: this.journal,
      history: this.history,
      resources: this.resources,
      newAttemptId: () => randomUUID() as AttemptId,
      autoCompaction: DEFAULT_AUTO_COMPACTION,
    });
    const report = await this.attempts.recover(this.clock.now());
    this.toReconcileAtStart = report.toReconcile.length;
    this.journalDamaged = report.damaged;
    if (report.toReconcile.length > 0) this.log('warn', `${report.toReconcile.length} attempt(s) interrupted before their answer: reconciled against the simulated canvas at the next start`);
  }

  private get state(): SchedulerState {
    return this.scheduler === null ? 'stopped' : this.scheduler.status().state;
  }

  private get active(): boolean {
    return this.scheduler !== null && !this.schedulerEnded && ACTIVE.has(this.state);
  }

  get settings(): EngineSettings {
    return this.settingsValue;
  }

  private ref(templateId: string): TemplateRef {
    return { projectId: asProjectId(SIMULATION_PROJECT), templateId: asTemplateId(templateId) };
  }

  /** The current revision, decoded once per revision (the scheduler asks at every cycle). */
  private async currentTemplate(ref: TemplateRef): Promise<Template> {
    const manifest = await this.templates.manifest(ref);
    const cached = this.templateCache.get(ref.templateId);
    if (cached !== undefined && cached.revision === manifest.currentRevision) return cached;
    const loaded = await this.templates.load(ref);
    if (this.templateCache.size >= 4) {
      const selected = this.settingsValue.selection?.templateId;
      for (const id of this.templateCache.keys()) if (id !== selected) this.templateCache.delete(id);
    }
    this.templateCache.set(ref.templateId, loaded.template);
    return loaded.template;
  }

  /** The selected template as last loaded (null: none selected, or not loaded yet). */
  private get selectedTemplate(): Template | null {
    const id = this.settingsValue.selection?.templateId;
    return id === undefined ? null : (this.templateCache.get(id) ?? null);
  }

  /** Time per pixel of a write, for the ETA (the simulated latency spread over a batch). */
  private msPerPixel(): number {
    return Math.ceil(this.settingsValue.simulator.writeLatencyMs / Math.max(1, this.settingsValue.run.maxBatchSize));
  }

  private schedulerConfig(templateId: TemplateId): SchedulerConfig {
    const run: RunSettings = this.settingsValue.run;
    return {
      projectId: asProjectId(SIMULATION_PROJECT) as ProjectId,
      templateId,
      agents: [SIMULATED_AGENT],
      maxActiveAgents: 1,
      maxBatchSize: run.maxBatchSize,
      minBatchSize: run.minBatchSize,
      leaseTtlMs: 120_000,
      unknownPixels: 'skip',
      freshness: { simulated: { maxAgeMs: 60_000 } },
      maxResourceAgeMs: 30_000,
      eta: { msPerPixel: this.msPerPixel(), minCoveragePercent: 0 },
      reconcileRetryMs: 1_000,
      // Revision and canvas re-checked at least every 5 s while waiting.
      maxWaitMs: 5_000,
      maxRecentErrors: 20,
      maxCycles: null,
    };
  }

  private onSchedulerEvent(e: SchedulerEvent): void {
    switch (e.type) {
      case 'state':
        this.hub.state(e.from, e.to, e.reason);
        this.hub.statusNow(this.status());
        break;
      case 'cycle':
        this.lastActivityAt = e.status.at;
        this.hub.status(this.status());
        this.maybeCheckpoint();
        break;
      case 'attempt': {
        const rec: AttemptRecord = { attemptId: e.attemptId, state: e.state, pixels: e.pixels, applied: e.applied, at: e.at };
        this.recent.unshift(rec);
        if (this.recent.length > RECENT_ATTEMPTS) this.recent.length = RECENT_ATTEMPTS;
        this.lastActivityAt = e.at;
        this.hub.attempt(rec);
        break;
      }
      case 'progress':
        this.lastProgress = e.progress;
        break;
      case 'error':
        this.hub.error(e.error.code, e.error.message);
        break;
    }
  }

  // ───────────────────────── Status ─────────────────────────

  /** Paintable pixels per template revision (a revision never changes: safe to keep). */
  private readonly paintableCache = new Map<string, number>();

  private templateInfo(t: Template): TemplateInfo {
    const key = `${t.id}:${t.revision}`;
    let paintable = this.paintableCache.get(key);
    if (paintable === undefined) {
      paintable = 0;
      for (const p of t.image.pixels) if (p !== 0xffffffff) paintable++;
      if (this.paintableCache.size > 64) this.paintableCache.clear();
      this.paintableCache.set(key, paintable);
    }
    return {
      templateId: t.id,
      name: t.name,
      revision: t.revision,
      width: t.image.width,
      height: t.image.height,
      paintablePixels: paintable,
      strategy: t.strategy.id,
      placement: { x: t.placement.topLeft.x, y: t.placement.topLeft.y },
      updatedAt: t.updatedAt,
    };
  }

  status(): EngineStatus {
    const state = this.state;
    const sched = this.scheduler?.status() ?? null;
    const selected = this.settingsValue.selection;
    const ended = this.scheduler === null || this.schedulerEnded || !ACTIVE.has(state);
    return {
      mode: 'simulation',
      state,
      reason: sched?.reason ?? (this.worldError !== null ? `simulated world unavailable: ${this.worldError.code}` : null),
      stream: this.hub.stream,
      seq: this.hub.seq,
      selection: this.selectedTemplate === null ? null : this.templateInfo(this.selectedTemplate),
      commands: {
        start: ended && selected !== null && this.world !== null && this.stopping === null && this.starting === null,
        pause: !ended && state !== 'paused' && this.stopping === null,
        resume: !ended && state === 'paused' && this.stopping === null,
        stop: !ended && this.stopping === null,
      },
      scheduler: sched,
      world: {
        available: this.world !== null,
        error: this.worldError,
        width: this.settingsValue.simulator.width,
        height: this.settingsValue.simulator.height,
        generation: this.world?.store.generation ?? null,
        changesSinceCheckpoint: this.world?.store.recordsSinceCheckpoint ?? null,
      },
      journal: { openAttempts: this.attempts.open().length, toReconcileAtStart: this.toReconcileAtStart, damaged: this.journalDamaged, compacting: this.compacting },
      instance: { lock: this.lock.mechanism, guard: this.lock.guard.status, guardDetail: this.lock.guard.detail },
      settings: this.settingsValue,
      lastActivityAt: this.lastActivityAt,
    };
  }

  /** Resolves when the current run ends (completed, error or stopped); at once when none runs. */
  async done(): Promise<EngineStatus> {
    if (this.scheduler !== null) await this.scheduler.done();
    return this.status();
  }

  subscribe(listener: (e: EngineEventEnvelope) => void): () => void {
    return this.hub.subscribe(listener);
  }

  /** Events sent so far (sequence number) and the stream id. */
  get stream(): { readonly id: string; readonly seq: number } {
    return { id: this.hub.stream, seq: this.hub.seq };
  }

  private guard(): void {
    if (this.closed) throw new EngineServiceError('ENGINE_CLOSED', 503, 'the engine is shutting down');
  }

  private requireIdle(what: string): void {
    if (this.active || this.stopping !== null) throw new EngineServiceError('ENGINE_BUSY', 409, `${what} is refused while the simulation runs: stop it first`);
  }

  // ───────────────────────── Commands ─────────────────────────

  /** Starts the simulation; two starts at once share one start (the second reports no change). */
  async start(): Promise<CommandResult> {
    this.guard();
    if (this.starting !== null) {
      await this.starting.catch(() => undefined);
      return { changed: false, status: this.status() };
    }
    this.starting = this.startNow();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startNow(): Promise<CommandResult> {
    if (this.stopping !== null) throw new EngineServiceError('ENGINE_BUSY', 409, 'a stop is in progress');
    if (this.active) {
      if (this.state === 'paused') throw new EngineServiceError('PAUSED_USE_RESUME', 409, 'the simulation is paused: use resume');
      return { changed: false, status: this.status() };
    }
    const world = this.requireWorld();
    const selection = this.settingsValue.selection;
    if (selection === null) throw new EngineServiceError('NO_TEMPLATE_SELECTED', 409, 'select a template first');
    const ref = this.ref(selection.templateId);
    let template: Template;
    try {
      template = await this.currentTemplate(ref);
    } catch {
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${selection.templateId} cannot be loaded`);
    }
    this.assertInsideCanvas(template.image.width, template.image.height, template.placement.topLeft.x, template.placement.topLeft.y);
    this.unsubscribe?.();
    await this.newManagers();
    const scheduler = createScheduler(this.schedulerConfig(ref.templateId), {
      clock: this.clock,
      canvas: world.canvas,
      templates: { current: (r) => this.currentTemplate(r) },
      resourceSource: world.canvas.resourceSource(),
      resources: this.resources,
      attempts: this.attempts,
      hasher: nodeSha256Hasher,
    });
    this.scheduler = scheduler;
    this.schedulerEnded = false;
    this.unsubscribe = scheduler.subscribe((e) => this.onSchedulerEvent(e));
    await scheduler.start();
    // After start(): before it, done() resolves at once (no loop yet).
    void scheduler.done().then(
      (final) => {
        if (this.scheduler === scheduler) this.schedulerEnded = true;
        this.log(final.state === 'error' ? 'error' : 'info', `simulation ended: ${final.state}${final.reason === null ? '' : ` (${final.reason})`}`);
        this.hub.statusNow(this.status());
      },
      (error: unknown) => {
        if (this.scheduler === scheduler) this.schedulerEnded = true;
        this.log('error', `simulation loop failed: ${String(error)}`);
      }
    );
    this.toReconcileAtStart = 0;
    this.log('info', `simulation started on template ${template.name} (revision ${template.revision})`);
    return { changed: true, status: this.status() };
  }

  async pause(): Promise<CommandResult> {
    this.guard();
    if (!this.active) throw new EngineServiceError('NOT_RUNNING', 409, 'the simulation is not running');
    if (this.stopping !== null) throw new EngineServiceError('ENGINE_BUSY', 409, 'a stop is in progress');
    if (this.state === 'paused') return { changed: false, status: this.status() };
    await this.scheduler!.pause();
    return { changed: true, status: this.status() };
  }

  resume(): CommandResult {
    this.guard();
    if (!this.active) throw new EngineServiceError('NOT_PAUSED', 409, 'nothing to resume: the simulation is not running (use start)');
    if (this.stopping !== null) throw new EngineServiceError('ENGINE_BUSY', 409, 'a stop is in progress');
    if (this.state !== 'paused') return { changed: false, status: this.status() };
    this.scheduler!.resume();
    return { changed: true, status: this.status() };
  }

  /**
   * Stops after the operation in progress, or during it with `abort` (the
   * write gets the abort signal). A started attempt is never abandoned
   * silently: it is reconciled, or reported open and reconciled at the next
   * start. Concurrent stops share one result.
   */
  stop(options: { readonly abort?: boolean } = {}): Promise<CommandResult> {
    if (this.stopping !== null) return this.stopping;
    if (!this.active) return Promise.resolve({ changed: false, status: this.status() });
    const scheduler = this.scheduler!;
    this.stopping = (async () => {
      try {
        await scheduler.stop({ abort: options.abort === true });
        this.schedulerEnded = true;
      } finally {
        this.stopping = null;
      }
      // Computed once the stop is over: the answer and the event offer the same commands.
      const status = this.status();
      this.hub.statusNow(status);
      return { changed: true, status };
    })();
    return this.stopping;
  }

  // ───────────────────────── Templates ─────────────────────────

  private assertInsideCanvas(width: number, height: number, x: number, y: number): void {
    const s = this.settingsValue.simulator;
    if (x < 0 || y < 0 || x + width > s.width || y + height > s.height) {
      throw new EngineServiceError('TEMPLATE_OUTSIDE_CANVAS', 409, `the template (${width}x${height} at ${x}, ${y}) does not fit in the simulated canvas (${s.width}x${s.height})`);
    }
  }

  async listTemplates(): Promise<{ readonly templates: readonly TemplateInfo[]; readonly unreadable: number }> {
    const listing = await this.templates.list(asProjectId(SIMULATION_PROJECT));
    return {
      templates: listing.templates.map((t) => ({
        templateId: t.templateId,
        name: t.name,
        revision: t.currentRevision,
        width: t.width,
        height: t.height,
        paintablePixels: t.paintablePixels,
        strategy: t.strategy.id,
        placement: null,
        updatedAt: t.updatedAt,
      })),
      unreadable: listing.failures.length,
    };
  }

  async importTemplate(input: { readonly name: string; readonly png: Uint8Array; readonly x: number; readonly y: number; readonly strategy: string }): Promise<TemplateInfo> {
    this.guard();
    if (!STRATEGIES.includes(input.strategy as never)) throw new EngineServiceError('INVALID_REQUEST', 400, `unknown strategy ${input.strategy}`);
    const t = await this.templates.create({
      projectId: asProjectId(SIMULATION_PROJECT),
      name: input.name,
      sourcePng: input.png,
      palette: DEMO_PALETTE,
      placement: { topLeft: { x: input.x, y: input.y } },
      coordinateSystem: { yAxis: 'down' },
      strategy: { id: input.strategy as never, ...(input.strategy === 'random' ? { seed: 1 } : {}) },
    });
    return this.templateInfo(t);
  }

  async templateInfoOf(templateId: string): Promise<TemplateInfo> {
    try {
      return this.templateInfo(await this.currentTemplate(this.ref(templateId)));
    } catch {
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    }
  }

  async selectTemplate(templateId: string): Promise<CommandResult> {
    this.guard();
    const info = await this.templateInfoOf(templateId);
    if (this.settingsValue.selection?.templateId === templateId) return { changed: false, status: this.status() };
    this.requireIdle('changing the template');
    this.assertInsideCanvas(info.width, info.height, info.placement?.x ?? 0, info.placement?.y ?? 0);
    await this.saveSettingsValue({ ...this.settingsValue, selection: { templateId } });
    await this.currentTemplate(this.ref(templateId));
    this.scheduler = null;
    this.schedulerEnded = true;
    this.lastProgress = null;
    this.proposalBase = null;
    return { changed: true, status: this.status() };
  }

  /**
   * Moves a template (a new revision). Allowed while the simulation runs:
   * the scheduler sees the new revision, cancels the attempts not started
   * and reconciles the started ones (never painted twice).
   */
  async moveTemplate(templateId: string, x: number, y: number): Promise<TemplateInfo> {
    this.guard();
    const info = await this.templateInfoOf(templateId);
    this.assertInsideCanvas(info.width, info.height, x, y);
    await this.templates.revise(this.ref(templateId), { placement: { topLeft: { x, y } } });
    return this.templateInfoOf(templateId);
  }

  /** Quantized image of the current revision (0xRRGGBB, or -1 transparent), for the overlay. */
  async templateImage(templateId: string): Promise<{ readonly width: number; readonly height: number; readonly x: number; readonly y: number; readonly data: string }> {
    const t = await this.currentTemplate(this.ref(templateId)).catch(() => {
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    });
    const out = new Int32Array(t.image.pixels.length);
    for (let i = 0; i < out.length; i++) {
      const p = t.image.pixels[i]!;
      out[i] = p === 0xffffffff ? TRANSPARENT : p & 0xffffff;
    }
    return { width: t.image.width, height: t.image.height, x: t.placement.topLeft.x, y: t.placement.topLeft.y, data: base64(out) };
  }

  // ───────────────────────── Settings ─────────────────────────

  private async saveSettingsValue(next: EngineSettings): Promise<void> {
    const valid = validateSettings(next);
    await saveSettings(this.root, valid);
    this.settingsValue = valid;
  }

  /**
   * Changes the simulation settings (stopped only). A change of the canvas
   * size or of the resource rules changes the identity of the simulated
   * world: it needs `resetWorld` (explicit), never a silent loss.
   */
  async configure(patch: { readonly simulator?: Partial<Omit<SimulatorSettings, 'rulesVersion'>>; readonly agent?: Partial<AgentSettings>; readonly run?: Partial<RunSettings>; readonly resetWorld?: boolean }): Promise<CommandResult> {
    this.guard();
    this.requireIdle('changing the settings');
    const current = this.settingsValue;
    const simulator = { ...current.simulator, ...patch.simulator, rulesVersion: current.simulator.rulesVersion };
    const changesIdentity = worldIdentityChanged(current.simulator, simulator);
    if (changesIdentity && patch.resetWorld !== true) {
      throw new EngineServiceError('WORLD_RESET_REQUIRED', 409, 'a new canvas size or new resource rules need a reset of the simulated world (resetWorld: true): its pixels and resources are lost');
    }
    const next: EngineSettings = {
      ...current,
      simulator: patch.resetWorld === true ? { ...simulator, rulesVersion: current.simulator.rulesVersion + 1 } : simulator,
      agent: { ...current.agent, ...patch.agent },
      run: { ...current.run, ...patch.run },
    };
    validateSettings(next);
    if (patch.resetWorld === true) {
      await this.saveSettingsValue(next);
      await this.resetWorldNow('settings changed');
    } else {
      const latencyChanged = next.simulator.writeLatencyMs !== current.simulator.writeLatencyMs;
      await this.saveSettingsValue(next);
      if (latencyChanged && this.world !== null) await this.reopenWorld();
    }
    return { changed: true, status: this.status() };
  }

  private async reopenWorld(): Promise<void> {
    await this.checkpointing;
    await this.world?.store.close();
    this.world = null;
    await this.openWorld();
    this.hub.canvasResync('simulated world reopened');
  }

  /**
   * Explicit reset of the simulated world (stopped only, confirmation
   * required): the old world directory is KEPT aside (`world-reset-<time>`),
   * a new empty world and a new agent are created. Open attempts are
   * reconciled against the new world at the next start.
   */
  async resetWorld(confirm: string): Promise<CommandResult> {
    this.guard();
    this.requireIdle('resetting the simulated world');
    if (confirm !== 'RESET') throw new EngineServiceError('CONFIRMATION_REQUIRED', 400, 'confirm the reset with "RESET"');
    await this.saveSettingsValue({ ...this.settingsValue, simulator: { ...this.settingsValue.simulator, rulesVersion: this.settingsValue.simulator.rulesVersion + 1 } });
    await this.resetWorldNow('explicit reset');
    return { changed: true, status: this.status() };
  }

  private async resetWorldNow(reason: string): Promise<void> {
    await this.checkpointing;
    await this.world?.store.close();
    this.world = null;
    this.rules = rulesOf(this.settingsValue.simulator);
    const aside = path.join(this.root, `world-reset-${this.clock.now()}`);
    await rename(this.worldDir(), aside).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
    await this.openWorld();
    await this.newManagers();
    this.scheduler = null;
    this.schedulerEnded = true;
    this.lastProgress = null;
    this.proposalBase = null;
    this.log('warn', `simulated world reset (${reason}); the previous one is kept in ${path.basename(aside)}`);
    this.hub.canvasResync('simulated world reset');
    this.hub.notice('warning', 'simulated world reset');
  }

  /** Puts the agent back to its configured start resources (stopped only, explicit). */
  async resetAgent(): Promise<CommandResult> {
    this.guard();
    this.requireIdle('resetting the agent');
    const world = this.requireWorld();
    await world.canvas.setAgent(this.agentSeed(this.settingsValue.agent), 'agent reset');
    this.proposalBase = null;
    return { changed: true, status: this.status() };
  }

  // ───────────────────────── Canvas ─────────────────────────

  /** A region of the simulated canvas with the sequence number it includes (default: the selected template's area). */
  async canvasRegion(rect?: CanvasRect): Promise<CanvasRegion> {
    const world = this.requireWorld();
    const s = this.settingsValue.simulator;
    let r = rect;
    let truncated = false;
    if (r === undefined) {
      const t = this.selectedTemplate;
      r = t !== null ? { minX: t.placement.topLeft.x, minY: t.placement.topLeft.y, width: t.image.width, height: t.image.height } : { minX: 0, minY: 0, width: s.width, height: s.height };
      // A template larger than one read: its top-left part (the client is told by `truncated`).
      if (r.width * r.height > MAX_REGION_PIXELS) {
        truncated = true;
        r = { ...r, width: Math.min(r.width, 2048), height: Math.min(r.height, Math.floor(MAX_REGION_PIXELS / Math.min(r.width, 2048))) };
      }
    }
    if (!Number.isSafeInteger(r.minX) || !Number.isSafeInteger(r.minY) || !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) || r.width < 1 || r.height < 1 || r.width * r.height > MAX_REGION_PIXELS) {
      throw new EngineServiceError('INVALID_REQUEST', 400, `invalid region (at most ${MAX_REGION_PIXELS} pixels)`);
    }
    const region = r;
    return world.canvas.withWorld(async (view) => {
      const out = new Int32Array(region.width * region.height).fill(-2);
      for (let y = 0; y < region.height; y++) {
        const cy = region.minY + y;
        if (cy < 0 || cy >= view.bounds.height) continue;
        for (let x = 0; x < region.width; x++) {
          const cx = region.minX + x;
          if (cx >= 0 && cx < view.bounds.width) out[y * region.width + x] = view.pixels[cy * view.bounds.width + cx]!;
        }
      }
      return { stream: this.hub.stream, seq: this.hub.seq, rect: region, truncated, observedAt: this.clock.now(), data: base64(out) };
    });
  }

  /** Demonstration: another actor erases `count` painted pixels of the template area (detected and repainted). */
  async simulateExternalEdit(count: number): Promise<{ readonly changed: number }> {
    this.guard();
    const world = this.requireWorld();
    const t = this.selectedTemplate;
    if (t === null) throw new EngineServiceError('NO_TEMPLATE_SELECTED', 409, 'select a template first');
    const candidates: { point: { x: number; y: number }; color: number }[] = [];
    for (let iy = 0; iy < t.image.height; iy++) {
      for (let ix = 0; ix < t.image.width; ix++) {
        const point = { x: t.placement.topLeft.x + ix, y: t.placement.topLeft.y + iy };
        if (world.canvas.at(point) !== TRANSPARENT) candidates.push({ point, color: TRANSPARENT });
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    const changed = await world.canvas.editExternal(candidates.slice(0, Math.max(0, Math.min(count, 10_000))));
    return { changed: changed.length };
  }

  // ───────────────────────── Resources and upgrades ─────────────────────────

  /** Resources of the simulated agent and the upgrade proposals (computed, never applied automatically). */
  async resourcesView(): Promise<ResourcesView> {
    const world = this.requireWorld();
    const now = this.clock.now();
    const state = world.canvas.agentState(SIMULATED_AGENT);
    const observation = world.canvas.observe(SIMULATED_AGENT);
    let proposals: readonly UpgradeProposal[] = [];
    let unavailable: string | null = null;
    const progress = await this.progressForEta(now).catch(() => null);
    if (progress === null) unavailable = 'select a template to estimate the effect of an upgrade';
    else {
      proposals = proposeUpgrades({ agent: SIMULATED_AGENT, agents: [{ id: SIMULATED_AGENT, state }], progress, parameters: { rules: this.rules, msPerPixel: this.msPerPixel(), minCoveragePercent: 0 }, now });
      this.proposalBase = { state, proposals };
    }
    const unlocked = new Set<number>(state.unlockedColors);
    const capacity = capacityOf(this.rules, state.upgrades);
    const regen = regenIntervalOf(this.rules, state.upgrades);
    return {
      agent: SIMULATED_AGENT,
      simulated: true,
      observedAt: observation.observedAt,
      energy: state.energy,
      capacity,
      regenIntervalMs: regen,
      costPerPixel: this.rules.energy.costPerPixel,
      currency: state.currency,
      upgrades: state.upgrades,
      unlockedColors: [...state.unlockedColors],
      lockedColors: this.rules.palette.unlockable.filter((u) => !unlocked.has(u.color)).map((u) => ({ color: u.color, cost: u.cost })),
      nextEnergyAt: state.energy >= capacity ? null : now + Math.max(0, regen - state.regenProgressMs),
      proposals,
      proposalsUnavailable: unavailable,
    };
  }

  private async progressForEta(now: number): Promise<ProgressSnapshot> {
    if (this.lastProgress !== null) return this.lastProgress;
    const selection = this.settingsValue.selection;
    if (selection === null) throw new Error('no template');
    const t = await this.currentTemplate(this.ref(selection.templateId));
    const world = this.requireWorld();
    const snapshot = await world.canvas.reader.readRegion({ minX: t.placement.topLeft.x, minY: t.placement.topLeft.y, width: t.image.width, height: t.image.height });
    return computeProgress(t, snapshot, now);
  }

  /**
   * Applies ONE proposal after an explicit confirmation, to the simulated
   * world only (durable), never while the simulation writes. Refused when
   * the agent changed since the proposal (STALE_PROPOSAL: read the
   * proposals again).
   */
  async applyUpgrade(proposalId: string, confirmed: boolean): Promise<{ readonly applied: UpgradeProposal; readonly resources: ResourcesView }> {
    this.guard();
    if (!confirmed) throw new EngineServiceError('CONFIRMATION_REQUIRED', 400, 'a simulated upgrade needs an explicit confirmation');
    if (this.active && this.state !== 'paused') throw new EngineServiceError('ENGINE_BUSY', 409, 'pause or stop the simulation before an upgrade');
    const world = this.requireWorld();
    const base = this.proposalBase;
    const proposal = base?.proposals.find((p) => p.id === proposalId);
    if (base === null || proposal === undefined) throw new EngineServiceError('STALE_PROPOSAL', 409, 'this proposal is unknown or outdated: read the resources again');
    let confirmedUpgrade;
    try {
      confirmedUpgrade = confirmUpgrade(proposal, { proposalId, confirmedBy: 'user', confirmedAt: Math.max(this.clock.now(), proposal.basedOn.computedAt) });
    } catch (error) {
      throw new EngineServiceError('UPGRADE_REFUSED', 409, error instanceof Error ? error.message : String(error));
    }
    try {
      await world.canvas.updateAgent(
        SIMULATED_AGENT,
        (current, now) => {
          // Only time may have passed since the proposal: anything else makes it stale.
          if (stateFingerprint(advance(this.rules, base.state, now, now)) !== stateFingerprint(current)) {
            throw new EngineServiceError('STALE_PROPOSAL', 409, 'the agent changed since the proposal: read the resources again');
          }
          return applyConfirmedUpgrade(this.rules, base.state, confirmedUpgrade, now);
        },
        `simulated upgrade ${proposal.kind}`
      );
    } catch (error) {
      if (error instanceof EngineServiceError) throw error;
      throw new EngineServiceError('UPGRADE_REFUSED', 409, error instanceof Error ? error.message : String(error));
    }
    this.proposalBase = null;
    // The engine's view is refreshed from the world (a newer observation).
    try {
      this.resources.observe(world.canvas.observe(SIMULATED_AGENT));
    } catch {
      // The scheduler observes again before its next lease anyway.
    }
    this.hub.notice('info', `simulated upgrade applied: ${proposal.kind}`);
    return { applied: proposal, resources: await this.resourcesView() };
  }

  // ───────────────────────── Attempts and journal ─────────────────────────

  attemptsView(): { readonly open: readonly { readonly attemptId: string; readonly state: string; readonly pixels: number; readonly leasedAt: number; readonly startedAt: number | null }[]; readonly recent: readonly AttemptRecord[] } {
    return {
      open: this.attempts.open().map((a) => ({ attemptId: a.attemptId, state: a.state, pixels: a.writes.length, leasedAt: a.leasedAt, startedAt: a.startedAt })),
      recent: [...this.recent],
    };
  }

  /** Full diagnosis of the journal files while stopped; statistics only while it runs (its files are being written). */
  async journalDiagnosis(): Promise<{ readonly mode: 'full' | 'live'; readonly diagnosis: unknown }> {
    if (this.active) {
      return { mode: 'live', diagnosis: { stats: await this.journal.stats(), compaction: this.attempts.compactionStatus(), damage: this.attempts.damage(), openAttempts: this.attempts.open().length } };
    }
    return { mode: 'full', diagnosis: await diagnoseJournal(this.root) };
  }

  /** Compacts the attempt journal (and checkpoints the simulated world); one at a time. */
  async compact(): Promise<{ readonly journal: unknown; readonly worldGeneration: number | null }> {
    this.guard();
    if (this.compacting) throw new EngineServiceError('COMPACTION_IN_PROGRESS', 409, 'a compaction is already in progress');
    this.compacting = true;
    try {
      let report: unknown;
      try {
        report = await this.attempts.compact(this.clock.now());
      } catch (error) {
        throw new EngineServiceError('COMPACTION_REFUSED', 409, error instanceof Error ? error.message : String(error));
      }
      const w = this.world;
      if (w !== null) {
        await this.checkpointing;
        await w.canvas.withWorld((view) => w.store.checkpoint(view));
      }
      return { journal: report, worldGeneration: this.world?.store.generation ?? null };
    } finally {
      this.compacting = false;
    }
  }

  // ───────────────────────── Demonstration ─────────────────────────

  /**
   * Whether the demonstration can be set up here: only on an EMPTY project
   * (no template, a simulated canvas never painted, no attempt), so that it
   * never changes someone's data. Otherwise: `npm run demo` (own directory).
   */
  async demoAvailability(): Promise<{ readonly available: boolean; readonly reason: string | null; readonly active: boolean }> {
    const active = this.selectedTemplate?.name === DEMO_TEMPLATE_NAME;
    const listing = await this.templates.list(asProjectId(SIMULATION_PROJECT));
    if (listing.templates.length > 0 || listing.failures.length > 0) return { available: false, reason: 'the project already has templates', active };
    if (this.attempts.open().length > 0 || this.toReconcileAtStart > 0) return { available: false, reason: 'the project has attempts in flight', active };
    const world = this.world;
    if (world === null) return { available: false, reason: 'the simulated world is unavailable', active };
    const painted = await world.canvas.withWorld((view) => view.pixels.some((v) => v !== TRANSPARENT));
    if (painted) return { available: false, reason: 'the simulated canvas is already painted', active };
    return { available: true, reason: null, active };
  }

  /**
   * Sets up the demonstration on an empty project: demo settings (a small
   * canvas, fast regeneration), the simulated agent with its demo resources,
   * the example template imported and selected. Stopped only.
   */
  async setupDemo(): Promise<CommandResult> {
    this.guard();
    this.requireIdle('the demonstration setup');
    const availability = await this.demoAvailability();
    if (!availability.available) {
      throw new EngineServiceError('DEMO_NEEDS_EMPTY_PROJECT', 409, `the demonstration is set up on an empty project only (${availability.reason ?? ''}): start it in its own directory with "npm run demo"`);
    }
    const s = this.settingsValue.simulator;
    const target = DEMO_SETTINGS.simulator;
    const identity = s.width !== target.width || s.height !== target.height || s.costPerPixel !== target.costPerPixel || s.capacity !== target.capacity || s.regenIntervalMs !== target.regenIntervalMs;
    // The canvas is empty (checked above): a reset here loses nothing.
    await this.configure({ simulator: target, agent: DEMO_SETTINGS.agent, run: DEMO_SETTINGS.run, resetWorld: identity });
    await this.resetAgent();
    const png = await pngjsCodec.encode({ width: DEMO_WIDTH, height: DEMO_HEIGHT, rgba: demoRgba() });
    const t = await this.importTemplate({ name: DEMO_TEMPLATE_NAME, png, x: DEMO_POSITION.x, y: DEMO_POSITION.y, strategy: DEMO_STRATEGY });
    await this.selectTemplate(t.templateId);
    this.hub.notice('info', 'demonstration ready');
    return { changed: true, status: this.status() };
  }

  // ───────────────────────── Backup ─────────────────────────

  /**
   * Backs up the data directory (stopped only: nothing writes meanwhile)
   * into the configured backup directory. Restoring is done with GeoPlacer
   * stopped (npm run restore).
   */
  async backup(): Promise<{ readonly name: string; readonly files: number; readonly bytes: number; readonly createdAt: string }> {
    this.guard();
    this.requireIdle('a backup');
    if (this.backingUp || this.compacting) throw new EngineServiceError('ENGINE_BUSY', 409, 'a backup or a compaction is already in progress');
    this.backingUp = true;
    try {
      await this.checkpointing;
      let result: { dir: string; manifest: BackupManifest };
      try {
        result = await createBackup(this.root, this.backupDir, { lock: this.lock });
      } catch (error) {
        throw new EngineServiceError('BACKUP_FAILED', 500, `the backup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.log('info', `backup written: ${path.basename(result.dir)} (${result.manifest.summary.files} files)`);
      return { name: path.basename(result.dir), files: result.manifest.summary.files, bytes: result.manifest.summary.bytes, createdAt: result.manifest.createdAt };
    } finally {
      this.backingUp = false;
    }
  }

  // ───────────────────────── Shutdown ─────────────────────────

  /**
   * Controlled shutdown: stops the simulation (after the operation in
   * progress; with abort after `graceMs`), closes the world and the
   * journal, releases the directory.
   */
  async close(graceMs = 10_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active) {
      const stop = this.stop();
      const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), graceMs).unref());
      if ((await Promise.race([stop, timer])) === 'late') {
        this.log('warn', 'the operation in progress did not end in time: aborting it');
        await this.scheduler?.stop({ abort: true });
      }
    }
    this.unsubscribe?.();
    this.hub.close();
    await this.checkpointing;
    await this.world?.store.close();
    await this.journal.close();
    await this.history.close();
    await this.lock.release();
  }
}

function base64(values: Int32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i]!, true);
  return Buffer.from(bytes).toString('base64');
}

export type { AgentId };
