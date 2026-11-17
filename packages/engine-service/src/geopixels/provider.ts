import { randomUUID } from 'node:crypto';
import { ObservationMonitor } from './monitor.js';
import { OBSERVATION_CACHE_BYTES } from './regions.js';
import {
  UNKNOWN,
  createArraySnapshot,
  asRgb,
  type AgentId,
  type ApplyResult,
  type CanvasRect,
  type CanvasSnapshot,
  type PixelWrite,
  type ReadWriteCanvasProvider,
  type ResourceRules,
  type ResourceSource,
  type Template,
  type WriteOptions,
} from '@geoplacer/core';
import {
  CONNECTOR_MAX_AGE_MS,
  ConnectorError,
  check,
  integer,
  parseObservation,
  type BrowserProject,
  type ConnectorMode,
  type ObservedResources,
} from './protocol.js';

export interface BrowserCommand {
  readonly type: 'execute-fake';
  readonly protocol: 1;
  readonly id: string;
  readonly attemptId: string;
  readonly session: string;
  readonly project: BrowserProject;
  readonly writes: readonly { readonly taskId: string; readonly gridX: number; readonly gridY: number; readonly color: number }[];
}
type Pending = {
  command: BrowserCommand;
  finish: (result: ApplyResult) => void;
  fail: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Native GeoPixels grid is Y-up; engine templates remain in their own Y-down image space. */
export function nativePoint(project: BrowserProject, imageX: number, imageY: number) {
  return { x: project.gridX + imageX, y: project.gridY - imageY };
}
export function nativeTile(x: number, y: number) {
  const tileX = Math.floor(x / 1000) * 1000;
  const tileY = Math.floor(y / 1000) * 1000;
  return { tileX, tileY, localX: x - tileX, localY: y - tileY };
}

/** One bounded, immutable-per-read observation cache. Missing data always remains UNKNOWN. */
export class GeoPixelsProvider implements ReadWriteCanvasProvider {
  readonly monitoring: ObservationMonitor;
  observationRevision = 0;
  readValidUntil = 0;
  readonly id = 'geopixels-browser-v1';
  readonly mode = 'read-write' as const;
  readonly reader = { coordinateSystem: { yAxis: 'down' as const }, readRegion: (rect: CanvasRect) => this.readRegion(rect) };
  readonly writer = {
    maxPixelsPerWrite: 256,
    idempotentWrites: false,
    applyPixels: (agent: AgentId, writes: readonly PixelWrite[], options: WriteOptions) => this.applyPixels(agent, writes, options),
  };
  private send: ((command: BrowserCommand) => void) | null = null;
  private channelMode: ConnectorMode | null = null;
  private session: string | null = null;
  private project: BrowserProject | null = null;
  private sequence = 0;
  private pixels = new Int32Array();
  private dates = new Float64Array();
    private captures = new Float64Array();
    private cells = new Float64Array();
  private resourceValue: ObservedResources | null = null;
  private lastSeen: number | null = null;
  private lastCapture: number | null = null;
  private binding: { templateId: string; revision: number; x: number; y: number; key: string } | null = null;
  private pending: Pending | null = null;
  private readonly dispatched = new Set<string>();
  private lastError: string | null = null;
  private closed = false;
  channelEpoch = 0;
  private dated = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 5_000
  ) { this.monitoring = new ObservationMonitor(now); }

  connect(mode: ConnectorMode, send: (command: BrowserCommand) => void): void {
    check(!this.closed, 'connector closed');
    this.disconnect('channel replaced');
    this.channelMode = mode;
    this.send = send;
    this.lastSeen = this.now();
    this.lastError = null;
  }

    disconnect(reason = 'browser disconnected'): void {
        this.observationRevision++;
        this.monitoring.stop(reason);
        this.channelEpoch++;
        this.dated = false;
        this.send = null;
        this.channelMode = null;
        this.session = null;
        this.project = null;
        this.binding = null;
        this.resourceValue = null;
        this.sequence = 0;
        this.pixels = new Int32Array();
        this.dates = new Float64Array();
        this.captures = new Float64Array();
        this.cells = new Float64Array();
        this.lastError = reason;
        this.uncertain();
    }

  heartbeat(): void {
    check(this.send !== null, 'no channel');
    this.lastSeen = this.now();
  }
  private connected(): boolean {
    return this.send !== null && this.lastSeen !== null && this.now() - this.lastSeen <= CONNECTOR_MAX_AGE_MS;
  }
  private key(): string {
    return JSON.stringify([this.session, this.project]);
  }

    observe(value: unknown): void {
        check(this.send !== null, 'no paired channel');
        const o = parseObservation(value, this.now());
        check(o.sequence > this.sequence, 'replayed or out-of-order observation');
        const project = {
            id: o.project.id,
            generation: o.project.generation,
            width: o.project.width,
            height: o.project.height,
            gridX: o.project.gridX,
            gridY: o.project.gridY,
            layer: o.project.layer,
        };
        const changed = this.session !== o.session || JSON.stringify(this.project) !== JSON.stringify(project);
        if (changed && this.project !== null && this.channelMode === 'read-only') {
            this.disconnect('Projet, position, palette ou session modifié : nouveau couplage requis.');
            throw new ConnectorError('CONNECTOR_PROJECT_CHANGED', 'Pair and bind the changed project again');
        }
        if (changed && this.project !== null)
            this.monitoring.stop('Identité du projet modifiée : relier le modèle avant de reprendre.');
        const projectKey = JSON.stringify([o.session, project]);
        // Validate cycle metadata before changing the active project or any pixels.
        this.monitoring.prepare(o, projectKey);
        if (changed) {
            check(
                o.project.width * o.project.height * 20 <= OBSERVATION_CACHE_BYTES,
                'observation memory budget exceeded'
            );
            this.binding = null;
            this.uncertain();
            this.pixels = new Int32Array(o.project.width * o.project.height).fill(UNKNOWN);
            this.dates = new Float64Array(this.pixels.length);
            this.captures = new Float64Array(this.pixels.length);
            this.cells = new Float64Array(Math.ceil(o.project.width / 256) * Math.ceil(o.project.height / 256));
            this.resourceValue = null;
        }
        this.project = project;
        this.session = o.session;
        this.sequence = o.sequence;
        this.lastCapture = o.capturedAt;
        this.dated = o.observedAt !== null && (changed || this.dated);
        this.lastSeen = this.now();
        const delta = { changedKnown: 0, newlyKnown: 0, becameUnknown: 0, unchanged: 0 };
        for (let y = 0; y < o.rect.height; y++) {
            const iy = o.project.gridY - (o.rect.y + y);
            for (let x = 0; x < o.rect.width; x++) {
                const dest = iy * o.project.width + o.rect.x + x - o.project.gridX;
                const date = o.observedAt ?? -o.capturedAt;
                if (
                    o.capturedAt < this.captures[dest]! ||
                    (o.capturedAt === this.captures[dest] && Math.abs(date) < Math.abs(this.dates[dest]!))
                )
                    continue;
                const old = this.pixels[dest]!,
                    next = o.pixels[y * o.rect.width + x]!;
                if (old === next) delta.unchanged++;
                else if (old === UNKNOWN) delta.newlyKnown++;
                else if (next === UNKNOWN) delta.becameUnknown++;
                else delta.changedKnown++;
                this.pixels[dest] = o.pixels[y * o.rect.width + x]!;
                this.dates[dest] = date;
                this.captures[dest] = o.capturedAt;
                this.cells[
                    Math.floor(iy / 256) * Math.ceil(o.project.width / 256) +
                        Math.floor((o.rect.x + x - o.project.gridX) / 256)
                ] = this.observationRevision + 1;
            }
        }
        if (o.resources !== null && (o.resources.observedAt ?? 0) >= (this.resourceValue?.observedAt ?? 0)) {
            this.resourceValue = structuredClone(o.resources);
        }
        this.lastError = null;
        this.observationRevision++;
        this.monitoring.region(o, delta);
    }

  /** Explicit user binding: shape alone never silently selects another local model. */
  bind(template: Template): void {
    check(this.connected() && this.project !== null, 'no observed project');
    check(template.coordinateSystem.yAxis === 'down', 'only Y-down image templates are supported');
    check(
      template.image.width === this.project.width && template.image.height === this.project.height,
      'local template and browser ghost dimensions differ'
    );
    check(this.pending === null, 'operation in flight');
    this.binding = {
      templateId: template.id,
      revision: template.revision,
      x: template.placement.topLeft.x,
      y: template.placement.topLeft.y,
      key: this.key(),
    };
    this.observationRevision++;
  }

  assertBinding(template: Template): void {
    check(this.connected() && this.binding !== null && this.binding.key === this.key(), 'browser project needs an explicit binding');
    check(
      this.binding.templateId === template.id &&
        this.binding.revision === template.revision &&
        this.binding.x === template.placement.topLeft.x &&
        this.binding.y === template.placement.topLeft.y,
      'local template or position changed; bind it again'
    );
  }

    async readRegion(rect: CanvasRect): Promise<CanvasSnapshot> {
        return (await this.readWindow(rect)).snapshot;
    }
    regionStamp(rect: CanvasRect): number {
        const b = this.binding,
            p = this.project;
        if (!b || !p) return -1;
        let version = 0;
        for (
            let y = Math.max(0, Math.floor((rect.minY - b.y) / 256));
            y <= Math.min(Math.ceil(p.height / 256) - 1, Math.floor((rect.minY + rect.height - 1 - b.y) / 256));
            y++
        )
            for (
                let x = Math.max(0, Math.floor((rect.minX - b.x) / 256));
                x <= Math.min(Math.ceil(p.width / 256) - 1, Math.floor((rect.minX + rect.width - 1 - b.x) / 256));
                x++
            )
                version = Math.max(version, this.cells[y * Math.ceil(p.width / 256) + x]!);
        return version;
    }
    async readWindow(rect: CanvasRect) {
        check(
            integer(rect.width, 1, 4096) &&
                integer(rect.height, 1, 4096) &&
                Number.isSafeInteger(rect.minX) &&
                Number.isSafeInteger(rect.minY),
            'invalid read region'
        );
        const out = new Int32Array(rect.width * rect.height).fill(UNKNOWN);
        // This copy is synchronous: use one clock reading for the immutable window.
        const readAt = this.now();
        let observedAt = readAt;
        let known = false;
        this.readValidUntil = Number.MAX_SAFE_INTEGER;
        let capturedMin = Infinity,
            capturedMax = 0,
            sourceMin = Infinity,
            sourceMax = 0,
            undated = false;
        const p = this.project,
            b = this.binding;
        if (this.connected() && p !== null && b !== null && b.key === this.key()) {
            for (let y = 0; y < rect.height; y++)
                for (let x = 0; x < rect.width; x++) {
                    const ix = rect.minX + x - b.x,
                        iy = rect.minY + y - b.y;
                    if (ix < 0 || iy < 0 || ix >= p.width || iy >= p.height) continue;
                    const index = iy * p.width + ix;
                    const date = this.dates[index]!;
                    const sampled = this.captures[index] !== 0 || this.pixels[index] !== UNKNOWN;
                    if (sampled && readAt - Math.abs(date) > CONNECTOR_MAX_AGE_MS) continue;
                    const availableAt = Math.max(Math.abs(date), this.captures[index]!);
                    if (sampled && availableAt > readAt) {
                        this.readValidUntil = Math.min(this.readValidUntil, availableAt - 1);
                        continue; // Tolerated clock skew is not evidence of a future observation.
                    }
                    if (sampled)
                        this.readValidUntil = Math.min(this.readValidUntil, Math.abs(date) + CONNECTOR_MAX_AGE_MS);
                    const color = this.pixels[index]!;
                    out[y * rect.width + x] = color;
                    if (color !== UNKNOWN) {
                        known = true;
                        capturedMin = Math.min(capturedMin, this.captures[index]!);
                        capturedMax = Math.max(capturedMax, this.captures[index]!);
                        if (date < 0 || Object.is(date, -0)) undated = true;
                        else {
                            sourceMin = Math.min(sourceMin, date);
                            sourceMax = Math.max(sourceMax, date);
                        }
                        observedAt = Math.min(observedAt, Math.max(0, date));
                    }
                }
        }
        const snapshot = createArraySnapshot({
            rect,
            coordinateSystem: this.reader.coordinateSystem,
            source: this.channelMode === 'local-fake' ? 'geopixels-fixture' : 'geopixels-observed',
            observedAt: known ? observedAt : 0,
            pixels: out,
        });
        return {
            snapshot,
            validUntil: this.readValidUntil,
            captureRange: capturedMin !== Infinity ? { oldest: capturedMin, newest: capturedMax } : null,
            sourceRange: known && !undated && sourceMin !== Infinity ? { oldest: sourceMin, newest: sourceMax } : null,
            sourceUndated: undated,
        };
    }

  resourceSource(rules: ResourceRules): ResourceSource {
    return {
      observe: async (agent) => {
        const r = this.resourceValue;
        check(this.connected() && this.channelMode === 'local-fake' && r !== null, 'verified resources unavailable');
        check(r.observedAt !== null && this.now() - r.observedAt <= CONNECTOR_MAX_AGE_MS, 'resource observation stale or undated');
        check(
          r.energy !== null &&
            r.currency !== null &&
            r.capacity !== null &&
            r.colors !== null &&
            r.regenIntervalMs === rules.energy.regenIntervalMs &&
            r.capacity === rules.energy.baseCapacity,
          'incomplete or incompatible fixture resources'
        );
        return {
          type: 'resource-observation' as const,
          agent,
          observedAt: r.observedAt,
          energy: r.energy,
          currency: r.currency,
          unlockedColors: r.colors.map(asRgb),
          upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
          availability: { status: 'available' as const },
          capacity: r.capacity,
        };
      },
    };
  }

  canWrite(): boolean {
    return this.connected() && this.channelMode === 'local-fake' && this.binding !== null;
  }

  private async applyPixels(_agent: AgentId, writes: readonly PixelWrite[], options: WriteOptions): Promise<ApplyResult> {
    check(
      this.canWrite() && this.project !== null && this.binding !== null && this.session !== null,
      'real-site writes are unavailable in Phase 2A'
    );
    check(
      this.pending === null &&
        writes.length > 0 &&
        writes.length <= 256 &&
        !this.dispatched.has(options.attemptId) &&
        !options.signal?.aborted,
      'concurrent, repeated, empty or aborted write'
    );
    const b = this.binding,
      p = this.project;
    const ids = new Set<string>();
    for (const w of writes) {
      check(
        !ids.has(w.taskId) && integer(w.color, 0, 0xffffff) && Number.isSafeInteger(w.point.x) && Number.isSafeInteger(w.point.y),
        'invalid writes'
      );
      ids.add(w.taskId);
      check(w.point.x >= b.x && w.point.x < b.x + p.width && w.point.y >= b.y && w.point.y < b.y + p.height, 'write outside binding');
    }
    const command: BrowserCommand = {
      type: 'execute-fake',
      protocol: 1,
      id: randomUUID(),
      attemptId: options.attemptId,
      session: this.session,
      project: { ...p },
      writes: writes.map((w) => ({
        taskId: w.taskId,
        gridX: p.gridX + w.point.x - b.x,
        gridY: p.gridY - (w.point.y - b.y),
        color: w.color,
      })),
    };
    this.dispatched.add(options.attemptId);
    return new Promise<ApplyResult>((finish, fail) => {
      const timer = setTimeout(() => this.uncertain(), this.timeoutMs);
      this.pending = { command, finish, fail, timer };
      options.signal?.addEventListener('abort', () => {
        if (this.pending?.command.id === command.id) this.uncertain();
      });
      try {
        this.send!(command);
      } catch {
        this.uncertain();
      }
    });
  }

  result(value: unknown): void {
    const p = this.pending;
    check(typeof value === 'object' && value !== null, 'unexpected result');
    const v = value as Record<string, unknown>;
    check(
      Object.keys(v).length === 5 && Object.keys(v).every((k) => ['type', 'id', 'attemptId', 'session', 'outcomes'].includes(k)),
      'invalid result fields'
    );
    if (
      (p === null || v.attemptId !== p.command.attemptId) &&
      v.type === 'result' &&
      typeof v.attemptId === 'string' &&
      this.dispatched.has(v.attemptId) &&
      v.session === this.session
    )
      return; // Late replies never close or resurrect an attempt.
    check(p !== null, 'unexpected result');
    check(
      v.type === 'result' &&
        v.id === p.command.id &&
        v.attemptId === p.command.attemptId &&
        v.session === p.command.session &&
        v.session === this.session &&
        JSON.stringify(this.project) === JSON.stringify(p.command.project),
      'result identity mismatch'
    );
    check(Array.isArray(v.outcomes) && v.outcomes.length === p.command.writes.length, 'incomplete result');
    const ids = new Set(p.command.writes.map((w) => w.taskId));
    for (const outcome of v.outcomes as Record<string, unknown>[]) {
      check(
        outcome !== null &&
          typeof outcome === 'object' &&
          Object.keys(outcome).length === 2 &&
          ids.delete(outcome.taskId as string) &&
          ['applied', 'already-correct', 'unknown'].includes(outcome.status as string),
        'invalid outcome'
      );
    }
    if ((v.outcomes as { status: string }[]).some((o) => o.status === 'unknown')) {
      this.uncertain();
      return;
    }
    clearTimeout(p.timer);
    this.pending = null;
    p.finish({ attemptId: p.command.attemptId as ApplyResult['attemptId'], outcomes: v.outcomes as ApplyResult['outcomes'] });
  }

  private uncertain(): void {
    const p = this.pending;
    if (p === null) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.fail(new ConnectorError('WRITE_UNCERTAIN', 'browser operation has no reliable result; reconcile before further work'));
  }

  status() {
    const r = this.resourceValue;
    return {
      protocol: 1,
      connected: this.connected(),
      mode: this.channelMode,
      session: this.session === null || this.resourceValue === null ? 'unavailable' : 'present',
      project: this.project,
      bound: this.binding !== null,
      lastSync: this.lastCapture,
      monitoring: this.monitoring.view(),
      captureAgeMs: this.lastCapture === null ? null : Math.max(0, this.now() - this.lastCapture),
      captureExpired: this.lastCapture !== null && this.now() - this.lastCapture > CONNECTOR_MAX_AGE_MS,
      freshness: this.dated ? 'dated' : 'unverified',
      resources: r,
      resourcesStale: r === null || r.observedAt === null || this.now() - r.observedAt > CONNECTOR_MAX_AGE_MS,
      pending: this.pending?.command.attemptId ?? null,
      error: this.lastError,
      commands: { writeFixture: this.canWrite(), realPlacement: false, purchase: false },
    };
  }

  close(): void {
    this.closed = true;
    this.disconnect('connector closed');
  }
}
