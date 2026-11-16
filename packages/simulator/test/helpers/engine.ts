/**
 * A complete local engine for the scheduler tests: virtual clock, local
 * simulated canvas, in-memory journal and history, ResourceManager,
 * AttemptManager, a mutable template source. Synthetic rules only.
 */

import type {
  AgentId,
  AttemptJournal,
  AttemptManager,
  AutoCompactionPolicy,
  CooperativeOptions,
  JournalEvent,
  ProjectId,
  ResourceManager,
  ResourceRules,
  Rgb,
  SchedulerConfig,
  SchedulerEvent,
  TaskScheduler,
  Template,
  TemplateSource,
  TemplateId,
  TemplateImage,
} from '@geoplacer/core';
import { TRANSPARENT_U32, createAttemptManager, createMemoryHistory, createMemoryJournal, createResourceManager, createScheduler } from '@geoplacer/core';
import { SimulatedCanvasProvider, createManualClock, type ManualClock } from '../../src/index.js';

export const RED = 0xff0000 as Rgb;
export const GREEN = 0x00ff00 as Rgb;
export const BLUE = 0x0000ff as Rgb;
export const A = 'agent-1' as AgentId;
export const P = 'projet' as ProjectId;
export const T = 'fresque' as TemplateId;

// SYNTHETIC rules (tests only, not a real service).
export function rules(capacity = 50, regenIntervalMs = 1000): ResourceRules {
  return {
    schemaVersion: 1,
    id: 'test-scheduler',
    version: 1,
    energy: { costPerPixel: 1, baseCapacity: capacity, capacityLimit: capacity, regenAmount: 1, regenIntervalMs, aboveCapacity: 'keep' },
    palette: { initialColors: [RED, GREEN], unlockable: [] },
    upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
    currency: { maxSpendPerOperation: 1 },
  };
}

export function image(width: number, height: number, color: (x: number, y: number) => number | null): TemplateImage {
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = color(x, y) ?? TRANSPARENT_U32;
  return { width, height, pixels };
}

export function template(img: TemplateImage, revision = 1, at = { x: 2, y: 3 }): Template {
  return {
    id: T,
    projectId: P,
    name: 'fresque',
    revision,
    image: img,
    placement: { topLeft: at },
    coordinateSystem: { yAxis: 'down' },
    palette: { id: 'p', colors: [RED, GREEN, BLUE].map((rgb) => ({ rgb })) },
    alphaThreshold: 128,
    quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
    priority: 0,
    status: 'active',
    strategy: { id: 'top-to-bottom' },
    sourceImageHash: 'a'.repeat(64),
    quantizedImageHash: 'b'.repeat(64),
    createdAt: 0,
    updatedAt: 0,
    warnings: [],
  };
}

export const CONFIG: SchedulerConfig = {
  projectId: P,
  templateId: T,
  agents: [A],
  maxActiveAgents: 1,
  maxBatchSize: 20,
  minBatchSize: 1,
  leaseTtlMs: 600_000,
  unknownPixels: 'skip',
  freshness: { simulated: { maxAgeMs: 60_000 } },
  maxResourceAgeMs: 60_000,
  eta: { msPerPixel: 0, minCoveragePercent: 0 },
  reconcileRetryMs: 500,
  maxWaitMs: 3_600_000,
  maxRecentErrors: 20,
  maxCycles: 5_000,
};

export interface EngineOptions {
  readonly canvasSize?: number;
  readonly energy?: number;
  readonly capacity?: number;
  readonly regenIntervalMs?: number;
  readonly colors?: readonly Rgb[];
  readonly config?: Partial<SchedulerConfig>;
  readonly autoCompaction?: AutoCompactionPolicy;
  readonly journal?: AttemptJournal & { events: JournalEvent[] };
  readonly writeLatencyMs?: number;
  /** Where the scheduler reads the template (default: `current`). */
  readonly templates?: TemplateSource;
  /** Time moves forward by this much at EVERY reading of the clock (a real clock does; Phase 1B.9). */
  readonly tickMs?: number;
  /** Phase 1C.0: cooperative scheduling (yields between phases and slices). */
  readonly cooperative?: CooperativeOptions;
}

/** A process of the engine: a new one over the same journal and canvas is a restart. */
export class Engine {
  readonly clock: ManualClock;
  readonly canvas: SimulatedCanvasProvider;
  readonly journal: AttemptJournal & { events: JournalEvent[] };
  readonly history = createMemoryHistory();
  current: Template;
  resources!: ResourceManager;
  attempts!: AttemptManager;
  scheduler!: TaskScheduler;
  readonly events: SchedulerEvent[] = [];
  sleeps: number[] = [];
  private ids = 0;
  private readonly options: EngineOptions;
  private readonly baseJournal: ReturnType<typeof createMemoryJournal>;

  constructor(tpl: Template, options: EngineOptions = {}) {
    this.options = options;
    const clock = createManualClock(1_000_000);
    const sleep = clock.sleep.bind(clock);
    if (options.tickMs !== undefined) {
      const read = clock.now.bind(clock);
      const tick = options.tickMs;
      Object.assign(clock, { now: () => (clock.advance(tick), read()) });
    }
    // Counted sleeps: the proof that waiting is not a busy loop.
    this.clock = Object.assign(clock, {
      sleep: async (ms: number, signal?: Parameters<ManualClock['sleep']>[1]) => {
        this.sleeps.push(ms);
        return sleep(ms, signal);
      },
    });
    const size = options.canvasSize ?? 64;
    this.canvas = new SimulatedCanvasProvider({ bounds: { minX: 0, minY: 0, width: size, height: size }, coordinateSystem: { yAxis: 'down' }, rules: rules(options.capacity, options.regenIntervalMs), clock: this.clock, writeLatencyMs: options.writeLatencyMs ?? 10 });
    this.canvas.addAgent({ agent: A, energy: options.energy ?? 50, unlockedColors: options.colors ?? [RED, GREEN] });
    this.baseJournal = createMemoryJournal();
    this.journal = options.journal ?? this.baseJournal;
    this.current = tpl;
    this.startProcess();
  }

  /** A new process: fresh ResourceManager, AttemptManager over the same journal, new scheduler. */
  startProcess(overrides: Partial<SchedulerConfig> = {}): TaskScheduler {
    this.resources = createResourceManager(rules(this.options.capacity, this.options.regenIntervalMs));
    this.attempts = createAttemptManager({
      journal: this.journal,
      history: this.history,
      resources: this.resources,
      newAttemptId: () => `att-${++this.ids}` as never,
      ...(this.options.autoCompaction === undefined ? {} : { autoCompaction: this.options.autoCompaction }),
    });
    this.scheduler = createScheduler(
      { ...CONFIG, ...this.options.config, ...overrides },
      {
        clock: this.clock,
        canvas: this.canvas,
        templates: this.options.templates ?? { current: async () => this.current },
        resourceSource: this.canvas.resourceSource(),
        resources: this.resources,
        attempts: this.attempts,
        ...(this.options.cooperative === undefined ? {} : { cooperative: this.options.cooperative }),
      },
    );
    this.scheduler.subscribe((e) => this.events.push(e));
    return this.scheduler;
  }

  /** Canvas pixels that differ from the template (eligible pixels). */
  wrong(tpl: Template = this.current): number {
    let n = 0;
    const { width, height, pixels } = tpl.image;
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const e = pixels[iy * width + ix]!;
        if (e !== TRANSPARENT_U32 && this.canvas.at({ x: tpl.placement.topLeft.x + ix, y: tpl.placement.topLeft.y + iy }) !== e) n++;
      }
    }
    return n;
  }

  /** Points applied more than once by the agent (never expected without external changes). */
  appliedTwice(): number {
    const counts = new Map<string, number>();
    for (const e of this.canvas.events) if (e.kind === 'applied') counts.set(`${e.point.x},${e.point.y}`, (counts.get(`${e.point.x},${e.point.y}`) ?? 0) + 1);
    return [...counts.values()].filter((n) => n > 1).length;
  }

  states(): string[] {
    return this.events.filter((e) => e.type === 'state').map((e) => (e as { to: string }).to);
  }
}

/** Lets pending timers and I/O run until `condition` holds (explicit synchronisation, bounded). */
export async function until(condition: () => boolean, rounds = 2_000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}
