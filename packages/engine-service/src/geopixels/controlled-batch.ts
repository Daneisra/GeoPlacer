import { createHash, randomUUID } from 'node:crypto';
import {
    createScheduler,
    createWorkPlanner,
    prepareTemplate,
    taskIdOf,
    canvasPointKey,
    type AgentId,
    type AttemptId,
    type AttemptManager,
    type PixelWrite,
    type ApplyResult,
    type ResourceManager,
    type Template,
    type TaskScheduler,
    type WriteOptions,
} from '@geoplacer/core';
import { nodeSha256Hasher } from '@geoplacer/adapters-node';
import { monotonicClock } from '../clock.js';
import { check, type BrowserProject } from './protocol.js';
import { nativePoint, type GeoPixelsProvider } from './provider.js';
import type { SinglePixelCommand } from './single-pixel-writer.js';

type State = 'idle' | 'prepared' | 'running' | 'paused' | 'interrupted' | 'blocked' | 'completed' | 'stopped';
type RecordEntry = {
    attemptId: AttemptId;
    identity: string;
    batchId: string;
    write: PixelWrite;
    execution?: 'sequential' | 'grouped';
};
type Batch = {
    id: string;
    identity: string;
    mode: 'fake' | 'real';
    execution?: 'sequential' | 'grouped';
    project: BrowserProject;
    origin: { x: number; y: number };
    writes: PixelWrite[];
    digest: string;
};
type Saved = { schema: 1; batch: Batch | null; records: RecordEntry[] };
export type BatchCommand =
    | (SinglePixelCommand & { batchId: string })
    | {
          protocol: 2;
          attemptId: string;
          batchId: string;
          project: BrowserProject;
          deadline: number;
          pixels: { gridX: number; gridY: number; color: number }[];
      };
type Pending = {
    command: BatchCommand;
    writes: readonly PixelWrite[];
    ready: boolean;
    delivered: boolean;
    resolve: (r: ApplyResult) => void;
    reject: (e: Error) => void;
    settled: Promise<unknown>;
    settle: () => void;
    timer: ReturnType<typeof setTimeout>;
};
type Dependencies = {
    provider: GeoPixelsProvider;
    attempts: AttemptManager;
    resources: ResourceManager;
    agent: AgentId;
    template: () => Template | null;
    initialize: (t: Template, n: number) => void;
    save: (value: Saved) => Promise<void>;
    legacy: () => { attemptId: AttemptId; identity: string; write: PixelWrite } | null;
};
const key = (w: PixelWrite) => canvasPointKey(w.point.x, w.point.y);
const same = (a: PixelWrite, b: PixelWrite) => a.taskId === b.taskId && key(a) === key(b) && a.color === b.color;

/** A closed work scope for the EXISTING scheduler, not a second painting loop. */
export class ControlledBatch {
    private saved: Saved = { schema: 1, batch: null, records: [] };
    private state: State = 'idle';
    private error: string | null = null;
    private scheduler: TaskScheduler | null = null;
    private pending: Pending | null = null;
    private deadline = 0;
    private nextAt = 0;
    private epoch = -1;
    private generation = 0;
    private saveQueue: Promise<void> = Promise.resolve();
    private healthy = true;
    private controlling = false;
    private readonly listeners = new Set<() => void>();
    constructor(private readonly d: Dependencies) {}
    private emit() {
        for (const listener of this.listeners) listener();
    }
    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    private persist() {
        const value = structuredClone(this.saved);
        const task = this.saveQueue.then(() => this.d.save(value));
        this.saveQueue = task.catch(() => {
            this.healthy = false;
            this.error = 'Sauvegarde du lot indisponible : arrêter et vérifier les journaux.';
        });
        return task;
    }
    async open(value: unknown) {
        if (value !== null) {
            const s = value as Saved;
            check(
                s?.schema === 1 &&
                    Object.keys(s).every((k) => ['schema', 'batch', 'records'].includes(k)) &&
                    Array.isArray(s.records) &&
                    s.records.length <= 4096,
                'invalid batch archive'
            );
            const validWrite = (w: PixelWrite) =>
                w &&
                typeof w.taskId === 'string' &&
                w.taskId.length <= 512 &&
                Number.isSafeInteger(w.point?.x) &&
                Number.isSafeInteger(w.point?.y) &&
                Number.isSafeInteger(w.color) &&
                w.color >= 0 &&
                w.color <= 0xffffff;
            check(
                s.records.every(
                    (r) =>
                        typeof r.attemptId === 'string' &&
                        typeof r.batchId === 'string' &&
                        typeof r.identity === 'string' &&
                        r.identity.length < 4096 &&
                        (r.execution === undefined || ['sequential', 'grouped'].includes(r.execution)) &&
                        validWrite(r.write)
                ),
                'invalid batch records'
            );
            if (s.batch)
                check(
                    typeof s.batch.id === 'string' &&
                        typeof s.batch.identity === 'string' &&
                        ['fake', 'real'].includes(s.batch.mode) &&
                        (s.batch.execution === undefined || ['sequential', 'grouped'].includes(s.batch.execution)) &&
                        Number.isSafeInteger(s.batch.origin?.x) &&
                        Number.isSafeInteger(s.batch.origin?.y) &&
                        Array.isArray(s.batch.writes) &&
                        s.batch.writes.length >= 1 &&
                        s.batch.writes.length <= 5 &&
                        s.batch.writes.every(validWrite) &&
                        new Set(s.batch.writes.map(key)).size === s.batch.writes.length &&
                        s.batch.digest === this.digest(s.batch),
                    'invalid saved batch'
                );
            this.saved = s;
            this.state = s.batch ? (s.batch.writes.every((w) => this.done(w)) ? 'completed' : 'interrupted') : 'idle'; // Neither permission nor a live scheduler survives restart.
            for (const a of this.d.attempts.open())
                if (s.batch && a.writes.every((w) => s.batch!.writes.some((candidate) => same(w, candidate))))
                    for (const w of a.writes)
                        if (!s.records.some((r) => r.attemptId === a.attemptId && same(r.write, w)))
                            s.records.push({
                                attemptId: a.attemptId,
                                identity: s.batch.identity,
                                batchId: s.batch.id,
                                execution: s.batch.execution ?? 'sequential',
                                write: w,
                            });
        }
    }
    private digest(b: Omit<Batch, 'digest'> | Batch) {
        return createHash('sha256')
            .update(
                JSON.stringify([
                    b.id,
                    b.identity,
                    b.mode,
                    b.project,
                    b.origin,
                    b.writes,
                    ...(b.execution === undefined ? [] : [b.execution]),
                ])
            )
            .digest('hex');
    }
    private identity(t: Template) {
        return JSON.stringify([
            t.id,
            t.revision,
            t.quantizedImageHash,
            t.placement,
            this.d.provider.status().project,
            this.d.provider.status().mode,
        ]);
    }
    private context(reconnect = false) {
        check(this.healthy, 'batch storage unavailable');
        const t = this.d.template();
        check(t !== null, 'select GeoPixels and stop the other engine first');
        this.d.provider.assertBinding(t);
        const b = this.saved.batch;
        if (b)
            check(
                this.identity(t) === b.identity &&
                    this.d.provider.status().mode === (b.mode === 'real' ? 'read-only' : 'local-fake') &&
                    (reconnect || this.epoch === this.d.provider.channelEpoch),
                'batch model, position, layer or session changed'
            );
        return t;
    }
    busy() {
        return (
            this.controlling ||
            !['idle', 'completed', 'stopped'].includes(this.state) ||
            this.d.attempts.open().some((a) => this.saved.records.some((r) => r.attemptId === a.attemptId))
        );
    }
    private accounted(r: RecordEntry) {
        const a = this.d.attempts.get(r.attemptId);
        return a?.state === 'finished';
    }
    excludedFor(t: Template) {
        return this.excluded(this.identity(t));
    }
    excluded(identity: string) {
        return new Set(
            this.saved.records
                .filter((r) => {
                    const a = this.d.attempts.get(r.attemptId);
                    return (
                        r.identity === identity &&
                        a?.state === 'finished' &&
                        ('reconciled' in a
                            ? !a.reconciled
                            : !a.results.some((result) => result.result.startsWith('observed-')))
                    );
                })
                .map((r) => key(r.write))
        );
    }
    private done(w: PixelWrite) {
        const b = this.saved.batch;
        return !!b && this.saved.records.some((r) => r.batchId === b.id && same(r.write, w) && this.accounted(r));
    }
    private assertArchive() {
        const state = this.d.attempts.state();
        check(
            this.healthy &&
                this.d.attempts.usable() &&
                state.purgedClosed === 0 &&
                state.closed
                    .filter((a) => a.state === 'finished' && !a.reconciled && a.applied > 0)
                    .every((a) => this.saved.records.filter((r) => r.attemptId === a.attemptId).length === a.pixels),
            'confirmation archive incomplete: restore metadata with its journal before writing'
        );
    }
    private halt(reason: string) {
        void this.stop(reason).catch(() => {
            this.healthy = false;
            this.deadline = 0;
            this.error = 'Journal ou sauvegarde du lot indisponible. Aucun nouvel envoi.';
            this.emit();
        });
    }
    async rememberLegacy() {
        const legacy = this.d.legacy();
        if (legacy && !this.saved.records.some((r) => r.attemptId === legacy.attemptId)) {
            check(this.saved.records.length < 4096, 'confirmation archive full');
            this.saved.records.push({ ...legacy, batchId: 'phase2f' });
            await this.persist();
        }
        this.assertArchive();
    }
    async prepare(mode: 'fake' | 'real', limit: number, execution: 'sequential' | 'grouped' = 'sequential') {
        check(
            !this.busy() &&
                !this.controlling &&
                Number.isInteger(limit) &&
                limit >= 1 &&
                limit <= 5 &&
                ['sequential', 'grouped'].includes(execution),
            'stop/reconcile the current lot first; limit is 1..5'
        );
        this.controlling = true;
        const generation = ++this.generation;
        try {
            const t = this.d.template();
            check(t !== null, 'select and bind a model first');
            this.d.provider.assertBinding(t);
            check(
                this.d.provider.status().mode === (mode === 'real' ? 'read-only' : 'local-fake'),
                'wrong batch provider'
            );
            const identity = this.identity(t),
                legacy = this.d.legacy();
            if (legacy && !this.saved.records.some((r) => r.attemptId === legacy.attemptId))
                this.saved.records.push({ ...legacy, batchId: 'phase2f' });
            this.assertArchive();
            check(
                this.saved.records.length + limit <= 4096,
                'confirmation archive full; preserve the journal before further work'
            );
            this.d.initialize(t, 5);
            const state = this.d.resources.observe(this.allowance(t, 5)).state;
            const { snapshot } = await this.d.provider.readWindow({
                minX: t.placement.topLeft.x,
                minY: t.placement.topLeft.y,
                width: t.image.width,
                height: t.image.height,
            });
            const plan = createWorkPlanner().nextBatch(await prepareTemplate(t, { hasher: nodeSha256Hasher }), {
                agent: this.d.agent,
                snapshot,
                resources: state,
                rules: this.d.resources.rules,
                maxBatch: limit,
                inFlight: new Set([...this.d.attempts.inFlight(), ...this.excluded(identity)]),
                committedEnergy: 0,
                unknownPixels: 'skip',
                damageFloor: this.d.attempts.damage()?.at ?? null,
                now: Date.now(),
            });
            check(
                plan.status === 'ok' && plan.writes.length > 0,
                'no known incorrect unconfirmed target; observe the model first'
            );
            const b = {
                id: randomUUID(),
                identity,
                mode,
                execution,
                project: this.d.provider.status().project!,
                origin: { ...t.placement.topLeft },
                writes: [...plan.writes],
            };
            this.saved.batch = { ...b, digest: this.digest(b) };
            this.epoch = this.d.provider.channelEpoch;
            this.deadline = 0;
            this.state = 'prepared';
            this.error = null;
            await this.persist();
            check(generation === this.generation, 'batch preparation interrupted');
            this.context();
            this.emit();
            return this.view();
        } finally {
            this.controlling = false;
        }
    }
    private allowance(t: Template, count?: number) {
        const remaining = count ?? (this.saved.batch ? this.saved.batch.writes.filter((w) => !this.done(w)).length : 5);
        return {
            type: 'resource-observation' as const,
            agent: this.d.agent,
            observedAt: Date.now(),
            energy: remaining,
            capacity: 5,
            currency: 0,
            unlockedColors: t.palette.colors.map((c) => c.rgb),
            upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
            availability: { status: 'available' as const },
        };
    }
    private async executionTemplate() {
        const t = this.context();
        check(this.deadline > Date.now(), 'batch authorization expired');
        // Ephemeral work view of the SAME template/revision. Original pixels and observed canvas are untouched.
        const pixels = new Uint32Array(t.image.pixels.length).fill(0xffffffff);
        for (const w of this.saved.batch!.writes)
            if (!this.done(w)) {
                const x = w.point.x - t.placement.topLeft.x,
                    y = w.point.y - t.placement.topLeft.y;
                check(
                    x >= 0 &&
                        y >= 0 &&
                        x < t.image.width &&
                        y < t.image.height &&
                        t.image.pixels[y * t.image.width + x] === w.color &&
                        taskIdOf(t, w.point.x, w.point.y, w.color) === w.taskId,
                    'approved target no longer matches template'
                );
                pixels[y * t.image.width + x] = w.color;
            }
        return { ...t, image: { ...t.image, pixels } };
    }
    async approve(id: string, digest: string) {
        check(
            !this.controlling &&
                !this.pending &&
                this.d.attempts.open().length === 0 &&
                ['prepared', 'interrupted', 'blocked'].includes(this.state),
            'batch cannot be started'
        );
        this.controlling = true;
        const generation = ++this.generation;
        try {
            check(
                this.saved.batch?.id === id && this.saved.batch.digest === digest,
                'batch approval identity mismatch'
            );
            const t = this.context(true);
            await this.scheduler?.stop({ abort: true });
            check(generation === this.generation, 'batch approval interrupted');
            this.epoch = this.d.provider.channelEpoch;
            this.d.initialize(t, 5);
            this.deadline = Date.now() + 120_000;
            this.state = 'running';
            this.error = null;
            const base = this.d.attempts;
            const finish = async (method: 'finish' | 'fail', args: unknown[]) => {
                const closed = await Reflect.apply(base[method], base, args);
                const p = this.pending;
                if (closed.state === 'finished') this.nextAt = Date.now() + 1000;
                await this.persist();
                if (p && p.command.attemptId === closed.attemptId) {
                    clearTimeout(p.timer);
                    this.pending = null;
                    p.settle();
                }
                this.emit();
                return closed;
            };
            const attempts = new Proxy(base, {
                get: (target, prop) => {
                    if (prop === 'start')
                        return async (id: AttemptId, now: number) => {
                            const leased = base.get(id),
                                b = this.saved.batch!;
                            check(leased?.state === 'leased', 'batch attempt must be leased');
                            const remaining = b.writes.filter((w) => !this.done(w));
                            if (
                                b.execution === 'grouped' &&
                                (leased.writes.length !== remaining.length ||
                                    !remaining.every((w) => leased.writes.some((candidate) => same(w, candidate))))
                            ) {
                                await base.cancel(id, 'Group scope changed: observe and prepare again', now);
                                throw new Error(
                                    'Cibles modifiées ou inconnues : arrêter, réobserver et préparer un nouveau groupe.'
                                );
                            }
                            check(
                                this.saved.records.length + leased.writes.length <= 4096,
                                'confirmation archive full; stop and preserve the journal'
                            );
                            const a = await base.start(id, now);
                            check(
                                a.writes.length >= 1 &&
                                    a.writes.length <= 5 &&
                                    a.writes.every((w) => b.writes.some((candidate) => same(w, candidate))),
                                'attempt outside batch scope'
                            );
                            for (const w of a.writes)
                                this.saved.records.push({
                                    attemptId: id,
                                    write: w,
                                    identity: b.identity,
                                    batchId: b.id,
                                    execution: b.execution ?? 'sequential',
                                });
                            await this.persist();
                            return a;
                        };
                    if (prop === 'inFlight')
                        return () => new Set([...base.inFlight(), ...this.excluded(this.saved.batch!.identity)]);
                    if (prop === 'finish' || prop === 'fail') return (...args: unknown[]) => finish(prop, args);
                    return Reflect.get(target, prop);
                },
            });
            this.scheduler = createScheduler(
                {
                    projectId: t.projectId,
                    templateId: t.id,
                    agents: [this.d.agent],
                    maxActiveAgents: 1,
                    maxBatchSize: this.saved.batch!.execution === 'grouped' ? this.saved.batch!.writes.length : 1,
                    minBatchSize: 1,
                    leaseTtlMs: 30_000,
                    unknownPixels: 'skip',
                    maxResourceAgeMs: 1000,
                    eta: { msPerPixel: 1, minCoveragePercent: 100 },
                    reconcileRetryMs: 500,
                    maxWaitMs: 1000,
                    maxRecentErrors: 10,
                    maxCycles: 100,
                },
                {
                    clock: monotonicClock(),
                    templates: { current: () => this.executionTemplate() },
                    attempts,
                    resources: this.d.resources,
                    resourceSource: { observe: async () => this.allowance(this.context()) },
                    canvas: {
                        id: 'geopixels-approved-batch',
                        mode: 'read-write',
                        reader: {
                            coordinateSystem: this.d.provider.reader.coordinateSystem,
                            readRegion: async (rect) => {
                                this.context();
                                check(this.deadline > Date.now(), 'stopped batch cannot reconcile from cache');
                                return this.d.provider.reader.readRegion(rect);
                            },
                        },
                        writer: {
                            maxPixelsPerWrite: this.saved.batch!.execution === 'grouped' ? 5 : 1,
                            idempotentWrites: false,
                            applyPixels: (_agent, writes, options) => this.dispatch(writes, options),
                        },
                    },
                }
            );
            this.scheduler.subscribe((e) => {
                if (e.type === 'state') {
                    if (e.to === 'completed') {
                        this.state = 'completed';
                        this.deadline = 0;
                    }
                    if (e.to === 'waiting-reconciliation') {
                        this.halt('Lecture ou résultat incertain : lot arrêté.');
                    }
                    if (e.to === 'error') {
                        this.state = 'blocked';
                        this.error = e.reason;
                        this.deadline = 0;
                    }
                    this.emit();
                }
            });
            await this.persist();
            check(generation === this.generation && this.deadline > Date.now(), 'batch start interrupted');
            await this.scheduler.start();
            this.emit();
            return this.view();
        } finally {
            this.controlling = false;
        }
    }
    private dispatch(writes: readonly PixelWrite[], options: WriteOptions): Promise<ApplyResult> {
        // Pause may arrive while the existing scheduler is awaiting a durable start.
        // Nothing has been delivered: close as a known refusal instead of inventing uncertainty.
        if (this.state === 'paused')
            return Promise.resolve({
                attemptId: options.attemptId,
                outcomes: writes.map((w) => ({
                    taskId: w.taskId,
                    status: 'rejected' as const,
                    reason: 'other' as const,
                })),
            });
        this.context();
        const b = this.saved.batch!;
        check(
            this.state === 'running' &&
                this.deadline > Date.now() &&
                !this.pending &&
                writes.length >= 1 &&
                writes.length <= (b.execution === 'grouped' ? 5 : 1) &&
                writes.every(
                    (w) =>
                        b.writes.some((candidate) => same(w, candidate)) &&
                        !this.done(w) &&
                        !this.excluded(b.identity).has(key(w))
                ),
            'write outside authorized batch'
        );
        const w = writes[0]!,
            t = this.d.template()!,
            point = nativePoint(b.project, w.point.x - t.placement.topLeft.x, w.point.y - t.placement.topLeft.y);
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
            settle = resolve;
        });
        return new Promise<ApplyResult>((resolve, reject) => {
            const command: BatchCommand =
                b.execution === 'grouped'
                    ? {
                          protocol: 2,
                          attemptId: options.attemptId,
                          project: b.project,
                          batchId: b.id,
                          deadline: Math.min(this.deadline, Date.now() + 30_000),
                          pixels: writes
                              .map((write) => ({
                                  ...nativePoint(
                                      b.project,
                                      write.point.x - t.placement.topLeft.x,
                                      write.point.y - t.placement.topLeft.y
                                  ),
                              }))
                              .map((point, i) => ({ gridX: point.x, gridY: point.y, color: writes[i]!.color })),
                      }
                    : {
                          protocol: 1,
                          attemptId: options.attemptId,
                          project: b.project,
                          gridX: point.x,
                          gridY: point.y,
                          color: w.color,
                          deadline: Math.min(this.deadline, Date.now() + 30_000),
                          batchId: b.id,
                      };
            const p: Pending = {
                command,
                writes,
                ready: false,
                delivered: false,
                resolve,
                reject,
                settled,
                settle,
                timer: setTimeout(() => {
                    this.halt('Réponse du lecteur absente : lot arrêté.');
                }, 30_000),
            };
            this.pending = p;
            options.signal?.addEventListener('abort', () => {
                void this.cancelPending('Arrêt pendant une opération.').catch(() =>
                    this.halt('Journal indisponible pendant l’arrêt.')
                );
            });
            void this.persist()
                .then(async () => {
                    const delay = Math.max(0, this.nextAt - Date.now());
                    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
                    if (this.pending !== p) return;
                    if (this.state !== 'running' || this.deadline <= Date.now())
                        return this.cancelPending('Lot suspendu avant livraison.');
                    try {
                        this.context();
                        for (const write of writes) {
                            const window = await this.d.provider.readWindow({
                                minX: write.point.x,
                                minY: write.point.y,
                                width: 1,
                                height: 1,
                            });
                            check(
                                window.snapshot.get(write.point) !== -2 && window.validUntil > Date.now(),
                                'target observation expired or unknown'
                            );
                            p.command.deadline = Math.min(p.command.deadline, window.validUntil);
                        }
                        check(this.pending === p && this.state === 'running', 'batch changed while preparing delivery');
                        if (b.mode === 'fake') {
                            p.delivered = true;
                            void this.d.provider.writer
                                .applyPixels(this.d.agent, writes, options)
                                .then((r) =>
                                    this.result(
                                        options.attemptId,
                                        r.outcomes.every(
                                            (o) => o.status === 'applied' || o.status === 'already-correct'
                                        )
                                            ? 'confirmed'
                                            : 'not-sent'
                                    )
                                )
                                .catch(() => this.result(options.attemptId, 'uncertain'));
                        } else {
                            p.ready = true;
                            this.emit();
                        }
                    } catch {
                        if (this.state === 'running') await this.pause();
                        await this.cancelPending('Données du modèle indisponibles avant envoi.');
                    }
                })
                .catch(() => {
                    this.halt('Intention du lot non sauvegardée.');
                });
        });
    }
    claim() {
        this.context();
        check(this.deadline > Date.now(), 'batch permission expired');
        const p = this.pending;
        if (this.state !== 'running' || !p?.ready || p.delivered) return null;
        if (p.command.deadline <= Date.now()) {
            this.halt('Capture expirée avant livraison : observer puis préparer un nouveau lot.');
            return null;
        }
        p.delivered = true;
        p.ready = false;
        return p.command; // No redelivery, including a lost claim reply.
    }
    allowed(id: string) {
        try {
            this.context();
            return (
                this.state === 'running' &&
                this.deadline > Date.now() &&
                this.pending?.command.attemptId === id &&
                this.pending.delivered &&
                this.pending.command.deadline > Date.now()
            );
        } catch {
            return false;
        }
    }
    async result(id: string, status: 'confirmed' | 'not-sent' | 'uncertain') {
        check(
            this.saved.records.some((r) => r.attemptId === id),
            'unknown batch result'
        );
        const p = this.pending;
        if (!p || p.command.attemptId !== id || this.d.attempts.get(id as AttemptId)?.state !== 'started')
            return this.view();
        let contextValid = true;
        try {
            this.context();
        } catch {
            contextValid = false;
        }
        check(p.delivered, 'batch command was not delivered');
        if (
            status === 'uncertain' ||
            !contextValid ||
            !['running', 'paused'].includes(this.state) ||
            this.deadline <= Date.now() ||
            p.command.deadline <= Date.now()
        ) {
            await this.stop('Résultat incertain ou reçu après interruption. Aucun renvoi.');
            return this.view();
        }
        const writes = p.writes;
        if (status === 'not-sent') {
            this.state = 'paused';
            this.error = 'Le lecteur a refusé ce pixel avant envoi. Consulter son message avant de reprendre.';
            void this.scheduler?.pause();
        }
        p.resolve({
            attemptId: id as AttemptId,
            outcomes: writes.map((w) =>
                status === 'confirmed'
                    ? { taskId: w.taskId, status: 'applied' as const }
                    : { taskId: w.taskId, status: 'rejected' as const, reason: 'other' as const }
            ),
        });
        await p.settled;
        return this.view();
    }
    async pause() {
        check(this.state === 'running' || this.state === 'paused', 'batch not running');
        this.state = 'paused';
        void this.scheduler?.pause();
        this.emit();
        if (this.pending && !this.pending.delivered) await this.cancelPending('Pause avant envoi.');
        return this.view();
    }
    resume(id: string, digest: string) {
        this.context();
        check(
            this.saved.batch?.id === id &&
                this.saved.batch.digest === digest &&
                this.state === 'paused' &&
                this.scheduler?.status().state === 'paused' &&
                !this.pending &&
                this.deadline > Date.now(),
            'wait for pause, reconcile, or reapprove the expired batch'
        );
        this.state = 'running';
        this.error = null;
        this.scheduler.resume();
        this.emit();
        return this.view();
    }
    private async cancelPending(reason: string) {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        if (p.delivered) {
            const id = p.command.attemptId as AttemptId;
            try {
                if (this.d.attempts.get(id)?.state === 'started')
                    await this.d.attempts.interrupt(id, reason, Date.now());
            } catch (error) {
                if (this.d.attempts.open().some((a) => a.attemptId === id)) throw error;
            }
            p.reject(new Error('Batch operation uncertain'));
        } else {
            p.resolve({
                attemptId: p.command.attemptId as AttemptId,
                outcomes: p.writes.map((w) => ({ taskId: w.taskId, status: 'rejected', reason: 'other' })),
            });
        }
        p.settle();
    }
    async stop(reason = 'Lot arrêté.') {
        this.generation++;
        this.state = 'stopped';
        this.deadline = 0;
        this.error = reason;
        this.emit();
        await this.cancelPending(reason);
        await this.scheduler?.stop({ abort: true });
        for (const a of this.d.attempts.open())
            if (a.state === 'started') await this.d.attempts.interrupt(a.attemptId, reason, Date.now());
        await this.persist();
        return this.view();
    }
    async tick() {
        if (!['running', 'paused'].includes(this.state)) return;
        try {
            this.context();
            check(this.deadline > Date.now(), 'batch authorization expired');
        } catch {
            await this.stop('Autorisation expirée ou contexte du navigateur modifié.');
        }
    }
    async reconcile() {
        this.context(true);
        const a = this.d.attempts.open()[0];
        check(
            a?.state === 'needs-reconciliation' &&
                !this.pending &&
                this.saved.records.some((r) => r.attemptId === a.attemptId),
            'no uncertain batch attempt to reconcile'
        );
        const windows = await Promise.all(
            a.writes.map((w) => this.d.provider.readWindow({ minX: w.point.x, minY: w.point.y, width: 1, height: 1 }))
        );
        check(
            windows.every(
                (w) =>
                    w.sourceRange !== null &&
                    !w.sourceUndated &&
                    w.sourceRange.oldest > (a.needsReconciliationAt ?? a.startedAt ?? 0)
            ),
            'source freshness unverified: no reconciliation from an undated or partial cache'
        );
        await this.d.attempts.reconcile(
            a.attemptId,
            windows.map((w) => w.snapshot),
            Date.now()
        );
        await this.persist();
        this.emit();
        return this.view();
    }
    /** Read-only comparison: a transport ACK is never evidence of the resulting canvas. */
    async observedView() {
        const view = this.view(),
            batch = this.saved.batch;
        const targets = view.targets.map((t) => ({
            ...t,
            observation: 'unknown' as 'unknown' | 'pending' | 'correct' | 'different',
            observedColor: null as number | null,
            capturedAt: null as number | null,
            sourceAt: null as number | null,
        }));
        if (batch)
            try {
                this.context(true);
                const epoch = this.d.provider.channelEpoch;
                const windows = await Promise.all(
                    batch.writes.map((w) =>
                        this.d.provider.readWindow({
                            minX: w.point.x,
                            minY: w.point.y,
                            width: 1,
                            height: 1,
                        })
                    )
                );
                this.context(true);
                check(
                    this.saved.batch === batch && epoch === this.d.provider.channelEpoch,
                    'batch context changed during comparison'
                );
                windows.forEach((window, i) => {
                    const target = targets[i]!,
                        w = batch.writes[i]!;
                    const color = window.snapshot.get(w.point);
                    if (color === -2 || window.validUntil < Date.now()) return;
                    target.observedColor = color;
                    target.capturedAt = window.captureRange?.oldest ?? null;
                    target.sourceAt = window.sourceRange?.oldest ?? null;
                    const record = this.saved.records.filter((r) => r.batchId === batch.id && same(r.write, w)).at(-1);
                    const attempt = record ? this.d.attempts.get(record.attemptId) : null;
                    // A pre-ACK capture cannot verify that acknowledged operation, even if its color matches.
                    target.observation =
                        target.confirmed &&
                        (!attempt?.closedAt || !target.capturedAt || target.capturedAt <= attempt.closedAt)
                            ? 'pending'
                            : color === w.color
                              ? 'correct'
                              : 'different';
                });
            } catch {
                /* Wrong model, position, provider, expired channel: keep every result unknown. */
            }
        const sent = targets.filter((t) => t.confirmed);
        const count = (value: (typeof targets)[number]['observation']) =>
            sent.filter((t) => t.observation === value).length;
        return {
            ...view,
            targets,
            verification: {
                correct: count('correct'),
                different: count('different'),
                unknown: count('unknown'),
                pending: count('pending'),
                sourceUnverified: sent.some((t) => t.observation !== 'unknown' && t.sourceAt === null),
            },
        };
    }
    view() {
        const b = this.saved.batch;
        const targets =
            b?.writes.map((w) => {
                const r = this.saved.records.filter((r) => r.batchId === b.id && same(r.write, w)).at(-1);
                const a = r ? this.d.attempts.get(r.attemptId) : undefined;
                return {
                    ...nativePoint(b.project, w.point.x - b.origin.x, w.point.y - b.origin.y),
                    color: w.color,
                    state: a?.state ?? 'waiting',
                    confirmed: a?.state === 'finished' && !('reconciled' in a && a.reconciled),
                };
            }) ?? [];
        return {
            id: b?.id ?? null,
            digest: b?.digest ?? null,
            state: this.state,
            mode: b?.mode ?? null,
            execution: b?.execution ?? 'sequential',
            energyCost: targets.length,
            acceptedRequests: new Set(
                this.saved.records
                    .filter(
                        (r) => r.batchId === b?.id && this.accounted(r) && this.excluded(r.identity).has(key(r.write))
                    )
                    .map((r) => r.attemptId)
            ).size,
            targets,
            confirmed: targets.filter((t) => t.confirmed).length,
            total: targets.length,
            error: this.error,
            uncertain: this.d.attempts.open().filter((a) => a.state === 'needs-reconciliation').length,
            expires: this.deadline || null,
            commandReady: !!this.pending?.ready && !this.pending.delivered && this.state === 'running',
            scheduler: this.scheduler?.status().state ?? null,
        };
    }
    grant() {
        const b = this.saved.batch;
        if (!b || this.state !== 'running' || this.deadline <= Date.now()) return null;
        const t = this.d.template();
        if (!t) return null;
        return {
            id: b.id,
            digest: b.digest,
            expires: this.deadline,
            project: b.project,
            ...(b.execution === 'grouped' ? { execution: 'grouped' as const } : {}),
            writes: b.writes.map((w) => {
                const p = nativePoint(b.project, w.point.x - t.placement.topLeft.x, w.point.y - t.placement.topLeft.y);
                return { gridX: p.x, gridY: p.y, color: w.color };
            }),
        };
    }
    async close() {
        await this.stop('Arrêt du serveur ; aucune autorisation ne sera restaurée.');
        await this.saveQueue;
        this.listeners.clear();
    }
}
