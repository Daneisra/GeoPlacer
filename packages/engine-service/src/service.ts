import { BatchMetadataStore } from './geopixels/batch-store.js';
import { MAX_MODEL_PIXELS } from './geopixels/capacity.js';
/**
 * EngineService (Phase 1B.9, provider extension Phase 2A): the orchestration service of the server.
 *
 * Wires the existing planner, attempts, resources and single scheduler to a selected
 * canvas provider. Simulation retains its durable FileWorldStore; Phase 2A adds
 * browser observations and an independently journaled local fixture writer.
 * Real writes require the separately approved single-pixel port; real scheduling and purchases remain disabled.
 *
 * One data directory = one engine: the directory lock (plus the named pipe
 * guard on Windows) is taken first; a second instance is refused.
 */

import { randomUUID, createHash } from 'node:crypto';
import { rename, readFile, open } from 'node:fs/promises';
import { SinglePixelWriter } from './geopixels/single-pixel-writer.js';
import { GeoPixelsProvider } from './geopixels/provider.js';
import { ConnectorPairing } from './geopixels/pairing.js';
import { parseObservationHistory } from './geopixels/monitor.js';
import { parseRegions, type ImageRegion } from './geopixels/regions.js';
import { RegionalProgressCache, summarizeCompletedCapture } from './geopixels/region-progress.js';
import { check } from './geopixels/protocol.js';
import type { EnergyPolicy, GroupPolicy } from './geopixels/drawing-energy.js';
import path from 'node:path';
import type {
    AgentId,
    AttemptId,
    AttemptManager,
    CanvasRect,
    DrawingStrategyId,
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
    UpgradePolicy,
} from '@geoplacer/core';
import {
  DEFAULT_AUTO_COMPACTION,
  TRANSPARENT,
  quantizedToRgba,
  advance,
  applyConfirmedUpgrade,
  asProjectId,
  asTemplateId,
  isValidId,
  proportionalSize,
  resizeRgba,
  capacityOf,
  computeProgress,
  confirmUpgrade,
  createAttemptManager,
  createResourceManager,
  createScheduler,
  createTemplateManager,
  proposeUpgrades,
  evaluateUpgradePolicy,
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
import { GHOST_PROJECT, exportGhostPng, ghostInfo, hexOf, importGhost, type GhostImportInput, type GhostInfo } from './ghost.js';
import { EMPTY_DRAWING_PREFERENCES, INITIAL_DRAWING, nextDrawing, validDrawingOptions, type DrawingOptions, type DrawingPreferencesEdit, type DrawingPreferencesView, type DrawingPreset } from './geopixels/drawing-preferences.js';
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
const ACTIVE: ReadonlySet<SchedulerState> = new Set([
    'initializing',
    'running',
    'paused',
    'waiting-resources',
    'waiting-reconciliation',
]);
/** Default: world checkpoint after this many logged changes. */
export const WORLD_CHECKPOINT_RECORDS = 2_000;
const RECENT_ATTEMPTS = 100;
/** Phase 1C.0: pixels of work between two yields to the event loop (about 5 to 15 ms of work). */
export const DEFAULT_SLICE_PIXELS = 262_144;
/** Lets the pending I/O (HTTP, WebSocket, timers) run, then continues. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Output pixels of one read (after the scale). */
const MAX_REGION_PIXELS = 2048 * 2048;
/** Source pixels of one read (the largest canvas). */
const MAX_SOURCE_PIXELS = 4096 * 4096;

/** The smallest scale that keeps a w x h area within one read. */
export function autoScale(width: number, height: number): number {
  let s = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_REGION_PIXELS)));
  while (Math.ceil(width / s) * Math.ceil(height / s) > MAX_REGION_PIXELS) s++;
  return s;
}

function checkRegion(r: CanvasRect, scale: number): void {
  const ok =
    Number.isSafeInteger(r.minX) &&
    Number.isSafeInteger(r.minY) &&
    Number.isSafeInteger(r.width) &&
    Number.isSafeInteger(r.height) &&
    r.width >= 1 &&
    r.height >= 1 &&
    r.width * r.height <= MAX_SOURCE_PIXELS &&
    Number.isSafeInteger(scale) &&
    scale >= 1 &&
    scale <= 256 &&
    Math.ceil(r.width / scale) * Math.ceil(r.height / scale) <= MAX_REGION_PIXELS;
  if (!ok) throw new EngineServiceError('INVALID_REQUEST', 400, `invalid region or scale (at most ${MAX_REGION_PIXELS} pixels after the scale, ${MAX_SOURCE_PIXELS} before)`);
}

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
  /** Progress computation of the scheduler (Phase 1B.10): see SchedulerConfig.progressMode. */
  readonly progressMode?: 'full' | 'incremental';
  /**
   * Phase 1C.0: the scheduler yields to the event loop (setImmediate) between the phases of a
   * cycle and every `slicePixels` pixels of long computations (default on, 262 144 pixels);
   * false: never (behaviour before 1C.0, for comparisons).
   */
  readonly cooperative?: false | { readonly slicePixels?: number };
  /** Measurement hook (benches): called after every cycle with the scheduler status. */
  readonly onCycle?: (status: SchedulerStatus) => void;
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
  /** Explicit source; GeoPixels writes currently use the local fixture only. */
  readonly mode: 'simulation' | 'geopixels';
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
  readonly settings: Omit<EngineSettings, 'drawingPreferences'>;
  readonly lastActivityAt: number | null;
}

export interface CanvasRegion {
  readonly stream: string;
  /** Events with a sequence number up to this one are already included. */
  readonly seq: number;
  /** Source rectangle, in canvas coordinates. */
  readonly rect: CanvasRect;
  /**
   * Phase 1B.10: one pixel out of `scale` in each direction (the top-left
   * one of each block), so that a 4096 x 4096 area is shown whole without a
   * massive transfer. Output size: ceil(width / scale) x ceil(height / scale).
   */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** Canvas axes: rows go down (V1 simulator) or up (to be flipped for display). */
  readonly yAxis: 'down' | 'up';
  readonly observedAt: number;
  /** Little-endian int32 per output pixel (0xRRGGBB, -1 empty, -2 outside), row-major, base64. */
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
  readonly connector = new GeoPixelsProvider();
  readonly pairing = new ConnectorPairing();
  private connectorControl = false;
  private source: 'simulation' | 'geopixels' = 'simulation';
  private readonly simulationJournal: FileAttemptJournal;
  private readonly simulationHistory: FileHistoryStore;
  private readonly connectorJournal: FileAttemptJournal;
  private readonly connectorHistory: FileHistoryStore;
  private get journal(): FileAttemptJournal { return this.source === 'simulation' ? this.simulationJournal : this.connectorJournal; }
  private get history(): FileHistoryStore { return this.source === 'simulation' ? this.simulationHistory : this.connectorHistory; }

  private settingsValue: EngineSettings;
  private settingsWrite: Promise<void> = Promise.resolve();
  private rules: ResourceRules;
  private world: { canvas: SimulatedCanvasProvider; store: FileWorldStore } | null = null;
  private worldError: { code: string; message: string } | null = null;
  readonly singlePixelWriter: SinglePixelWriter;
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
  private readonly progressMode: 'full' | 'incremental';
  private readonly cooperative: false | { readonly slicePixels: number };
  private readonly onCycle: ((status: SchedulerStatus) => void) | undefined;
  private backingUp = false;
  /** Decoded templates by id (current revision only), a few at most. */
  private readonly templateCache = new Map<string, Template>();
  private observationSave: Promise<void> = Promise.resolve();
  private observationStoreHealthy = true;
    private readonly batchMetadata: BatchMetadataStore;
    private readonly regionalProgress = new RegionalProgressCache();
  private lastCompleteCapture: {
    template: Template;
    epoch: number;
    capturedAt: number;
    progress: Awaited<ReturnType<typeof summarizeCompletedCapture>>;
  } | null = null;
    private savedRegions: {
        schemaVersion: 1;
        identity: string;
        width: number;
        height: number;
        regions: ImageRegion[];
    } | null = null;

    private constructor(
        root: string,
        lock: DataDirectoryLock,
        settings: EngineSettings,
        clock: MonotonicClock,
        options: EngineServiceOptions
    ) {
        this.root = root;
        this.lock = lock;
        this.settingsValue = settings;
        this.rules = rulesOf(settings.simulator);
        this.clock = clock;
        this.log = options.log ?? (() => undefined);
        this.worldStoreOptions = options.worldStore ?? {};
        this.checkpointRecords = options.worldCheckpointRecords ?? WORLD_CHECKPOINT_RECORDS;
        this.backupDir = path.resolve(options.backupDir ?? path.join(root, '..', 'sauvegardes'));
        // Phase 1B.10: incremental by default (measured: -39 % per cycle at 2000², -42 % at 4096²; verified every 10 cycles).
        this.progressMode = options.progressMode ?? 'incremental';
        this.cooperative =
            options.cooperative === false
                ? false
                : { slicePixels: options.cooperative?.slicePixels ?? DEFAULT_SLICE_PIXELS };
        this.onCycle = options.onCycle;
        this.hub = new EngineEventHub({ intervalMs: options.eventIntervalMs ?? 250, now: () => this.clock.now() });
        this.templates = createTemplateManager({
            storage: new NodeTemplateStorage(lock),
            hasher: nodeSha256Hasher,
            codec: pngjsCodec,
            ids: randomIdSource,
            clock: systemClock,
            limits: {maxWidth:MAX_MODEL_PIXELS,maxHeight:MAX_MODEL_PIXELS,maxPixels:MAX_MODEL_PIXELS},
        });
        this.simulationJournal = new FileAttemptJournal(lock);
        this.simulationHistory = new FileHistoryStore(lock);
        this.connectorJournal = new FileAttemptJournal(lock, { namespace: 'geopixels' });
        this.connectorHistory = new FileHistoryStore(lock, { namespace: 'geopixels' });
        this.batchMetadata = new BatchMetadataStore(root, value=>this.durableConnectorJson('connector-batch.json',value));
        this.singlePixelWriter = new SinglePixelWriter(lock, this.connector,
            () => !this.closed && this.source === 'geopixels' && !this.active && !this.stopping && !this.connectorControl && !this.backingUp && this.attempts?.open().length === 0 ? this.selectedTemplate : null,
            value => this.durableConnectorJson('connector-writer-intent.json', value), Date.now,
            value => this.batchMetadata.save(value),value=>this.durableConnectorJson('connector-upgrades.json',value));
        this.connector.monitoring.subscribe((kind) => {
            this.hub.connector();
            if (kind === 'capture') {
                const capture = this.connector.monitoring.view().lastCapture;
                const epoch = this.connector.channelEpoch;
                const template = this.selectedTemplate;
                if (capture && !capture.regionId && template && this.connector.status().bound) {
                    void summarizeCompletedCapture(template, this.connector, capture.capturedAt, capture.receivedAt)
                        .then((progress) => {
                            if (this.closed || epoch !== this.connector.channelEpoch || this.selectedTemplate !== template) return;
                            this.connector.assertBinding(template);
                            if (this.lastCompleteCapture?.epoch === epoch && this.lastCompleteCapture.template === template &&
                                this.lastCompleteCapture.capturedAt > capture.capturedAt) return;
                            this.lastCompleteCapture = { template, epoch, capturedAt: capture.capturedAt, progress };
                            this.connector.monitoring.annotate(capture.id, template.id, progress);
                            this.hub.connector();
                        })
                        .catch(() => this.hub.notice('warning', 'Historique de la capture complète indisponible.'));
                } else if (capture)
                    void this.connectorView()
                        .then((view) => {
                            if (!this.closed && epoch === this.connector.channelEpoch)
                                this.connector.monitoring.annotate(
                                    capture.id,
                                    view.bound ? (view.selection?.templateId ?? null) : null,
                                    capture.regionId
                                        ? (view.regionViews.find((r) => r.id === capture.regionId)?.progress ?? null)
                                        : view.progress
                                );
                        })
                        .catch(() => this.hub.notice('warning', 'Progression de la capture indisponible.'));
            }
            if (kind === 'history' && this.observationStoreHealthy && !this.closed) {
                const data = structuredClone(this.connector.monitoring.persisted());
                this.observationSave = this.observationSave
                    .then(() => this.durableConnectorJson('connector-observations.json', data))
                    .catch(() => {
                        this.observationStoreHealthy = false;
                        this.hub.notice(
                            'warning',
                            'Historique des observations non sauvegardé ; vérifier le stockage local.'
                        );
                    });
            }
        });
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
            try {
                const source = JSON.parse(await readFile(path.join(root, 'provider.json'), 'utf8')) as unknown;
                check(source === 'simulation' || source === 'geopixels', 'invalid saved provider');
                service.source = source;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            await service.newManagers();
            try {
                const raw = await readFile(path.join(root, 'connector-observations.json'), 'utf8');
                check(raw.length <= 1_000_000, 'observation history too large');
                service.connector.monitoring.restore(parseObservationHistory(JSON.parse(raw)));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    service.observationStoreHealthy = false;
                    service.log('warn', 'observation history invalid; preserved without overwriting');
                    service.hub.notice(
                        'warning',
                        'Historique invalide conservé sur disque ; surveillance en mémoire seulement.'
                    );
                }
            }
            try {
                const raw = await readFile(path.join(root, 'connector-regions.json'), 'utf8');
                check(raw.length <= 32000, 'region configuration too large');
                const saved = JSON.parse(raw) as NonNullable<EngineService['savedRegions']>;
                check(
                    saved &&
                        Object.keys(saved).length === 5 &&
                        saved.schemaVersion === 1 &&
                        typeof saved.identity === 'string' &&
                        saved.identity.length <= 2048 &&
                        Number.isSafeInteger(saved.width) &&
                        saved.width > 0 &&
                        saved.width <= 4096 &&
                        Number.isSafeInteger(saved.height) &&
                        saved.height > 0 &&
                        saved.height <= 4096,
                    'invalid saved regions'
                );
                service.savedRegions = { ...saved, regions: parseRegions(saved.regions, saved.width, saved.height) };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    service.log('warn', 'invalid saved regions preserved; reconfigure explicitly');
            }
            const selection = settings.selection;
            if (selection !== null)
                await service
                    .currentTemplate(service.ref(selection.templateId))
                    .catch(() => service.log('warn', `selected template ${selection.templateId} cannot be loaded`));
            let writerIntent: unknown = null;
            try { writerIntent = JSON.parse(await readFile(path.join(root, 'connector-writer-intent.json'), 'utf8')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            let batch: unknown = null;
            try {batch=JSON.parse(await readFile(path.join(root,'connector-batch.json'),'utf8'));}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
            let upgrades:unknown=null;
            try{upgrades=JSON.parse(await readFile(path.join(root,'connector-upgrades.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
            await service.singlePixelWriter.open(writerIntent,await service.batchMetadata.load(batch),upgrades);
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
    if (report.toReconcile.length > 0) this.log('warn', `${report.toReconcile.length} attempt(s) interrupted before their answer: reconciled against the selected provider after a fresh observation`);
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
      freshness: { simulated: { maxAgeMs: 60_000 }, 'geopixels-fixture': { maxAgeMs: 30_000 }, 'geopixels-observed': { maxAgeMs: 30_000 } },
      maxResourceAgeMs: 30_000,
      eta: { msPerPixel: this.msPerPixel(), minCoveragePercent: 0 },
      reconcileRetryMs: 1_000,
      // Revision and canvas re-checked at least every 5 s while waiting.
      maxWaitMs: 5_000,
      maxRecentErrors: 20,
      maxCycles: null,
      progressMode: this.progressMode,
    };
  }

  private onSchedulerEvent(e: SchedulerEvent): void {
    switch (e.type) {
      case 'state':
        this.hub.state(e.from, e.to, e.reason);
        this.hub.statusNow(this.status());
        break;
      case 'cycle':
        this.onCycle?.(e.status);
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
    const { schemaVersion, simulator, agent, run, selection: selected } = this.settingsValue;
    const ended = this.scheduler === null || this.schedulerEnded || !ACTIVE.has(state);
    return {
      mode: this.source,
      state,
      reason: sched?.reason ?? (this.worldError !== null ? `simulated world unavailable: ${this.worldError.code}` : null),
      stream: this.hub.stream,
      seq: this.hub.seq,
      selection: this.selectedTemplate === null ? null : this.templateInfo(this.selectedTemplate),
      commands: {
        start: ended && selected !== null && (this.source === 'geopixels' || this.world !== null) && (this.source === 'simulation' || this.connector.canWrite()) && this.stopping === null && this.starting === null,
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
      settings: { schemaVersion, simulator, agent, run, selection: selected },
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
    check(!this.connectorControl, 'provider control in progress');
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

  /** Single scheduler, two providers, independent attempt domains. Source changes require idle state. */
  async selectSource(source: 'simulation' | 'geopixels'): Promise<CommandResult> {
    this.guard();
    check(!this.connectorControl, 'provider control in progress');
    check(source === 'simulation' || source === 'geopixels', 'invalid source');
    if (source === this.source) return { changed: false, status: this.status() };
    this.requireIdle('changing the canvas provider');
    check(!this.singlePixelWriter.view().locked, 'reconcile or cancel the single pixel before changing source');
    check(this.attempts.open().length === 0, 'reconcile open attempts before changing source');
    this.connectorControl = true;
    try {
      await this.durableConnectorJson('provider.json', source);
      this.source = source;
      if (source !== 'geopixels') this.connector.monitoring.stop('Source de toile modifiée.');
      this.scheduler = null;
      this.schedulerEnded = true;
      this.lastProgress = null;
      this.recent.length = 0;
      await this.newManagers();
      this.hub.statusNow(this.status());
      return { changed: true, status: this.status() };
    } finally { this.connectorControl = false; }
  }

  private async durableConnectorJson(filename: string, value: unknown): Promise<void> {
    const target = path.join(this.root, filename);
    const tmp = `${target}.${randomUUID()}.partial`;
    const file = await open(tmp, 'wx');
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, target);
    // Windows does not expose directory fsync. The attempt journal retains its existing guarantees.
    if (process.platform !== 'win32') { const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }

  async bindConnector(): Promise<unknown> {
    this.guard();
    check(!this.connectorControl, 'provider control in progress');
    this.requireIdle('binding the browser ghost');
    this.connectorControl = true;
    try {
      check(this.source === 'geopixels', 'select the GeoPixels source first');
      const t = this.selectedTemplate;
      check(t !== null, 'select a local model first');
      const identity = { project: this.connector.status().project, template: t.id, revision: t.revision, hash: t.quantizedImageHash, placement: t.placement };
      check(identity.project !== null, 'no browser project');
      if (this.attempts.open().length > 0) {
        const saved = JSON.parse(await readFile(path.join(this.root, 'connector-binding.json'), 'utf8')) as unknown;
        check(JSON.stringify(saved) === JSON.stringify(identity), 'open attempts belong to another browser project or position');
      }
      // Validate before persistence; a failed durable save invalidates the binding.
      this.connector.bind(t);
      try { await this.durableConnectorJson('connector-binding.json', identity); }
      catch (error) { this.connector.disconnect('binding could not be saved'); throw error; }
      return await this.connectorView();
    } finally { this.connectorControl = false; }
  }

  async connectorProposals(policy: UpgradePolicy) {
    this.guard();
    check(this.source === 'geopixels' && this.connector.status().mode === 'local-fake', 'purchase catalogue is not verified for the real service');
    const observation = await this.connector.resourceSource(this.rules).observe(SIMULATED_AGENT);
    const state = createResourceManager(this.rules).observe(observation).state;
    const view = await this.connectorView();
    check(view.progress !== null, 'bind a model first');
    const effectivePolicy = { ...policy, requiredColors: policy.requiredColors.length === 0 ? view.progress.byColor.map((c) => c.color) : policy.requiredColors };
    const proposals = evaluateUpgradePolicy({ agent: SIMULATED_AGENT, agents: [{ id: SIMULATED_AGENT, state }], progress: view.progress, parameters: { rules: this.rules, msPerPixel: this.msPerPixel(), minCoveragePercent: 0 }, now: this.clock.now() }, effectivePolicy);
    await this.durableConnectorJson('connector-policy.json', effectivePolicy);
    return { simulated: true, executable: false, proposals };
  }

    async connectorView() {
        const view = this.connector.status();
        const t = this.selectedTemplate;
        let bound = view.bound;
        if (t !== null && bound) {
            try {
                this.connector.assertBinding(t);
            } catch {
                bound = false;
            }
        }
        if (!bound && (view.connected || view.mode === null || !view.bound) && this.connector.monitoring.control().state !== 'stopped')
            this.connector.monitoring.stop('Liaison du modèle perdue : vérifier le modèle et recommencer le couplage.');
        let progress: ProgressSnapshot | null = null;
        let regionViews: Awaited<ReturnType<RegionalProgressCache['compute']>>['regions'] = [];
        let recomputedCells = 0;
        let calculationError: string | null = null;
        if (bound && t !== null) {
            try {
                const calculated = await this.regionalProgress.compute(t, this.connector, Date.now());
                this.connector.assertBinding(t);
                check(this.selectedTemplate === t, 'template changed during observation');
                progress = calculated.progress;
                regionViews = calculated.regions;
                recomputedCells = calculated.recomputedCells;
            } catch {
                try { this.connector.assertBinding(t); bound = this.selectedTemplate === t; }
                catch { bound = false; }
                calculationError = 'Progression indisponible pendant le recalcul ; nouvelle lecture du cache attendue.';
            }
        }
        const historical = this.lastCompleteCapture?.template === t && this.lastCompleteCapture.epoch === this.connector.channelEpoch
            ? this.lastCompleteCapture : null;
        const batch = await this.singlePixelWriter.batch.observedView();
        return {
            ...this.connector.status(),
            singlePixel: this.singlePixelWriter.view(),
            batch,
            drawingPreferences: this.drawingPreferences(batch),
            accountPalette: this.singlePixelWriter.batch.accountPalette(),
            upgrades: this.singlePixelWriter.upgrades.view(batch.id),
            error: this.connector.status().error ?? calculationError,
            bound,
            source: this.source,
            selection: t === null ? null : this.templateInfo(t),
            progress,
            lastCompleteProgress: historical && { capturedAt: historical.capturedAt, ...historical.progress },
            regionViews,
            recomputedCells,
            savedRegionConfiguration: {
                available: this.savedRegions !== null,
                count: this.savedRegions?.regions.length ?? 0,
                matching: bound && t !== null && this.savedRegions?.identity === this.regionIdentity(t),
            },
            scheduler: this.source === 'geopixels' ? (this.scheduler?.status() ?? null) : null,
            rules: this.source === 'geopixels' && view.mode === 'local-fake' ? this.rules : null,
        };
    }
    private regionIdentity(t: Template) {
        return JSON.stringify([t.id, t.revision, t.placement, this.connector.status().project]);
    }
    async configureConnectorRegions(value: unknown, restore = false) {
        this.guard();
        check(!this.connectorControl, 'provider control in progress');
        const t = this.selectedTemplate;
        check(
            t !== null && this.source === 'geopixels' && this.connector.status().mode === 'read-only',
            'bind the real reader first'
        );
        this.connector.assertBinding(t);
        const m = this.connector.monitoring.view();
        check(m.regionalSupported && m.state !== 'running' && !m.inFlight, 'pause before changing observation regions');
        const identity = this.regionIdentity(t);
        if (restore)
            check(this.savedRegions?.identity === identity, 'saved regions belong to another model or position');
        const regions = parseRegions(restore ? this.savedRegions!.regions : value, t.image.width, t.image.height);
        this.connectorControl = true;
        try {
            const saved = {
                schemaVersion: 1 as const,
                identity,
                width: t.image.width,
                height: t.image.height,
                regions,
            };
            await this.durableConnectorJson('connector-regions.json', saved);
            this.connector.assertBinding(t);
            check(identity === this.regionIdentity(t), 'binding changed during region save');
            this.savedRegions = saved;
            this.connector.monitoring.configureRegions(regions, t.image.width, t.image.height);
            return this.connectorView();
        } finally {
            this.connectorControl = false;
        }
    }

  private async startNow(): Promise<CommandResult> {
    check(!this.singlePixelWriter.view().locked, 'reconcile or cancel the single pixel before starting the scheduler');
    check(!this.connectorControl, 'provider control in progress');
    if (this.stopping !== null) throw new EngineServiceError('ENGINE_BUSY', 409, 'a stop is in progress');
    if (this.active) {
      if (this.state === 'paused') throw new EngineServiceError('PAUSED_USE_RESUME', 409, 'the simulation is paused: use resume');
      return { changed: false, status: this.status() };
    }
    const world = this.source === 'simulation' ? this.requireWorld() : null;
    const selection = this.settingsValue.selection;
    if (selection === null) throw new EngineServiceError('NO_TEMPLATE_SELECTED', 409, 'select a template first');
    const ref = this.ref(selection.templateId);
    let template: Template;
    try {
      template = await this.currentTemplate(ref);
    } catch {
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${selection.templateId} cannot be loaded`);
    }
    if (this.source === 'simulation') this.assertInsideCanvas(template.image.width, template.image.height, template.placement.topLeft.x, template.placement.topLeft.y);
    if (this.source === 'geopixels') {
      this.connector.assertBinding(template);
      check(this.connector.canWrite(), 'real placement is unavailable; only local fixture writes are enabled in Phase 2A');
    }
    this.unsubscribe?.();
    await this.newManagers();
    const scheduler = createScheduler(this.schedulerConfig(ref.templateId), {
      clock: this.clock,
      canvas: this.source === 'simulation' ? world!.canvas : this.connector,
      templates: { current: async (r) => { const t = await this.currentTemplate(r); if (this.source === 'geopixels') this.connector.assertBinding(t); return t; } },
      resourceSource: this.source === 'simulation' ? world!.canvas.resourceSource() : this.connector.resourceSource(this.rules),
      resources: this.resources,
      attempts: this.attempts,
      hasher: nodeSha256Hasher,
      ...(this.cooperative === false ? {} : { cooperative: { yieldTo: yieldToEventLoop, slicePixels: this.cooperative.slicePixels } }),
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

  async selectTemplate(templateId: string, initialOptions?: DrawingOptions): Promise<CommandResult> {
    this.guard();
    if (this.settingsValue.selection?.templateId === templateId) return { changed: false, status: this.status() };
    return this.editDrawing(async () => {
      const info = await this.templateInfoOf(templateId);
      if (this.source === 'simulation') this.assertInsideCanvas(info.width, info.height, info.placement?.x ?? 0, info.placement?.y ?? 0);
      await this.retireDrawingPreview();
      this.connector.monitoring.stop('Modèle local modifié : nouvelle liaison nécessaire.');
      await this.saveSettingsValue(settings => ({ ...settings, selection: { templateId },
        ...(initialOptions ? { drawingPreferences: this.rememberDrawing(settings, templateId, { options: initialOptions, strategy: info.strategy as DrawingStrategyId }, false) } : {}),
      }));
      this.clearDrawingStatus();
      this.hub.statusNow(this.status());
      return { changed: true, status: this.status() };
    });
  }

  private clearDrawingStatus() {
    this.scheduler = null;
    this.schedulerEnded = true;
    this.lastProgress = null;
    this.proposalBase = null;
  }

  private async editDrawing<T>(edit: () => Promise<T>): Promise<T> {
    this.guard();
    this.requireIdle('editing a drawing');
    check(this.starting === null && this.attempts.open().length === 0, 'Arrêter ou réconcilier les opérations en cours.');
    const writer = this.singlePixelWriter.view();
    check(writer.open === 0 && !['running', 'paused'].includes(this.singlePixelWriter.batch.view().state),
      'Arrêter ou réconcilier le dessin en cours.');
    this.connectorControl = true;
    try { return await edit(); }
    finally { this.connectorControl = false; }
  }

  private async retireDrawingPreview() {
    if (this.singlePixelWriter.view().locked) {
      await this.singlePixelWriter.batch.stop('Prévisualisation retirée ; confirmations conservées.');
      check(!this.singlePixelWriter.view().locked, 'Réconcilier les opérations avant de modifier le dessin.');
    }
  }

  async drawingLibrary() {
    this.guard();
    const listing = await this.listTemplates();
    const receipts = this.singlePixelWriter.batch.drawingReceipts();
    return {
      ...listing,
      templates: listing.templates.map((template) => {
        const observation = this.connector.monitoring.lastDrawingObservation(template.templateId);
        return {
          ...template,
          lastObservation: observation && { capturedAt: observation.capturedAt, ...observation.progress },
          receipts: receipts.get(template.templateId) ?? { real: 0, fake: 0 },
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  async setDrawingStrategy(templateId: string, strategy: DrawingStrategyId): Promise<TemplateInfo> {
    check(STRATEGIES.includes(strategy), 'Mode de dessin inconnu.');
    return this.editDrawing(async () => {
      const options = this.optionsForDrawing(templateId);
      const updated = await this.applyDrawingStrategy(templateId, strategy);
      await this.saveSettingsValue(settings => ({ ...settings, drawingPreferences: this.rememberDrawing(settings, templateId, {
        options: settings.drawingPreferences?.projects[templateId] ?? options, strategy,
      }) }));
      this.hub.connector();
      return updated;
    });
  }

  private async applyDrawingStrategy(templateId: string, strategy: DrawingStrategyId) {
    const template = await this.templateInfoOf(templateId);
    if (template.strategy === strategy) return template;
    if (this.settingsValue.selection?.templateId === templateId) await this.retireDrawingPreview();
    await this.templates.updateSettings(this.ref(templateId), { strategy: { id: strategy, ...(strategy === 'random' ? { seed: 1 } : {}) } });
    this.templateCache.delete(templateId);
    return this.templateInfoOf(templateId);
  }

  private optionsForDrawing(templateId: string | null, batch = this.singlePixelWriter.batch.view()): DrawingOptions {
    const prefs = this.settingsValue.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES;
    const base = nextDrawing(prefs).options;
    if (!templateId) return base;
    if (prefs.projects[templateId]) return prefs.projects[templateId];
    // Older versions saved only the last prepared or authorized scope. Use its draft values once per matching project.
    if (batch.templateId !== templateId || batch.execution !== 'autonomous' || !batch.scope) return base;
    const { scope } = batch;
    const energy = scope.energy;
    const thresholds = energy?.mode === 'bursts' ? { start: energy.start, restart: energy.restart, reserve: energy.reserve } : base.thresholds;
    const format = (threshold: DrawingOptions['thresholds']['start']) => threshold.percent ? (threshold.units ? 'both' : 'percent') : 'units';
    const upgrades = scope.upgrades;
    const template = this.selectedTemplate;
    const retained = template?.id === templateId ? this.templateInfo(template).paintablePixels : null;
    return {
      ...base,
      energyMode: energy?.mode ?? 'continuous', thresholds,
      formats: { start: format(thresholds.start), restart: format(thresholds.restart), reserve: format(thresholds.reserve) },
      groupSize: scope.groupSize ?? 0, groups: scope.groups ?? base.groups,
      pixelBudget: batch.budgets?.pixels === retained ? null : (batch.budgets?.pixels ?? null),
      upgradeMode: !upgrades ? 'disabled' : upgrades.maxBudget === null ? 'unlimited' : 'limited',
      upgrades: upgrades ? { ...upgrades, maxBudget: upgrades.maxBudget ?? base.upgrades.maxBudget } : base.upgrades,
    };
  }

  drawingPreferences(batch = this.singlePixelWriter.batch.view()): DrawingPreferencesView {
    const template = this.selectedTemplate;
    const templateId = template?.id ?? null;
    const prefs = this.settingsValue.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES;
    const next = nextDrawing(prefs);
    return { templateId, current: { options: this.optionsForDrawing(templateId, batch), strategy: template?.strategy.id ?? next.strategy },
      next, explicitDefault: prefs.defaults !== null, migrateLegacy: !prefs.recent && !prefs.defaults && !prefs.profiles.length,
      restorePreviousScope: templateId !== null && !prefs.projects[templateId] && batch.templateId === templateId && batch.execution === 'autonomous' && !!batch.scope,
      profiles: prefs.profiles.map(({ id, name }) => ({ id, name })),
    };
  }

  private rememberDrawing(settings: EngineSettings, templateId: string | null, preset: DrawingPreset, rememberRecent = true) {
    const prefs = settings.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES;
    return { ...prefs, recent: rememberRecent ? preset : prefs.recent,
      projects: templateId ? { ...prefs.projects, [templateId]: preset.options } : prefs.projects,
      // Editing the common form without a project edits the default for new imports.
      defaults: !templateId && prefs.defaults && rememberRecent ? preset : prefs.defaults,
    };
  }

  async editDrawingPreferences(edit: DrawingPreferencesEdit): Promise<DrawingPreferencesView> {
    this.guard();
    check(!this.backingUp, 'Réglages indisponibles pendant la sauvegarde.');
    if (edit.action === 'load' || edit.action === 'reset') {
      await this.editDrawing(async () => {
        const context = this.drawingPreferences();
        check(edit.templateId === context.templateId, 'Le dessin a changé avant le chargement des réglages.');
        const preset = edit.action === 'load'
          ? this.settingsValue.drawingPreferences?.profiles.find(p => p.id === edit.id)?.preset : INITIAL_DRAWING;
        check(preset, 'Profil de dessin introuvable.');
        if (context.templateId) await this.applyDrawingStrategy(context.templateId, preset.strategy);
        await this.saveSettingsValue(settings => {
          const prefs = this.rememberDrawing(settings, context.templateId, preset);
          return { ...settings, drawingPreferences: edit.action === 'reset' && !context.templateId ? { ...prefs, defaults: null } : prefs };
        });
      });
    } else if (edit.action === 'save') {
      check(validDrawingOptions(edit.options), 'Réglages de dessin invalides.');
      const strategy = edit.templateId ? (await this.templateInfoOf(edit.templateId)).strategy as DrawingStrategyId : null;
      await this.saveSettingsValue(settings => ({ ...settings, drawingPreferences: this.rememberDrawing(settings, edit.templateId, {
        options: edit.options, strategy: strategy ?? nextDrawing(settings.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES).strategy,
      }) }));
    } else {
      await this.saveSettingsValue(settings => {
        const prefs = settings.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES;
        const current = this.drawingPreferences();
        if (edit.action === 'default') {
          check(edit.templateId === current.templateId, 'Le dessin a changé avant l’enregistrement du défaut.');
          return { ...settings, drawingPreferences: { ...prefs, defaults: current.current } };
        }
        if (edit.action === 'delete') return { ...settings, drawingPreferences: { ...prefs, profiles: prefs.profiles.filter(p => p.id !== edit.id) } };
        check(edit.action === 'create' || edit.action === 'rename', 'Action de profil inconnue.');
        const name = edit.name.trim();
        check(name.length > 0 && name.length <= 80 && !prefs.profiles.some(p => p.name.toLowerCase() === name.toLowerCase() && (edit.action === 'create' || edit.id !== p.id)),
          'Choisissez un nom de profil distinct et non vide.');
        if (edit.action === 'create') check(edit.templateId === current.templateId, 'Le dessin a changé avant la création du profil.');
        else check(prefs.profiles.some(p => p.id === edit.id), 'Profil de dessin introuvable.');
        const profiles = edit.action === 'create' ? [...prefs.profiles, { id: randomUUID(), name, preset: current.current }]
          : prefs.profiles.map(p => p.id === edit.id ? { ...p, name } : p);
        return { ...settings, drawingPreferences: { ...prefs, profiles } };
      });
    }
    this.hub.connector();
    return this.drawingPreferences();
  }

  async deleteDrawing(templateId: string, confirmName: string) {
    return this.editDrawing(async () => {
      const template = await this.templateInfoOf(templateId);
      check(template.name === confirmName, 'Le nom de confirmation doit correspondre au dessin.');
      if (this.settingsValue.selection?.templateId === templateId) {
        await this.retireDrawingPreview();
        this.connector.monitoring.stop('Dessin retiré de la bibliothèque.');
        await this.saveSettingsValue(settings => ({ ...settings, selection: null }));
        this.clearDrawingStatus();
      }
      await this.templates.delete(this.ref(templateId), { confirmName });
      if (this.settingsValue.drawingPreferences?.projects[templateId]) {
        await this.saveSettingsValue(settings => {
          const prefs = settings.drawingPreferences!;
          const projects = { ...prefs.projects };
          delete projects[templateId];
          return { ...settings, drawingPreferences: { ...prefs, projects } };
        });
      }
      this.templateCache.delete(templateId);
      this.hub.statusNow(this.status());
      this.hub.connector();
      return { deleted: templateId };
    });
  }

  /**
   * Moves a template (a new revision). Allowed while the simulation runs:
   * the scheduler sees the new revision, cancels the attempts not started
   * and reconciles the started ones (never painted twice).
   */
  async moveTemplate(templateId: string, x: number, y: number): Promise<TemplateInfo> {
    this.guard();
    check(!this.singlePixelWriter.view().locked, 'reconcile or cancel the single pixel before moving the model');
    const info = await this.templateInfoOf(templateId);
    this.assertInsideCanvas(info.width, info.height, x, y);
    await this.templates.revise(this.ref(templateId), { placement: { topLeft: { x, y } } });
    return this.templateInfoOf(templateId);
  }

  /**
   * Quantized image of the current revision for the overlay (0xRRGGBB, -1
   * transparent or outside the template), over a canvas region sampled
   * EXACTLY like canvasRegion (same rect, same scale: aligned). Default: the
   * template area, whole. `x`, `y`, `width`, `height`: the template's.
   */
  async templateImage(
    templateId: string,
    rect?: CanvasRect,
    scale?: number
  ): Promise<{ readonly width: number; readonly height: number; readonly x: number; readonly y: number; readonly rect: CanvasRect; readonly scale: number; readonly outWidth: number; readonly outHeight: number; readonly data: string }> {
    const t = await this.currentTemplate(this.ref(templateId)).catch(() => {
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    });
    const tx = t.placement.topLeft.x;
    const ty = t.placement.topLeft.y;
    const r = rect ?? { minX: tx, minY: ty, width: t.image.width, height: t.image.height };
    const k = scale ?? autoScale(r.width, r.height);
    checkRegion(r, k);
    const ow = Math.ceil(r.width / k);
    const oh = Math.ceil(r.height / k);
    const out = new Int32Array(ow * oh).fill(TRANSPARENT);
    for (let oy = 0; oy < oh; oy++) {
      const iy = r.minY + oy * k - ty;
      if (iy < 0 || iy >= t.image.height) continue;
      for (let ox = 0; ox < ow; ox++) {
        const ix = r.minX + ox * k - tx;
        if (ix < 0 || ix >= t.image.width) continue;
        const p = t.image.pixels[iy * t.image.width + ix]!;
        out[oy * ow + ox] = p === 0xffffffff ? TRANSPARENT : p & 0xffffff;
      }
    }
    return { width: t.image.width, height: t.image.height, x: tx, y: ty, rect: r, scale: k, outWidth: ow, outHeight: oh, data: base64(out) };
  }

  // ─────────────── GeoPixels ghost image export (Phase 1C.1) ───────────────
  // Their own TemplateManager project: never selectable, started or listed by the simulation.
  // Nothing here contacts GeoPixels; the user imports the exported PNG by hand.

  private ghostRef(templateId: string): TemplateRef {
    if (!isValidId(templateId)) throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    return { projectId: asProjectId(GHOST_PROJECT), templateId: asTemplateId(templateId) };
  }

  private async ghostTemplate(templateId: string): Promise<Template> {
    const ref = this.ghostRef(templateId);
    return (await this.templates.load(ref)).template;
  }

  async importDrawing(input: GhostImportInput & { useAccountPalette?: boolean }) {
    this.guard();this.requireIdle('importing a drawing');
    const batch = this.singlePixelWriter.batch, previous = batch.view();
    check(!['running', 'paused'].includes(previous.state), 'Arrêter le dessin en cours avant d’importer une autre image.');
    check(this.singlePixelWriter.view().open === 0, 'Une opération est en attente ou incertaine : l’arrêter ou la réconcilier avant l’import.');
    // A restored/draft scope has no live authority. Retire it without losing its journal or receipts.
    if (this.singlePixelWriter.view().locked) {
      check(['prepared', 'interrupted', 'blocked'].includes(previous.state), 'Le dessin est encore verrouillé ; vérifier son état avant l’import.');
      await batch.stop('Nouveau modèle importé : ancien accord inactif retiré, confirmations conservées.');
    }
    check(!this.singlePixelWriter.view().locked, 'Le dessin est encore verrouillé ; vérifier son état avant l’import.');
    const account = this.singlePixelWriter.batch.accountPalette();
    const palette = input.useAccountPalette && account.state === 'fresh' && account.colors.length
      ? account.colors.map(hexOf) : input.palette;
    check(palette.length > 0, 'Palette du compte indisponible : attendre la synchronisation ou renseigner une palette manuelle valide.');
    const preset = nextDrawing(this.settingsValue.drawingPreferences ?? EMPTY_DRAWING_PREFERENCES);
    const t=await importGhost(this.templates,pngjsCodec,{...input,palette,x:0,y:0},SIMULATION_PROJECT,preset.strategy);
    await this.selectTemplate(t.id, preset.options);return this.templateInfo(t);
  }
  async exportDrawing(templateId: string, thumbnail = false) {
    const template = await this.currentTemplate(this.ref(templateId));
    const { width, height } = template.image;
    const filename = ghostInfo(template).filename;
    if (thumbnail && Math.max(width, height) > 256) {
      const size = proportionalSize(width, height, width >= height ? { width: 256 } : { height: 256 });
      const image = resizeRgba({ width, height, rgba: quantizedToRgba(template.image) }, size.width, size.height);
      return { png: await pngjsCodec.encode(image), filename };
    }
    return { png: await exportGhostPng(pngjsCodec, template), filename };
  }
  async previewDrawing(groupSize=0,pixelBudget?:number,upgrades?:import('./geopixels/upgrade-policy.js').AutomaticUpgradePolicy, energy?: EnergyPolicy, groups?: GroupPolicy) {
    this.guard();const t=this.selectedTemplate,p=this.connector.status().project;
    check(t!==null && p!==null,'Importer une image et coupler le navigateur avec son fantôme chargé.');
    const rgba=quantizedToRgba(t.image);
    check(t.image.width===p.width && t.image.height===p.height && createHash('sha256').update(rgba).digest('hex')===p.id,
      'Le fantôme ne correspond pas au PNG préparé : télécharger ce PNG et le charger dans GeoPixels.');
    const current=this.singlePixelWriter.batch.view();
    check(!['running','paused'].includes(current.state) && current.uncertain===0,'Arrêter ou réconcilier le dessin actif avant une nouvelle prévisualisation.');
    if(this.singlePixelWriter.batch.busy())await this.singlePixelWriter.batch.stop('Nouvelle prévisualisation demandée ; confirmations conservées.');
    await this.bindConnector();
    let retained=0;for(const color of t.image.pixels)if(color!==0xffffffff)retained++;
    const budget=pixelBudget ?? retained;
    check(Number.isSafeInteger(budget)&&budget>=1&&budget<=retained,'Budget supérieur aux pixels du modèle');
    return this.singlePixelWriter.batch.prepare(this.connector.status().mode==='local-fake'?'fake':'real',budget,'autonomous',budget,{region:{x:0,y:0,width:t.image.width,height:t.image.height},durationMs:null,groupSize,strategy:t.strategy.id,...(upgrades?{upgrades}:{}),...(energy?{energy}:{}),...(groups?{groups}:{})});
  }
  async importGhost(input: GhostImportInput): Promise<GhostInfo> {
    this.guard();
    return ghostInfo(await importGhost(this.templates, pngjsCodec, input));
  }

  async listGhosts(): Promise<{ readonly templates: readonly GhostInfo[]; readonly unreadable: number }> {
    this.guard();
    const listing = await this.templates.list(asProjectId(GHOST_PROJECT));
    const templates: GhostInfo[] = [];
    let unreadable = listing.failures.length;
    for (const s of listing.templates) {
      try {
        templates.push(ghostInfo((await this.templates.load({ projectId: asProjectId(GHOST_PROJECT), templateId: s.templateId })).template));
      } catch {
        unreadable++;
      }
    }
    templates.sort((a, b) => b.updatedAt - a.updatedAt);
    return { templates, unreadable };
  }

  async ghostInfoOf(templateId: string): Promise<GhostInfo> {
    this.guard();
    const t = await this.ghostTemplate(templateId).catch((error: unknown) => {
      if (error instanceof EngineServiceError) throw error;
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    });
    return ghostInfo(t);
  }

  /** The PNG to import by hand in GeoPixels, and its file name. */
  async exportGhost(templateId: string): Promise<{ readonly png: Uint8Array; readonly filename: string }> {
    this.guard();
    const t = await this.ghostTemplate(templateId).catch((error: unknown) => {
      if (error instanceof EngineServiceError) throw error;
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    });
    return { png: await exportGhostPng(pngjsCodec, t), filename: ghostInfo(t).filename };
  }

  async deleteGhost(templateId: string): Promise<{ readonly deleted: string }> {
    this.guard();
    const t = await this.ghostTemplate(templateId).catch((error: unknown) => {
      if (error instanceof EngineServiceError) throw error;
      throw new EngineServiceError('TEMPLATE_NOT_FOUND', 404, `template ${templateId} not found`);
    });
    await this.templates.delete(this.ghostRef(templateId), { confirmName: t.name });
    return { deleted: templateId };
  }

  // ───────────────────────── Settings ─────────────────────────

  private saveSettingsValue(update: (settings: EngineSettings) => EngineSettings): Promise<void> {
    const pending = this.settingsWrite.then(async () => {
      const valid = validateSettings(update(this.settingsValue));
      await saveSettings(this.root, valid);
      this.settingsValue = valid;
    });
    this.settingsWrite = pending.catch(() => {});
    return pending;
  }

  /**
   * Changes the simulation settings (stopped only). A change of the canvas
   * size or of the resource rules changes the identity of the simulated
   * world: it needs `resetWorld` (explicit), never a silent loss.
   */
  async configure(patch: { readonly simulator?: Partial<Omit<SimulatorSettings, 'rulesVersion'>>; readonly agent?: Partial<AgentSettings>; readonly run?: Partial<RunSettings>; readonly resetWorld?: boolean }): Promise<CommandResult> {
    this.guard();
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
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
      await this.saveSettingsValue(settings => ({ ...settings, simulator: next.simulator, agent: next.agent, run: next.run }));
      await this.resetWorldNow('settings changed');
    } else {
      const latencyChanged = next.simulator.writeLatencyMs !== current.simulator.writeLatencyMs;
      await this.saveSettingsValue(settings => ({ ...settings, simulator: next.simulator, agent: next.agent, run: next.run }));
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
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
    this.requireIdle('resetting the simulated world');
    if (confirm !== 'RESET') throw new EngineServiceError('CONFIRMATION_REQUIRED', 400, 'confirm the reset with "RESET"');
    await this.saveSettingsValue(settings => ({ ...settings, simulator: { ...settings.simulator, rulesVersion: settings.simulator.rulesVersion + 1 } }));
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
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
    this.requireIdle('resetting the agent');
    const world = this.requireWorld();
    await world.canvas.setAgent(this.agentSeed(this.settingsValue.agent), 'agent reset');
    this.proposalBase = null;
    return { changed: true, status: this.status() };
  }

  // ───────────────────────── Canvas ─────────────────────────

  /** A region of the simulated canvas with the sequence number it includes (default: the selected template's area). */
  /**
   * A region of the simulated canvas with the sequence number it includes
   * (default: the selected template's area, WHOLE, at the smallest scale
   * that fits one read). `scale` s keeps one pixel out of s in each direction.
   */
  async canvasRegion(rect?: CanvasRect, scale?: number): Promise<CanvasRegion> {
    if (this.source === 'geopixels') {
      const t = this.selectedTemplate;
      check(t !== null, 'select a local model first');
      const region = rect ?? { minX: t.placement.topLeft.x, minY: t.placement.topLeft.y, width: t.image.width, height: t.image.height };
      const k = scale ?? autoScale(region.width, region.height);
      checkRegion(region, k);
      const snapshot = await this.connector.reader.readRegion(region);
      const width = Math.ceil(region.width / k), height = Math.ceil(region.height / k);
      const out = new Int32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = snapshot.get({ x: region.minX + x * k, y: region.minY + y * k });
      return { stream: this.hub.stream, seq: this.hub.seq, rect: region, scale: k, width, height, yAxis: 'down', observedAt: snapshot.observedAt, data: base64(out) };
    }
    const world = this.requireWorld();
    const s = this.settingsValue.simulator;
    let r = rect;
    if (r === undefined) {
      const t = this.selectedTemplate;
      r = t !== null ? { minX: t.placement.topLeft.x, minY: t.placement.topLeft.y, width: t.image.width, height: t.image.height } : { minX: 0, minY: 0, width: s.width, height: s.height };
    }
    const k = scale ?? autoScale(r.width, r.height);
    checkRegion(r, k);
    const region = r;
    const ow = Math.ceil(region.width / k);
    const oh = Math.ceil(region.height / k);
    return world.canvas.withWorld(async (view) => {
      const out = new Int32Array(ow * oh).fill(-2);
      for (let oy = 0; oy < oh; oy++) {
        const cy = region.minY + oy * k;
        if (cy < 0 || cy >= view.bounds.height) continue;
        const row = cy * view.bounds.width;
        for (let ox = 0; ox < ow; ox++) {
          const cx = region.minX + ox * k;
          if (cx >= 0 && cx < view.bounds.width) out[oy * ow + ox] = view.pixels[row + cx]!;
        }
      }
      return { stream: this.hub.stream, seq: this.hub.seq, rect: region, scale: k, width: ow, height: oh, yAxis: 'down', observedAt: this.clock.now(), data: base64(out) };
    });
  }

  /**
   * Demonstration: another actor erases `count` painted pixels of the template area (detected and
   * repainted). Phase 1C.0: one pass with a uniform random sample of at most `count` pixels
   * (reservoir), one reused point, and a yield to the event loop every DEFAULT_SLICE_PIXELS pixels:
   * before, an object per pixel of the area (16 million at 4096 x 4096) and a full shuffle.
   */
  async simulateExternalEdit(count: number): Promise<{ readonly changed: number }> {
    this.guard();
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
    const world = this.requireWorld();
    const t = this.selectedTemplate;
    if (t === null) throw new EngineServiceError('NO_TEMPLATE_SELECTED', 409, 'select a template first');
    const k = Math.max(0, Math.min(count, 10_000));
    const { width, height } = t.image;
    const { x: x0, y: y0 } = t.placement.topLeft;
    const chosen: number[] = [];
    const point = { x: 0, y: 0 };
    let painted = 0;
    let sinceYield = 0;
    for (let iy = 0; iy < height; iy++) {
      point.y = y0 + iy;
      for (let ix = 0; ix < width; ix++) {
        point.x = x0 + ix;
        if (world.canvas.at(point) === TRANSPARENT) continue;
        painted++;
        if (chosen.length < k) chosen.push(iy * width + ix);
        else {
          const j = Math.floor(Math.random() * painted);
          if (j < k) chosen[j] = iy * width + ix;
        }
      }
      sinceYield += width;
      if (sinceYield >= DEFAULT_SLICE_PIXELS) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    const edits = chosen.map((i) => ({ point: { x: x0 + (i % width), y: y0 + Math.floor(i / width) }, color: TRANSPARENT }));
    const changed = await world.canvas.editExternal(edits);
    return { changed: changed.length };
  }

  // ───────────────────────── Resources and upgrades ─────────────────────────

  /** Resources of the simulated agent and the upgrade proposals (computed, never applied automatically). */
  async resourcesView(): Promise<ResourcesView> {
    check(this.source === 'simulation', 'use connector/status for observed browser resources');
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
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
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
    return { mode: 'full', diagnosis: await diagnoseJournal(this.source === 'simulation' ? this.root : path.join(this.root, 'providers', 'geopixels')) };
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
    check(this.source === 'simulation', 'this operation belongs to the simulation source');
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
      if (this.singlePixelWriter.view().locked) await this.singlePixelWriter.stop('Sauvegarde : autorisation retirée, envoi commencé à réconcilier.');
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
    await this.singlePixelWriter.close();
    this.unsubscribe?.();
    this.hub.close();
    await this.checkpointing;
    await this.world?.store.close();
    this.pairing.revoke();
    this.connector.close();
    await this.simulationJournal.close();
    await this.simulationHistory.close();
    await this.connectorJournal.close();
    await this.connectorHistory.close();
    await this.observationSave;
    await this.settingsWrite;
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
