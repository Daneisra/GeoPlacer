import type { PixelCounts } from '@geoplacer/core';
import { check, integer, type BrowserObservation } from './protocol.js';

export type WatchState = 'stopped' | 'running' | 'paused';
export type CaptureSummary = {
  id: string; projectKey: string; capturedAt: number; receivedAt: number; sourceObservedAt: number | null;
  total: number; known: number; transparent: number; unknown: number;
  changedKnown: number; newlyKnown: number; becameUnknown: number; unchanged: number;
  regions: BrowserObservation['rect'][]; durationMs: number; regionCount: number;
};
export type ObservationPoint = CaptureSummary & {
  templateId: string | null; progress: PixelCounts | null;
};
type Assembly = CaptureSummary & { next: number; count: number; nextY: number; started: number };

/** Bounded session observation service, never a painting scheduler. No timers or network access. */
export class ObservationMonitor {
  private desired: WatchState = 'stopped';
  private acknowledged: WatchState = 'stopped';
  private revision = 0;
  private ackRevision = 0;
  private supported = false;
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
  capabilities(enabled: boolean) { if (enabled && !this.supported) { this.supported = true; this.emit('state'); } }
  command(action: 'start' | 'pause' | 'resume' | 'stop', intervalMs: number) {
    check(this.supported, 'install and pair reader 0.3.0 for monitoring');
    check(integer(intervalMs, 5_000, 60_000), 'capture interval must be 5 to 60 seconds');
    if (action === 'start') check(this.desired === 'stopped', 'monitor already started');
    if (action === 'pause') check(this.desired === 'running', 'monitor is not running');
    if (action === 'resume') check(this.desired === 'paused', 'monitor is not paused');
    this.desired = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running';
    this.intervalMs = intervalMs;
    this.revision++;
    this.reason = null;
    this.event(action, { start: 'Surveillance demandée', pause: 'Pause demandée', resume: 'Reprise demandée', stop: 'Arrêt demandé' }[action]);
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
  stop(reason: string) {
    const changed = this.supported || this.assembly !== null || this.desired !== 'stopped';
    this.desired = this.acknowledged = 'stopped';
    this.revision++;
    this.ackRevision = this.revision;
    this.supported = false;
    this.assembly = null;
    this.reason = reason;
    if (changed) this.event('interruption', reason);
  }
  /** Validate cycle continuity BEFORE provider pixels are mutated. Full-width consecutive bands only. */
  prepare(o: BrowserObservation, projectKey: string) {
    const c = o.capture;
    if (!c) { this.assembly = null; return; } // Old readers remain manually usable.
    if (c.index === 0) {
      check(o.rect.width === o.project.width && o.rect.x === o.project.gridX && o.rect.y + o.rect.height === o.project.gridY + 1, 'invalid first capture band');
      check(!this.last || this.last.id !== c.id, 'completed capture replay');
      check(!this.last || this.last.projectKey !== projectKey || o.capturedAt >= this.last.capturedAt, 'delayed obsolete capture');
      this.assembly = {
        id: c.id, projectKey, capturedAt: o.capturedAt, receivedAt: this.now(), sourceObservedAt: o.observedAt,
        total: 0, known: 0, transparent: 0, unknown: 0, changedKnown: 0, newlyKnown: 0, becameUnknown: 0, unchanged: 0,
        regions: [], regionCount: c.count, durationMs: 0, next: 0, count: c.count, nextY: o.project.gridY + 1, started: this.now(),
      };
    }
    const a = this.assembly;
    check(a && a.id === c.id && a.projectKey === projectKey && a.next === c.index && a.count === c.count &&
      o.rect.width === o.project.width && o.rect.x === o.project.gridX && o.rect.y + o.rect.height === a.nextY &&
      (c.index !== c.count - 1 || o.rect.y === o.project.gridY - o.project.height + 1), 'incomplete or out-of-order capture');
  }
  region(o: BrowserObservation, delta: Pick<CaptureSummary, 'changedKnown' | 'newlyKnown' | 'becameUnknown' | 'unchanged'>) {
    this.lastReceivedAt = this.now();
    const a = this.assembly;
    if (!a || !o.capture) return;
    a.total += o.pixels.length;
    for (const color of o.pixels) { if (color === -2) a.unknown++; else { a.known++; if (color === -1) a.transparent++; } }
    for (const key of ['changedKnown', 'newlyKnown', 'becameUnknown', 'unchanged'] as const) a[key] += delta[key];
    a.sourceObservedAt = a.sourceObservedAt === null || o.observedAt === null ? null : Math.min(a.sourceObservedAt, o.observedAt);
    a.capturedAt = Math.min(a.capturedAt, o.capturedAt);
    a.receivedAt = this.now();
    a.regions.push({ ...o.rect });
    a.nextY = o.rect.y;
    a.next++;
    if (a.next !== a.count) return;
    this.last = {
      id: a.id, projectKey: a.projectKey, capturedAt: a.capturedAt, receivedAt: a.receivedAt, sourceObservedAt: a.sourceObservedAt,
      total: a.total, known: a.known, transparent: a.transparent, unknown: a.unknown, changedKnown: a.changedKnown,
      newlyKnown: a.newlyKnown, becameUnknown: a.becameUnknown, unchanged: a.unchanged,
      regions: a.regions, regionCount: a.count, durationMs: this.now() - a.started,
    };
    this.assembly = null;
    // History stores aggregate coverage, never 120 copies of large region lists or pixel arrays.
    this.points = [...this.points, { ...this.last, regions: [], templateId: null, progress: null }].slice(-120);
    this.emit('capture');
  }
  annotate(id: string, templateId: string | null, progress: PixelCounts | null) {
    const last = this.points.at(-1);
    if (!last || last.id !== id) return;
    const p = progress && { total: progress.total, correct: progress.correct, incorrect: progress.incorrect, unknown: progress.unknown, wrongColor: progress.wrongColor, missing: progress.missing };
    this.points[this.points.length - 1] = { ...last, templateId, progress: p };
    this.emit('history');
  }
  persisted() { return { schemaVersion: 1, history: this.points }; }
  restore(points: ObservationPoint[]) { this.points = points.slice(-120); } // Validated at the filesystem boundary.
  control() { return { revision: this.revision, state: this.desired, intervalMs: this.intervalMs }; }
  view() {
    return { ...this.control(), at: this.now(), acknowledged: this.acknowledged, pending: this.ackRevision !== this.revision,
      supported: this.supported, reason: this.reason, lastReceivedAt: this.lastReceivedAt, lastCapture: this.last,
      inFlight: this.assembly !== null, history: this.points, events: this.events };
  }
}

export function parseObservationHistory(value: unknown): ObservationPoint[] {
  check(typeof value === 'object' && value !== null, 'invalid observation history');
  const v = value as { schemaVersion?: unknown; history?: unknown };
  check(Object.keys(v).length === 2 && v.schemaVersion === 1 && Array.isArray(v.history) && v.history.length <= 120, 'invalid observation history');
  const fields = ['id','projectKey','capturedAt','receivedAt','sourceObservedAt','total','known','transparent','unknown','changedKnown','newlyKnown','becameUnknown','unchanged','regions','durationMs','regionCount','templateId','progress'];
  for (const p of v.history as ObservationPoint[]) {
    check(p !== null && typeof p === 'object' && Object.keys(p).length === fields.length && Object.keys(p).every(k => fields.includes(k)), 'invalid history point');
    check(typeof p.id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(p.id) && typeof p.projectKey === 'string' && p.projectKey.length <= 1024, 'invalid history identity');
    for (const key of ['capturedAt','receivedAt','durationMs'] as const) check(integer(p[key],0,8_640_000_000_000_000), 'invalid history date');
    check(p.sourceObservedAt === null || integer(p.sourceObservedAt,0,p.capturedAt), 'invalid history source date');
    for (const key of ['total','known','transparent','unknown','changedKnown','newlyKnown','becameUnknown','unchanged'] as const) check(integer(p[key],0,4_000_000), 'invalid history count');
    check(p.total === p.known + p.unknown && p.transparent <= p.known && integer(p.regionCount,1,2000) && Array.isArray(p.regions) && p.regions.length === 0, 'invalid history coverage');
    check(p.templateId === null || (typeof p.templateId === 'string' && p.templateId.length <= 128), 'invalid history template');
    if (p.progress !== null) {
      check(typeof p.progress === 'object' && Object.keys(p.progress).length === 6, 'invalid history progress');
      for (const key of ['total','correct','incorrect','unknown','wrongColor','missing'] as const) check(integer(p.progress[key],0,4_000_000), 'invalid history progress count');
      check(p.progress.total === p.progress.correct + p.progress.incorrect + p.progress.unknown && p.progress.incorrect === p.progress.wrongColor + p.progress.missing, 'invalid history progress totals');
    }
  }
  return v.history as ObservationPoint[];
}
