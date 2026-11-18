import { MAX_MODEL_PIXELS } from './capacity.js';
import type { PixelCounts } from '@geoplacer/core';
import { check, integer, type BrowserObservation } from './protocol.js';
import { chooseRegion, parseRegions, type ImageRegion, type CaptureRegion } from './regions.js';

export type WatchState = 'stopped' | 'running' | 'paused';
export type CaptureSummary = {
    id: string;
    projectKey: string;
    capturedAt: number;
    receivedAt: number;
    sourceObservedAt: number | null;
    total: number;
    known: number;
    transparent: number;
    unknown: number;
    changedKnown: number;
    newlyKnown: number;
    becameUnknown: number;
    unchanged: number;
    regions: BrowserObservation['rect'][];
    durationMs: number;
    regionCount: number;
    regionId?: string;
    captureRegion?: CaptureRegion;
};
export type ObservationPoint = CaptureSummary & {
  templateId: string | null; progress: PixelCounts | null;
};
type Assembly = CaptureSummary & { next: number; count: number; nextY: number; started: number };

/** Bounded session observation service, never a painting scheduler. No timers or network access. */
export class ObservationMonitor {
  private automatic: {width:number;height:number;cursor:number} | null = null;
  private desired: WatchState = 'stopped';
  private acknowledged: WatchState = 'stopped';
  private revision = 0;
  private ackRevision = 0;
  private supported = false;
    private regionalSupported = false;
    private regionValues: ImageRegion[] = [];
    private regionRevision = 0;
    private readonly served = new Map<string, number>();
    private requested: { serial: number; id: string } | null = null;
    private serial = 0;
    private readonly usage = { envelopes: 0, bytes: 0, completed: 0, aborted: 0 };
  private intervalMs = 10_000;
  private assembly: Assembly | null = null;
  private points: ObservationPoint[] = [];
  private events: { at: number; code: string; message: string }[] = [];
  private listeners = new Set<(kind: 'capture' | 'history' | 'state') => void>();
  private lastReceivedAt: number | null = null;
  private last: CaptureSummary | null = null;
  private reason: string | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  subscribe(fn: (kind: 'capture' | 'history' | 'state') => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(kind: 'capture' | 'history' | 'state') { for (const fn of this.listeners) { try { fn(kind); } catch { /* An observer cannot break receipt. */ } } }
  private event(code: string, message: string) {
    this.events = [...this.events, { at: this.now(), code, message }].slice(-40);
    this.emit('state');
  }
    capabilities(enabled: boolean, regional = false) {
        if (enabled && (!this.supported || (regional && !this.regionalSupported))) {
            this.supported = true;
            this.regionalSupported ||= regional;
            this.emit('state');
        }
    }
    configureRegions(value: unknown, width: number, height: number) {
        check(
            this.regionalSupported && this.desired !== 'running' && this.assembly === null,
            'pause and finish the capture before configuring regions'
        );
        this.automatic=null;
        this.regionValues = parseRegions(value, width, height);
        this.regionRevision++;
        this.revision++;
        this.served.clear();
        this.requested = null;
        this.event('regions', 'Régions d’observation mises à jour.');
    }
    requestRegion(id: string) {
        check(
            this.regionalSupported && this.desired !== 'running' && this.assembly === null,
            'pause before a single region observation'
        );
        check(
            this.regionValues.some((r) => r.id === id && r.enabled),
            'region unavailable or suspended'
        );
        this.requested = { serial: ++this.serial, id };
        this.revision++;
        this.event('region-once', 'Observation régionale demandée.');
    }
    automaticRegions(width:number,height:number) {
        check(this.regionalSupported && this.desired === 'stopped' && !this.assembly,'stop observations before changing automatic regions');
        this.automatic={width,height,cursor:0};this.regionValues=[];this.regionRevision++;this.revision++;
    }
    automaticRegionCount() {return this.automatic ? Math.ceil(this.automatic.width/256)*Math.ceil(this.automatic.height/256) : 0;}
    private automaticRegion() {
        const a=this.automatic;if(!a)return null;
        const columns=Math.ceil(a.width/256),x=(a.cursor%columns)*256,y=Math.floor(a.cursor/columns)*256;
        return {id:'auto-'+a.cursor,name:'Région '+(a.cursor+1),x,y,width:Math.min(256,a.width-x),height:Math.min(256,a.height-y),priority:'primary' as const,enabled:true};
    }
    private selectedRegion() {
        if(this.automatic)return this.automaticRegion();
        return this.requested
            ? (this.regionValues.find((r) => r.id === this.requested!.id) ?? null)
            : chooseRegion(this.regionValues, this.served);
    }
    noteWire(bytes: number, envelopes: number) {
        this.usage.bytes += bytes;
        this.usage.envelopes += envelopes;
    }
    abortCapture(id: string) {
        if (this.assembly?.id !== id) return;
        this.assembly = null;
        this.usage.aborted++;
        this.event(
            'capture-aborted',
            'Capture interrompue : bandes reçues conservées avec leurs dates, aucun point complet ajouté.'
        );
    }
    command(action: 'start' | 'pause' | 'resume' | 'stop', intervalMs: number) {
        check(this.supported, 'install and pair reader 0.3.0 for monitoring');
        check(integer(intervalMs, 5_000, 60_000), 'capture interval must be 5 to 60 seconds');
        if (action === 'start') check(this.desired === 'stopped', 'monitor already started');
        if (action === 'start' || action === 'resume')
            check(
                this.regionValues.length === 0 || this.regionValues.some((r) => r.enabled),
                'all observation regions are suspended'
            );
        if (action === 'pause') check(this.desired === 'running', 'monitor is not running');
        if (action === 'resume') check(this.desired === 'paused', 'monitor is not paused');
        this.desired = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running';
        this.intervalMs = intervalMs;
        this.revision++;
        this.reason = null;
        if (action === 'stop') this.requested = null;
        this.event(
            action,
            {
                start: 'Surveillance demandée',
                pause: 'Pause demandée',
                resume: 'Reprise demandée',
                stop: 'Arrêt demandé',
            }[action]
        );
        return this.view();
    }
  acknowledge(revision: number, state: WatchState) {
    check(integer(revision, 0, this.revision), 'invalid monitoring revision');
    if (revision < this.revision) return; // Late replies cannot resurrect a prior command.
    check(state === this.desired, 'monitoring acknowledgement mismatch');
    if (this.ackRevision === revision && this.acknowledged === state) return;
    this.ackRevision = revision;
    this.acknowledged = state;
    this.emit('state');
  }
    stopObserving(reason: string) {
        this.desired = 'stopped'; this.revision++; this.assembly=null;
        this.automatic=null; this.requested=null; this.reason=reason;
        this.event('stop',reason);
    }
    stop(reason: string) {
        const changed = this.supported || this.assembly !== null || this.desired !== 'stopped';
        this.desired = this.acknowledged = 'stopped';
        this.revision++;
        this.ackRevision = this.revision;
        this.supported = false;
        this.regionalSupported = false;
        this.regionValues = [];
        this.automatic=null;
        this.served.clear();
        this.requested = null;
        this.regionRevision++;
        this.assembly = null;
        this.reason = reason;
        if (changed) this.event('interruption', reason);
    }
    /** Validate cycle continuity BEFORE provider pixels are mutated. Full-width consecutive bands only. */
    prepare(o: BrowserObservation, projectKey: string) {
        const c = o.capture;
        if (!c) {
            this.assembly = null;
            return;
        } // Old readers remain manually usable.
        const area = c.region ?? {
            id: 'whole-model',
            x: 0,
            y: 0,
            width: o.project.width,
            height: o.project.height,
            revision: 0,
        };
        if (c.region) {
            const registered = this.automatic ? this.automaticRegion() : this.regionValues.find((r) => r.id === area.id);
            check(
                this.regionalSupported &&
                    registered?.enabled &&
                    area.revision === this.regionRevision &&
                    ['x', 'y', 'width', 'height'].every((k) => registered[k as 'x'] === area[k as 'x']),
                'unknown, changed or suspended capture region'
            );
        }
        const left = o.project.gridX + area.x,
            top = o.project.gridY - area.y;
        if (c.index === 0) {
            check(
                o.rect.width === area.width && o.rect.x === left && o.rect.y + o.rect.height === top + 1,
                'invalid first capture band'
            );
            check(!this.last || this.last.id !== c.id, 'completed capture replay');
            check(
                !this.last || this.last.projectKey !== projectKey || o.capturedAt >= this.last.capturedAt,
                'delayed obsolete capture'
            );
            if (this.assembly) this.abortCapture(this.assembly.id);
            this.assembly = {
                id: c.id,
                projectKey,
                capturedAt: o.capturedAt,
                receivedAt: this.now(),
                sourceObservedAt: o.observedAt,
                total: 0,
                known: 0,
                transparent: 0,
                unknown: 0,
                changedKnown: 0,
                newlyKnown: 0,
                becameUnknown: 0,
                unchanged: 0,
                ...(c.region ? { regionId: area.id, captureRegion: { ...area } } : {}),
                regions: [],
                regionCount: c.count,
                durationMs: 0,
                next: 0,
                count: c.count,
                nextY: top + 1,
                started: this.now(),
            };
        }
        const a = this.assembly;
        check(
            a &&
                a.id === c.id &&
                a.projectKey === projectKey &&
                a.next === c.index &&
                a.count === c.count &&
                JSON.stringify(a.captureRegion) === JSON.stringify(c.region) &&
                o.rect.width === area.width &&
                o.rect.x === left &&
                o.rect.y + o.rect.height === a.nextY &&
                (c.index !== c.count - 1 || o.rect.y === top - area.height + 1),
            'incomplete or out-of-order capture'
        );
    }
    region(
        o: BrowserObservation,
        delta: Pick<CaptureSummary, 'changedKnown' | 'newlyKnown' | 'becameUnknown' | 'unchanged'>
    ) {
        this.lastReceivedAt = this.now();
        const a = this.assembly;
        if (!a || !o.capture) return;
        a.total += o.pixels.length;
        for (const color of o.pixels) {
            if (color === -2) a.unknown++;
            else {
                a.known++;
                if (color === -1) a.transparent++;
            }
        }
        for (const key of ['changedKnown', 'newlyKnown', 'becameUnknown', 'unchanged'] as const) a[key] += delta[key];
        a.sourceObservedAt =
            a.sourceObservedAt === null || o.observedAt === null ? null : Math.min(a.sourceObservedAt, o.observedAt);
        a.capturedAt = Math.min(a.capturedAt, o.capturedAt);
        a.receivedAt = this.now();
        a.regions.push({ ...o.rect });
        a.nextY = o.rect.y;
        a.next++;
        if (a.next !== a.count) return;
        this.last = {
            id: a.id,
            projectKey: a.projectKey,
            capturedAt: a.capturedAt,
            receivedAt: a.receivedAt,
            sourceObservedAt: a.sourceObservedAt,
            total: a.total,
            known: a.known,
            transparent: a.transparent,
            unknown: a.unknown,
            changedKnown: a.changedKnown,
            newlyKnown: a.newlyKnown,
            becameUnknown: a.becameUnknown,
            unchanged: a.unchanged,
            regions: a.regions,
            regionCount: a.count,
            durationMs: this.now() - a.started,
            ...(a.regionId ? { regionId: a.regionId, captureRegion: a.captureRegion } : {}),
        };
        this.assembly = null;
        // History stores aggregate coverage, never 120 copies of large region lists or pixel arrays.
        this.points = [...this.points, { ...this.last, regions: [], templateId: null, progress: null }].slice(-120);
        this.usage.completed++;
        if (this.automatic && a.regionId) this.automatic.cursor=(this.automatic.cursor+1)%this.automaticRegionCount();
        if (a.regionId) this.served.set(a.regionId, (this.served.get(a.regionId) ?? 0) + 1);
        if (this.requested?.id === a.regionId) {
            this.requested = null;
            this.emit('state');
        }
        this.emit('capture');
    }
  annotate(id: string, templateId: string | null, progress: PixelCounts | null) {
    const last = this.points.at(-1);
    if (!last || last.id !== id) return;
    const p = progress && { total: progress.total, correct: progress.correct, incorrect: progress.incorrect, unknown: progress.unknown, wrongColor: progress.wrongColor, missing: progress.missing };
    this.points[this.points.length - 1] = { ...last, templateId, progress: p };
    this.emit('history');
  }
    persisted() {
        return { schemaVersion: 2, history: this.points };
    }
  restore(points: ObservationPoint[]) { this.points = points.slice(-120); } // Validated at the filesystem boundary.
    control() {
        const r = this.selectedRegion();
        return {
            revision: this.revision,
            state: this.desired,
            intervalMs: this.intervalMs,
            region: r
                ? { id: r.id, x: r.x, y: r.y, width: r.width, height: r.height, revision: this.regionRevision }
                : null,
            customRegions: this.regionValues.length > 0,
            automaticRegions: this.automaticRegionCount(),
            once: this.requested,
        };
    }
    view() {
        return {
            ...this.control(),
            at: this.now(),
            acknowledged: this.acknowledged,
            pending: this.ackRevision !== this.revision,
            supported: this.supported,
            reason: this.reason,
            lastReceivedAt: this.lastReceivedAt,
            lastCapture: this.last,
            regionalSupported: this.regionalSupported,
            configuredRegions: structuredClone(this.regionValues),
            activeRegionId: this.assembly?.regionId ?? null,
            usage: { ...this.usage },
            inFlight: this.assembly !== null,
            history: this.points,
            events: this.events,
        };
    }
}

export function parseObservationHistory(value: unknown): ObservationPoint[] {
    check(typeof value === 'object' && value !== null, 'invalid observation history');
    const v = value as { schemaVersion?: unknown; history?: unknown };
    check(
        Object.keys(v).length === 2 &&
            [1, 2].includes(v.schemaVersion as number) &&
            Array.isArray(v.history) &&
            v.history.length <= 120,
        'invalid observation history'
    );
    const fields = [
        'id',
        'projectKey',
        'capturedAt',
        'receivedAt',
        'sourceObservedAt',
        'total',
        'known',
        'transparent',
        'unknown',
        'changedKnown',
        'newlyKnown',
        'becameUnknown',
        'unchanged',
        'regions',
        'durationMs',
        'regionCount',
        'templateId',
        'progress',
    ];
    for (const p of v.history as ObservationPoint[]) {
        check(
            p !== null &&
                typeof p === 'object' &&
                fields.every((k) => Object.hasOwn(p, k)) &&
                Object.keys(p).every((k) => fields.includes(k) || ['regionId', 'captureRegion'].includes(k)),
            'invalid history point'
        );
        check(
            typeof p.id === 'string' &&
                /^[a-zA-Z0-9._:-]{1,128}$/.test(p.id) &&
                typeof p.projectKey === 'string' &&
                p.projectKey.length <= 1024,
            'invalid history identity'
        );
        for (const key of ['capturedAt', 'receivedAt', 'durationMs'] as const)
            check(integer(p[key], 0, 8_640_000_000_000_000), 'invalid history date');
        check(
            p.sourceObservedAt === null || integer(p.sourceObservedAt, 0, p.capturedAt),
            'invalid history source date'
        );
        for (const key of [
            'total',
            'known',
            'transparent',
            'unknown',
            'changedKnown',
            'newlyKnown',
            'becameUnknown',
            'unchanged',
        ] as const)
            check(integer(p[key], 0, MAX_MODEL_PIXELS), 'invalid history count');
        check(
            p.total === p.known + p.unknown &&
                p.transparent <= p.known &&
                integer(p.regionCount, 1, MAX_MODEL_PIXELS) &&
                Array.isArray(p.regions) &&
                p.regions.length === 0,
            'invalid history coverage'
        );
        if (p.regionId !== undefined) {
            const c = p.captureRegion;
            check(
                typeof p.regionId === 'string' &&
                    /^[a-z][a-z0-9_-]{0,31}$/.test(p.regionId) &&
                    c &&
                    c.id === p.regionId &&
                    Object.keys(c).length === 6 &&
                    integer(c.x, 0, MAX_MODEL_PIXELS-1) &&
                    integer(c.y, 0, MAX_MODEL_PIXELS-1) &&
                    integer(c.width, 1, MAX_MODEL_PIXELS - c.x) &&
                    integer(c.height, 1, MAX_MODEL_PIXELS - c.y) &&
                    integer(c.revision, 0, Number.MAX_SAFE_INTEGER),
                'invalid history region'
            );
        } else check(p.captureRegion === undefined, 'unexpected historical region');
        check(
            p.templateId === null || (typeof p.templateId === 'string' && p.templateId.length <= 128),
            'invalid history template'
        );
        if (p.progress !== null) {
            check(typeof p.progress === 'object' && Object.keys(p.progress).length === 6, 'invalid history progress');
            for (const key of ['total', 'correct', 'incorrect', 'unknown', 'wrongColor', 'missing'] as const)
                check(integer(p.progress[key], 0, MAX_MODEL_PIXELS), 'invalid history progress count');
            check(
                p.progress.total === p.progress.correct + p.progress.incorrect + p.progress.unknown &&
                    p.progress.incorrect === p.progress.wrongColor + p.progress.missing,
                'invalid history progress totals'
            );
        }
    }
    return v.history as ObservationPoint[];
}
