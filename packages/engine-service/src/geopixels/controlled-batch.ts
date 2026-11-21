import { validateUpgradePolicy, type AutomaticUpgradePolicy } from './upgrade-policy.js';
import { CONNECTOR_COMMAND_BYTES, CONNECTOR_MAX_GROUP_PIXELS, INITIAL_GROUP_PIXELS } from './batch-limits.js';
import { assertMetadataHeadroom } from './capacity.js';
import { createHash, randomUUID } from 'node:crypto';
import {
    createScheduler,
    computeProgress,
    computeProgressWithinBounds,
    createWorkPlanner,
    prepareTemplate,
    taskIdOf,
    canvasPointKey,
    type AgentId,
    type DrawingStrategyId,
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
import { STRATEGIES } from '../settings.js';
import { check, type BrowserProject } from './protocol.js';
import { nativePoint, type GeoPixelsProvider } from './provider.js';
import { validWriterResources, type WriterResources } from './writer-resources.js';
import { burstBudget, validEnergyPolicy, type BurstPhase, type EnergyPolicy, type GroupPolicy } from './drawing-energy.js';
import type { SinglePixelCommand } from './single-pixel-writer.js';

type State = 'idle' | 'prepared' | 'running' | 'paused' | 'interrupted' | 'blocked' | 'completed' | 'stopped';
type RecordEntry = {
    attemptId: AttemptId;
    identity: string;
    batchId: string;
    write: PixelWrite;
    execution?: 'sequential' | 'grouped' | 'session' | 'continuous' | 'autonomous';
};
export type DrawingScope = { region: { x: number; y: number; width: number; height: number }; durationMs: number | null; groupSize?: number; strategy?: DrawingStrategyId; upgrades?:AutomaticUpgradePolicy; energy?: EnergyPolicy; groups?: GroupPolicy };
type Batch = {
    id: string;
    identity: string;
    mode: 'fake' | 'real';
    execution?: 'sequential' | 'grouped' | 'session' | 'continuous' | 'autonomous';
    budgets?: { pixels: number; energy: number };
    scope?: DrawingScope;
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
    private requiredColorsFor:Template|null=null;
    private requiredUpgradeColors:number[]=[];
    private resourcesAfter=0;
    private auxiliary=false;
    private adaptiveCeiling=CONNECTOR_MAX_GROUP_PIXELS;
    private adaptiveWindow = INITIAL_GROUP_PIXELS;
    private burstPhase: BurstPhase = 'start';
    private lastGroupReason: string | null = null;
    private refusalReason: { attemptId: string; message: string } | null = null;
    private epoch = -1;
    private yieldRegion=true;
    private planningRegion: {id:string;x:number;y:number;width:number;height:number} | null = null;
    private readonly completedRegions = new Set<string>();
    private generation = 0;
    private wallet: { epoch: number; baseline: number; value: WriterResources } | null = null;
    private paletteEvidence: { epoch: number; sequence: number; capturedAt: number; source: WriterResources['source']; colors: number[] } | null = null;
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
        const value = {schema:1 as const,batch:structuredClone(this.saved.batch),records:this.saved.records.slice()};
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
                    Array.isArray(s.records),
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
                        (r.execution === undefined ||
                            ['sequential', 'grouped', 'session', 'continuous', 'autonomous'].includes(r.execution)) &&
                        validWrite(r.write)
                ),
                'invalid batch records'
            );
            if (s.batch)
                check(
                    typeof s.batch.id === 'string' &&
                        typeof s.batch.identity === 'string' &&
                        ['fake', 'real'].includes(s.batch.mode) &&
                        (s.batch.execution === undefined ||
                            ['sequential', 'grouped', 'session', 'continuous', 'autonomous'].includes(s.batch.execution)) &&
                        Number.isSafeInteger(s.batch.origin?.x) &&
                        Number.isSafeInteger(s.batch.origin?.y) &&
                        Array.isArray(s.batch.writes) &&
                        (['continuous','autonomous'].includes(s.batch.execution!)
                            ? s.batch.writes.length === 0 &&
                              this.validScope(s.batch.scope, s.batch.project) &&
                              !!s.batch.budgets &&
                              [s.batch.budgets.pixels, s.batch.budgets.energy].every(
                                  (n) => Number.isSafeInteger(n) && n >= 1 && n <= (s.batch!.execution === 'autonomous' ? s.batch!.project.width*s.batch!.project.height : 1000)
                              )
                            : s.batch.writes.length >= 1) &&
                        s.batch.writes.length <= (s.batch.execution === 'session' ? 25 : 5) &&
                        (s.batch.execution !== 'session' ||
                            (!!s.batch.budgets &&
                                Number.isInteger(s.batch.budgets.pixels) &&
                                s.batch.budgets.pixels >= 1 &&
                                s.batch.budgets.pixels <= 25 &&
                                Number.isInteger(s.batch.budgets.energy) &&
                                s.batch.budgets.energy >= 1 &&
                                s.batch.budgets.energy <= 25 &&
                                s.batch.writes.length <= Math.min(s.batch.budgets.pixels, s.batch.budgets.energy))) &&
                        s.batch.writes.every(validWrite) &&
                        new Set(s.batch.writes.map(key)).size === s.batch.writes.length &&
                        s.batch.digest === this.digest(s.batch),
                    'invalid saved batch'
                );
            this.saved = s;
            this.state = s.batch
                ? !['continuous','autonomous'].includes(s.batch.execution!) && s.batch.writes.every((w) => this.done(w))
                    ? 'completed'
                    : 'interrupted'
                : 'idle'; // Neither permission nor a live scheduler survives restart.
            for (const a of this.d.attempts.open())
                if (s.batch && a.writes.every((w) => this.inScope(w, s.batch!)))
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
                    ...(b.budgets === undefined ? [] : [b.budgets]),
                    ...(b.scope === undefined ? [] : [b.scope]),
                ])
            )
            .digest('hex');
    }
    private validScope(scope: DrawingScope | undefined, project: BrowserProject) {
        const r = scope?.region;
        if(scope?.upgrades)validateUpgradePolicy(scope.upgrades);
        return (
            !!r &&
            Object.keys(scope!).every((k) => ['region', 'durationMs', 'groupSize', 'strategy', 'upgrades', 'energy', 'groups'].includes(k)) &&
            (scope!.energy === undefined || validEnergyPolicy(scope!.energy)) &&
            (scope!.groups === undefined || (Object.keys(scope!.groups).length === 3 && ['adaptive', 'manual'].includes(scope!.groups.mode) &&
                Number.isSafeInteger(scope!.groups.minimum) && scope!.groups.minimum >= 0 &&
                scope!.groups.minimum <= (scope!.groupSize || CONNECTOR_MAX_GROUP_PIXELS) && typeof scope!.groups.allowFinal === 'boolean')) &&
            (scope!.strategy === undefined || STRATEGIES.includes(scope!.strategy)) &&
            Object.keys(r).length === 4 &&
            ['x', 'y', 'width', 'height'].every((k) => Object.hasOwn(r, k)) &&
            [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
            r.x >= 0 &&
            r.y >= 0 &&
            r.width > 0 &&
            r.height > 0 &&
            r.x + r.width <= project.width &&
            r.y + r.height <= project.height &&
            (scope!.durationMs === null || (Number.isSafeInteger(scope!.durationMs) && scope!.durationMs >= 30000 && scope!.durationMs <= 600000)) &&
            (scope!.groupSize === undefined || (Number.isInteger(scope!.groupSize) && scope!.groupSize >= 0 && scope!.groupSize <= CONNECTOR_MAX_GROUP_PIXELS))
        );
    }
    private inScope(w: PixelWrite, b = this.saved.batch!) {
        if (!['continuous','autonomous'].includes(b.execution!)) return b.writes.some((candidate) => same(w, candidate));
        const r = b.scope!.region,
            x = w.point.x - b.origin.x,
            y = w.point.y - b.origin.y;
        return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    }
    private batchWrites() {
        const b = this.saved.batch;
        return !b
            ? []
            : !['continuous','autonomous'].includes(b.execution!)
              ? b.writes
              : [
                    ...new Map(
                        this.saved.records.filter((r) => r.batchId === b.id).map((r) => [key(r.write), r.write])
                    ).values(),
                ];
    }
    private used() {
        return this.saved.records.filter(
            (r) =>
                r.batchId === this.saved.batch?.id &&
                !['failed', 'cancelled'].includes(this.d.attempts.get(r.attemptId)?.state ?? 'started')
        ).length;
    }
    /** Volatile, epoch-bound evidence; never a restored account balance or a clock estimate. */
    observeResources(value: unknown) {
        check(validWriterResources(value), 'invalid writer resources');
        const now = Date.now(),
            epoch = this.d.provider.channelEpoch;
        if (value.capturedAt > now || now - value.capturedAt > 30000) return;
        if (this.d.provider.status().mode === 'read-only') {
            const previous = this.paletteEvidence?.epoch === epoch ? this.paletteEvidence : null;
            if (previous && (value.sequence < previous.sequence || value.capturedAt < previous.capturedAt ||
                (value.sequence === previous.sequence && (value.capturedAt !== previous.capturedAt ||
                    value.source !== previous.source || value.colors.length !== previous.colors.length ||
                    value.colors.some((color, index) => color !== previous.colors[index]))))) return;
            if (!previous || value.sequence > previous.sequence) {
                this.paletteEvidence = { epoch, sequence: value.sequence, capturedAt: value.capturedAt, source: value.source, colors: [...value.colors] };
            }
        }
        // Native color evidence does not replenish energy or change the spending journal.
        if (value.requestStartedAt <= this.resourcesAfter) return;
        const previous = this.wallet?.epoch === epoch ? this.wallet.value : null;
        if (
            previous &&
            (value.sequence < previous.sequence ||
                (value.sequence === previous.sequence &&
                    (value.available > previous.available ||
                        JSON.stringify({ ...value, available: 0 }) !== JSON.stringify({ ...previous, available: 0 }))))
        )
            return;
        // A delayed response initiated before an already closed write cannot replenish its cost.
        const relevant = this.saved.records.filter((r) => {
            try {
                return JSON.parse(r.identity).at(-1) === this.d.provider.status().mode;
            } catch {
                return false;
            }
        });
        let barrier = 0;
        for(const r of relevant){const a=this.d.attempts.get(r.attemptId);if(a && a.state !== 'failed' && a.state !== 'cancelled')barrier=Math.max(barrier,a.closedAt ?? a.startedAt ?? 0);}
        if ((!previous || value.sequence > previous.sequence) && value.requestStartedAt <= barrier) return;
        this.wallet = {
            epoch,
            baseline: previous?.sequence === value.sequence ? this.wallet!.baseline : value.available,
            value: structuredClone(value),
        };
        this.emit();
    }
    accountPalette() {
        const { connected, mode } = this.d.provider.status();
        const sample = connected && mode === 'read-only' && this.paletteEvidence?.epoch === this.d.provider.channelEpoch
            ? this.paletteEvidence : null;
        return {
            state: !sample ? 'unknown' as const : Date.now() - sample.capturedAt > 30000 ? 'stale' as const : 'fresh' as const,
            source: sample?.source ?? null,
            capturedAt: sample?.capturedAt ?? null,
            colors: sample?.colors.slice() ?? [],
        };
    }
    private energy() {
        const value = this.wallet?.epoch === this.d.provider.channelEpoch ? this.wallet.value : null;
        if (!value || Date.now() - value.capturedAt > 30000) return null;
        const committed = this.saved.records.filter((r) => {
            const a = this.d.attempts.get(r.attemptId);
            let modeMatches = false;
            try {
                modeMatches = JSON.parse(r.identity).at(-1) === this.d.provider.status().mode;
            } catch {
                /* damaged metadata is rejected by archive checks */
            }
            return (
                modeMatches &&
                a &&
                !['failed', 'cancelled'].includes(a.state) &&
                (a.startedAt ?? 0) >= value.requestStartedAt
            );
        }).length;
        return {
            available: Math.max(0, Math.min(value.available, this.wallet!.baseline - committed)),
            capturedAt: value.capturedAt,
            capacity: value.capacity ?? value.shop?.capacity ?? null,
            colors: value.colors,
            ...(value.shop ? { shop: value.shop } : {}),
        };
    }
    private scopedTemplate(t: Template, exclude = false) {
        const r = this.saved.batch!.scope!.region,
            pixels = new Uint32Array(t.image.pixels.length).fill(0xffffffff);
        const excluded = exclude ? this.excluded(this.saved.batch!.identity) : new Set<string>();
        for (let y = r.y; y < r.y + r.height; y++)
            for (let x = r.x; x < r.x + r.width; x++)
                if (!excluded.has(canvasPointKey(t.placement.topLeft.x + x, t.placement.topLeft.y + y)))
                    pixels[y * t.image.width + x] = t.image.pixels[y * t.image.width + x]!;
        return { ...t, image: { ...t.image, pixels } };
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
    private context(reconnect = false, allowHeartbeatGap = false) {
        check(this.healthy, 'batch storage unavailable');
        const t = this.d.template();
        check(t !== null, 'select GeoPixels and stop the other engine first');
        this.d.provider.assertBinding(t, allowHeartbeatGap);
        const b = this.saved.batch;
        if (b)
            check(
                this.identity(t) === b.identity &&
                    (b.scope?.strategy === undefined || b.scope.strategy === t.strategy.id) &&
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
    drawingReceipts() {
        const counts = new Map<string, { real: number; fake: number }>();
        for (const record of this.saved.records) {
            const attempt = this.d.attempts.get(record.attemptId);
            if (attempt?.state !== 'finished' || ('reconciled' in attempt && attempt.reconciled)) continue;
            const source = record.identity.endsWith(',"read-only"]') ? 'real' :
                record.identity.endsWith(',"local-fake"]') ? 'fake' : null;
            if (!source) continue;
            const tally = counts.get(attempt.templateId) ?? { real: 0, fake: 0 };
            tally[source]++;
            counts.set(attempt.templateId, tally);
        }
        return counts;
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
        const state = this.d.attempts.state(), counts = new Map<string, number>();
        for (const r of this.saved.records) counts.set(r.attemptId, (counts.get(r.attemptId) ?? 0) + 1);
        check(
            this.healthy &&
                this.d.attempts.usable() &&
                state.purgedClosed === 0 &&
                state.closed
                    .filter((a) => a.state === 'finished' && !a.reconciled && a.applied > 0)
                    .every((a) => counts.get(a.attemptId) === a.pixels),
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
            assertMetadataHeadroom();
            this.saved.records.push({ ...legacy, batchId: 'phase2f' });
            await this.persist();
        }
        this.assertArchive();
    }
    async prepare(
        mode: 'fake' | 'real',
        limit: number,
        execution: 'sequential' | 'grouped' | 'session' | 'continuous' | 'autonomous' = 'sequential',
        energyBudget?: number,
        scope?: DrawingScope
    ) {
        check(
            !this.busy() &&
                !this.controlling &&
                Number.isInteger(limit) &&
                limit >= 1 &&
                limit <= (execution === 'autonomous' ? Number.MAX_SAFE_INTEGER : execution === 'continuous' ? 1000 : execution === 'session' ? 25 : 5) &&
                (['session', 'continuous', 'autonomous'].includes(execution)
                    ? Number.isInteger(energyBudget) &&
                      energyBudget! >= 1 &&
                      energyBudget! <= (execution === 'autonomous' ? Number.MAX_SAFE_INTEGER : execution === 'continuous' ? 1000 : 25)
                    : energyBudget === undefined) &&
                (['continuous','autonomous'].includes(execution) || scope === undefined) &&
                ['sequential', 'grouped', 'session', 'continuous', 'autonomous'].includes(execution),
            'stop/reconcile first; lot limit 1..5, session pixels and energy 1..25'
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
            assertMetadataHeadroom();
            const continuous = ['continuous','autonomous'].includes(execution);
            check(execution === 'autonomous' || scope?.durationMs !== null,'indefinite work requires autonomous mode');
            check(
                !continuous || this.validScope(scope, this.d.provider.status().project!),
                'zone or duration invalid (30..600 seconds)'
            );
            const capacity = execution === 'autonomous' ? Math.min(limit,energyBudget!) : continuous ? 1000 : execution === 'session' ? 25 : 5;
            const budget = ['session', 'continuous', 'autonomous'].includes(execution) ? Math.min(limit, energyBudget!) : limit;
            this.d.initialize(t, capacity);
            check(execution !== 'autonomous' || (limit <= t.image.pixels.length && energyBudget! <= t.image.pixels.length),'budget exceeds model capacity');
            const state = this.d.resources.observe(this.allowance(t, budget, capacity)).state;
            let planned:PixelWrite[]=[];
            if(execution !== 'autonomous') {
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
                maxBatch: budget,
                inFlight: new Set([...this.d.attempts.inFlight(), ...this.excluded(identity)]),
                committedEnergy: 0,
                unknownPixels: 'skip',
                damageFloor: this.d.attempts.damage()?.at ?? null,
                now: Date.now(),
            });
            check(
                continuous || (plan.status === 'ok' && plan.writes.length > 0),
                'no known incorrect unconfirmed target; observe the model first'
            );
            planned=plan.status === 'ok' ? [...plan.writes] : [];
            }
            const b = {
                id: randomUUID(),
                identity,
                mode,
                execution,
                ...(['session', 'continuous', 'autonomous'].includes(execution)
                    ? { budgets: { pixels: limit, energy: energyBudget! } }
                    : {}),
                ...(continuous ? { scope: structuredClone(scope!) } : {}),
                project: this.d.provider.status().project!,
                origin: { ...t.placement.topLeft },
                writes: continuous ? [] : planned,
            };
            this.saved.batch = { ...b, digest: this.digest(b) };
            this.epoch = this.d.provider.channelEpoch;
            this.deadline = 0;
            this.state = 'prepared';
            this.error = null;
            this.resetGroupPolicy();
            await this.persist();
            check(generation === this.generation, 'batch preparation interrupted');
            this.context();
            this.emit();
            return this.view();
        } finally {
            this.controlling = false;
        }
    }
    private groupLimit() {
        return this.saved.batch?.execution==='autonomous' ? Math.min(this.saved.batch.scope?.groupSize || CONNECTOR_MAX_GROUP_PIXELS,CONNECTOR_MAX_GROUP_PIXELS) : 5;
    }
    private resetGroupPolicy() {
        const groups = this.saved.batch?.scope?.groups;
        this.burstPhase = 'start';
        this.lastGroupReason = null;
        this.adaptiveCeiling = this.groupLimit();
        this.adaptiveWindow = groups?.mode === 'manual' ? this.adaptiveCeiling :
            Math.min(this.adaptiveCeiling, Math.max(INITIAL_GROUP_PIXELS, groups?.minimum ?? 0));
    }
    private energyPlan(advance = false) {
        const wallet = this.energy();
        const { connected, resources } = this.d.provider.status();
        const phase = burstBudget(this.saved.batch?.scope?.energy, this.burstPhase,
            connected ? (wallet?.available ?? null) : null, wallet?.capacity ?? resources?.capacity ?? null);
        if (advance) this.burstPhase = phase.phase;
        return connected ? phase : { ...phase, reason: 'Attente du retour du lecteur couplé.' };
    }
    private budgetRemaining() {
        const budget = this.saved.batch?.budgets;
        return budget ? Math.max(0, Math.min(budget.pixels, budget.energy) - this.used()) : 0;
    }
    private groupWait({ size, candidates, progress }: { size: number; candidates: number; progress: { incorrect: number; unknown: number } }) {
        const b = this.saved.batch;
        if (b?.execution !== 'autonomous' || !b.scope?.groups) return null;
        const { minimum, allowFinal } = b.scope.groups;
        const available = this.energyPlan(true).spendable;
        const transport = Math.min(this.groupLimit(), this.adaptiveWindow);
        if (size > Math.min(available, this.budgetRemaining(), transport)) return 'L’énergie ou le budget a changé avant la réservation.';
        const finalRegion = this.planningRegion && !this.completedRegions.has(this.planningRegion.id) &&
            this.completedRegions.size === this.d.provider.monitoring.automaticRegionCount() - 1;
        const final = allowFinal && (size === this.budgetRemaining() ||
            (finalRegion && progress.unknown === 0 && progress.incorrect === candidates && size === candidates));
        if (size < minimum && !final) {
            if (available < minimum && transport >= minimum && b.scope.energy?.mode === 'bursts') this.burstPhase = 'recharge';
            if (candidates < minimum) this.yieldRegion = true;
            this.lastGroupReason = `Minimum ${minimum} : ${size} cibles envoyables actuellement. ${transport < minimum ? 'Le plafond après adaptation est inférieur au minimum.' : 'Attente d’énergie ou de cibles observées suffisantes.'}`;
            return this.lastGroupReason;
        }
        this.lastGroupReason = size < minimum ? 'Dernier groupe partiel autorisé.' : size < this.groupLimit()
            ? `Groupe de ${size} : ${candidates} cibles admissibles, ${available} énergies utilisables, plafond actuel ${transport}.`
            : null;
        return null;
    }
    private allowance(
        t: Template,
        count?: number,
        capacity = ['continuous','autonomous'].includes(this.saved.batch?.execution ?? '')
            ? (this.saved.batch?.execution === 'autonomous' ? this.saved.batch.budgets!.pixels : 1000)
            : this.saved.batch?.execution === 'session'
              ? 25
              : 5
    ) {
        if (count === undefined && ['continuous','autonomous'].includes(this.saved.batch?.execution ?? '')) {
            const b = this.saved.batch!,
                wallet = this.energy();
            const energy = this.budgetRemaining();
            const spendable = this.energyPlan(true).spendable;
            const palette = this.accountPalette();
            const owned = new Set(this.d.provider.status().mode === 'read-only'
                ? (palette.state === 'fresh' ? palette.colors : []) : wallet?.colors);
            return {
                type: 'resource-observation' as const,
                agent: this.d.agent,
                observedAt: Date.now(),
                energy: Math.min(energy, this.auxiliary ? 0 : spendable, b.execution==='autonomous' ? Math.min(this.groupLimit(),this.adaptiveWindow) : Number.MAX_SAFE_INTEGER),
                capacity,
                currency: 0,
                unlockedColors: t.palette.colors.map((c) => c.rgb).filter((c) => owned.has(c) && wallet?.colors.includes(c)),
                upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
                availability:
                    spendable < 1 || energy < 1 || this.auxiliary
                        ? { status: 'unavailable' as const, until: Date.now() + 1000 }
                        : { status: 'available' as const },
            };
        }
        const remaining = count ?? (this.saved.batch ? this.saved.batch.writes.filter((w) => !this.done(w)).length : 5);
        return {
            type: 'resource-observation' as const,
            agent: this.d.agent,
            observedAt: Date.now(),
            energy: remaining,
            capacity,
            currency: 0,
            unlockedColors: t.palette.colors.map((c) => c.rgb),
            upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
            availability: { status: 'available' as const },
        };
    }
    upgradeAuthority() {
        try {this.context();const b=this.saved.batch;return b?.execution==='autonomous' && this.state==='running' && this.deadline>Date.now() && b.scope?.upgrades && !this.d.attempts.open().some(a=>a.state==='needs-reconciliation') ? {job:b.id,project:b.project,policy:b.scope.upgrades}:null;}catch{return null;}
    }
    upgradeResources(){
        const frame=this.wallet?.epoch===this.d.provider.channelEpoch && Date.now()-this.wallet.value.capturedAt<=30000 ? this.wallet.value:null;
        if(!frame)return null;
        if (this.d.provider.status().mode === 'read-only' && this.paletteEvidence?.sequence !== frame.sequence) return null;
        // A conservative debit is spendable for paint, but is NOT a new account/shop observation.
        for(const record of this.saved.records){const a=this.d.attempts.get(record.attemptId);if(a?.state==='finished' && !('reconciled' in a && a.reconciled) && (a.closedAt??a.startedAt??0)>=frame.requestStartedAt){try{if(JSON.parse(record.identity).at(-1)===this.d.provider.status().mode)return null;}catch{return null;}}}
        return structuredClone(frame);
    }
    async lockUpgrades(){
        if(!this.upgradeAuthority() || this.pending || this.d.attempts.open().length)return false;
        this.auxiliary=true;await this.scheduler?.pause();
        if(!this.upgradeAuthority() || this.pending || this.d.attempts.open().length){this.unlockUpgrades();return false;}
        return true;
    }
    unlockUpgrades(){this.auxiliary=false;this.wallet=null;if(this.state==='running' && this.scheduler?.status().state==='paused' && this.upgradeAuthority())this.scheduler.resume();}
    private upgradeColors(){const t=this.context();if(t!==this.requiredColorsFor){this.requiredUpgradeColors=[...new Set(t.image.pixels)].filter(c=>c!==0xffffffff);this.requiredColorsFor=t;}return this.requiredUpgradeColors;}
    async upgradeProgress(){
        const t=this.context(),r=this.planningRegion??this.autonomousRegion();
        const rect={minX:t.placement.topLeft.x+r.x,minY:t.placement.topLeft.y+r.y,width:r.width,height:r.height};
        const w=await this.d.provider.readWindow(rect),coordinateSystem={yAxis:'down' as const,bounds:rect};
        // An upgrade estimate must never move the paint scheduler's active region.
        return {progress:computeProgressWithinBounds({...t,coordinateSystem},{...w.snapshot,coordinateSystem},Date.now(),{}),colors:this.upgradeColors()};
    }
    transportRenewable() {
        try {this.context();return this.saved.batch?.execution === 'autonomous' && ['running','paused'].includes(this.state) && this.deadline> Date.now() && !this.pending?.delivered && this.d.attempts.open().every(a=>a.state !== 'needs-reconciliation');}
        catch{return false;}
    }
    private autonomousRegion() {
        const t=this.context(false, true), r=this.d.provider.monitoring.view().lastCapture?.captureRegion;
        if(this.planningRegion && !this.yieldRegion && !this.completedRegions.has(this.planningRegion.id))return this.planningRegion;
        const candidate=[...this.d.provider.monitoring.view().history].reverse().find(c=>c.projectKey===this.d.provider.monitoring.view().lastCapture?.projectKey && c.captureRegion?.id.startsWith('auto-') && c.captureRegion.revision===this.d.provider.monitoring.control().region?.revision && c.captureRegion.x+c.captureRegion.width<=t.image.width && c.captureRegion.y+c.captureRegion.height<=t.image.height && Date.now()-c.capturedAt<30000 && !this.completedRegions.has(c.captureRegion.id));
        if(candidate?.captureRegion)return candidate.captureRegion;
        return r?.id.startsWith('auto-') && r.revision===this.d.provider.monitoring.control().region?.revision && r.x+r.width<=t.image.width && r.y+r.height<=t.image.height ? r : {id:'auto-0',x:0,y:0,width:Math.min(256,t.image.width),height:Math.min(256,t.image.height)};
    }
    private async executionTemplate() {
        const t = this.context(false, true);
        check(this.deadline > Date.now(), 'batch authorization expired');
        if(this.saved.batch!.execution === 'autonomous') {
            const r=this.autonomousRegion();this.planningRegion=r;
            const pixels=new Uint32Array(r.width*r.height).fill(0xffffffff),excluded=this.excluded(this.saved.batch!.identity);
            for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
                const gx=t.placement.topLeft.x+r.x+x,gy=t.placement.topLeft.y+r.y+y;
                if(!excluded.has(canvasPointKey(gx,gy))) pixels[y*r.width+x]=t.image.pixels[(r.y+y)*t.image.width+r.x+x]!;
            }
            return {...t,image:{width:r.width,height:r.height,pixels},placement:{topLeft:{x:t.placement.topLeft.x+r.x,y:t.placement.topLeft.y+r.y}}};
        }
        if (['continuous','autonomous'].includes(this.saved.batch!.execution!)) return this.scopedTemplate(t, true);
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
            check(this.saved.batch!.execution !== 'autonomous' || !this.d.provider.monitoring.view().inFlight,'Observation en cours : attendre sa fin avant de lancer le dessin.');
            await this.scheduler?.stop({ abort: true });
            check(generation === this.generation, 'batch approval interrupted');
            this.epoch = this.d.provider.channelEpoch;
            this.d.initialize(
                t,
                ['continuous','autonomous'].includes(this.saved.batch!.execution!) ? (this.saved.batch!.execution === 'autonomous' ? this.saved.batch!.budgets!.pixels : 1000) : this.saved.batch!.execution === 'session' ? 25 : 5
            );
            this.deadline = this.saved.batch!.execution === 'autonomous' ? Number.MAX_SAFE_INTEGER : Date.now() + (this.saved.batch!.scope?.durationMs ?? 120_000);
            this.completedRegions.clear();this.planningRegion=null;this.yieldRegion=true;
            this.resetGroupPolicy();
            if(this.saved.batch!.execution === 'autonomous') {
                const monitor=this.d.provider.monitoring;
                if(monitor.control().state !== 'stopped') monitor.command('stop',5000);
                monitor.automaticRegions(t.image.width,t.image.height);
                monitor.command('start',5000);
            }
            this.state = 'running';
            this.error = null;
            const base = this.d.attempts;
            const finish = async (method: 'finish' | 'fail', args: unknown[]) => {
                if (method === 'fail' && this.refusalReason?.attemptId === args[0]) {
                    args[1] = this.refusalReason!.message;
                    this.refusalReason = null;
                }
                const closed = await Reflect.apply(base[method], base, args);
                const p = this.pending;
                if (closed.state === 'finished')
                    this.nextAt =
                        Date.now() +
                        (['continuous','autonomous'].includes(this.saved.batch?.execution ?? '') && this.saved.batch!.mode === 'fake' ? 10 : 1000);
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
                            assertMetadataHeadroom();
                            if (['continuous','autonomous'].includes(b.execution!)) {
                                const t = this.context();
                                check(
                                    this.used() + leased.writes.length <=
                                        Math.min(b.budgets!.pixels, b.budgets!.energy) &&
                                        leased.writes.every(
                                            (w) =>
                                                this.inScope(w, b) &&
                                                t.image.pixels[
                                                    (w.point.y - b.origin.y) * t.image.width + w.point.x - b.origin.x
                                                ] === w.color &&
                                                taskIdOf(t, w.point.x, w.point.y, w.color) === w.taskId
                                        ),
                                    'continuous scope or budget changed'
                                );
                            }
                            const a = await base.start(id, now);
                            check(
                                a.writes.length >= 1 &&
                                    a.writes.length <= this.groupLimit() &&
                                    a.writes.every((w) => this.inScope(w, b)),
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
                            if (b.scope?.energy?.mode === 'bursts') this.energyPlan(true);
                            await this.persist();
                            return a;
                        };
                    if (prop === 'inFlight')
                        return () =>
                            new Set([
                                ...base.inFlight(),
                                ...this.excluded(this.saved.batch!.identity),
                                ...this.saved.records
                                    .filter((r) => r.batchId === this.saved.batch!.id && this.accounted(r))
                                    .map((r) => key(r.write)),
                            ]);
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
                    maxBatchSize: ['session', 'continuous', 'autonomous'].includes(this.saved.batch!.execution!)
                        ? (this.saved.batch!.execution === 'autonomous' ? this.groupLimit() : (this.saved.batch!.scope?.groupSize ?? 5))
                        : this.saved.batch!.execution === 'grouped'
                          ? this.saved.batch!.writes.length
                          : 1,
                    minBatchSize: 1,
                    leaseTtlMs: 30_000,
                    unknownPixels: 'skip',
                    maxResourceAgeMs: 1000,
                    eta: { msPerPixel: 1, minCoveragePercent: 100 },
                    reconcileRetryMs: 500,
                    maxWaitMs: 1000,
                    maxRecentErrors: 10,
                    maxCycles: ['continuous','autonomous'].includes(this.saved.batch!.execution!) ? null : 100,
                    watchOnIdle: ['continuous','autonomous'].includes(this.saved.batch!.execution!),
                },
                {
                    clock: monotonicClock(),
                    templates: { current: () => this.executionTemplate() },
                    attempts,
                    resources: this.d.resources,
                    resourceSource: { observe: async () => this.allowance(this.context(false, true)) },
                    groupWait: (group) => this.groupWait(group),
                    canvas: {
                        id: 'geopixels-approved-batch',
                        mode: 'read-write',
                        reader: {
                            coordinateSystem: this.d.provider.reader.coordinateSystem,
                            readRegion: async (rect) => {
                                this.context(false, true);
                                check(this.deadline > Date.now(), 'stopped batch cannot reconcile from cache');
                                return this.d.provider.reader.readRegion(rect);
                            },
                        },
                        writer: {
                            maxPixelsPerWrite:
                                this.saved.batch!.execution === 'sequential' ||
                                this.saved.batch!.execution === undefined
                                    ? 1
                                    : this.groupLimit(),
                            idempotentWrites: false,
                            applyPixels: (_agent, writes, options) => this.dispatch(writes, options),
                        },
                    },
                }
            );
            this.scheduler.subscribe((e) => {
                if(e.type === 'progress' && this.saved.batch!.execution === 'autonomous' && this.planningRegion) {
                    this.yieldRegion=e.progress.incorrect===0;
                    if(e.progress.completion === 'complete' || e.progress.completion === 'no-eligible-pixels') this.completedRegions.add(this.planningRegion.id);
                    else this.completedRegions.delete(this.planningRegion.id);
                }
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
                        this.error = e.reason?.startsWith('TEMPLATE_UNAVAILABLE:')
                            ? 'Liaison du fantôme perdue. Reconnectez le lecteur si nécessaire et vérifiez à nouveau le PNG avant de lancer.'
                            : e.reason;
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
        // Pause or stop may arrive while the existing scheduler is awaiting a durable start.
        // Nothing has been delivered: close as a known refusal instead of inventing uncertainty.
        if (this.state !== 'running' || options.signal?.aborted || this.deadline <= Date.now())
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
                writes.length <= (['grouped', 'session', 'continuous', 'autonomous'].includes(b.execution!) ? this.groupLimit() : 1) &&
                writes.every((w) => this.inScope(w, b) && !this.done(w) && !this.excluded(b.identity).has(key(w))),
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
            const command: BatchCommand = ['grouped', 'session', 'continuous', 'autonomous'].includes(b.execution!)
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
                            if (['continuous','autonomous'].includes(b.execution!) && window.snapshot.get(write.point) === write.color)
                                return this.cancelPending(
                                    'Cible devenue conforme avant livraison ; recalcul du groupe.'
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
                        if (this.state === 'running' && !['continuous','autonomous'].includes(b.execution!)) await this.pause();
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
    async result(id: string, status: 'confirmed' | 'not-sent' | 'uncertain' | 'waiting-resources' | 'rejected-size') {
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
        check(
            status !== 'waiting-resources' || ['continuous','autonomous'].includes(this.saved.batch?.execution ?? ''),
            'resource wait requires continuous session'
        );
        if(status==='rejected-size' || status==='waiting-resources')this.resourcesAfter=Date.now();
        if(status === 'rejected-size') {
            check(this.saved.batch?.execution==='autonomous','adaptive rejection requires autonomous drawing');
            this.adaptiveCeiling=Math.max(1,Math.min(this.adaptiveCeiling,Math.floor(p.writes.length/2)));
            this.adaptiveWindow=this.adaptiveCeiling;
            this.wallet=null; // New native evidence required; no imaginary energy refund.
        }
        if(status==='confirmed' && this.saved.batch?.execution==='autonomous')this.adaptiveWindow=Math.min(this.adaptiveCeiling,this.adaptiveWindow*2);
        if (status === 'waiting-resources') this.wallet = null; // A refusal cannot leave a spendable stale balance.
        if (status === 'waiting-resources' && this.saved.batch?.scope?.energy?.mode === 'bursts') this.burstPhase = 'recharge';
        if (status !== 'confirmed') this.refusalReason = { attemptId: id, message: status === 'rejected-size'
            ? `Refus HTTP 413 pour ${p.writes.length} cibles. Plafond réduit à ${this.adaptiveCeiling}.`
            : status === 'waiting-resources' ? 'Données d’énergie insuffisantes au contrôle du lecteur. Nouvelle observation requise.'
              : 'Contrôle du lecteur refusé avant envoi.' };
        const writes = p.writes;
        if (status === 'not-sent' || (status==='rejected-size' && writes.length===1)) {
            this.state = 'paused';
            this.error = this.refusalReason?.message ?? 'Consulter le diagnostic du lecteur avant de reprendre.';
            void this.scheduler?.pause();
        }
        p.resolve({
            ...(['waiting-resources','rejected-size'].includes(status) ? { resources: this.allowance(this.context()) } : {}),
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
        if(this.saved.batch?.execution === 'autonomous') this.d.provider.monitoring.stopObserving(reason);
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
            if (this.deadline <= Date.now()) {
                await this.stop(
                    'Autorisation de dessin expirée : durée maximale atteinte. Nouvelle autorisation requise.'
                );
                return;
            }
            this.context(false, true);
            const b = this.saved.batch!;
            if (
                ['continuous','autonomous'].includes(b.execution!) &&
                (this.used() >= Math.min(b.budgets!.pixels, b.budgets!.energy) || (b.execution === 'autonomous' && this.completedRegions.size >= this.d.provider.monitoring.automaticRegionCount() && this.completedRegions.size > 0)) &&
                !this.pending &&
                this.d.attempts.open().length === 0
            ) {
                await this.stop(this.used() >= Math.min(b.budgets!.pixels,b.budgets!.energy) ? 'Budget autorisé atteint.' : 'Régions parcourues : aucune cible supplémentaire à envoyer.');
                this.state = 'completed';
                this.emit();
            }
        } catch {
            const provider = this.d.provider.status();
            await this.stop(
                !this.healthy
                    ? 'Stockage du lot indisponible : journal à vérifier.'
                    : !provider.connected
                      ? `Canal navigateur interrompu : ${provider.error ?? 'lecteur déconnecté'}`
                      : this.epoch !== this.d.provider.channelEpoch
                        ? 'Couplage navigateur remplacé : nouveau couplage et nouvelle autorisation requis.'
                        : 'Modèle, position, couche ou état du moteur modifié : nouveau couplage et nouvelle autorisation requis.'
            );
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
            batch = this.saved.batch,
            writes = this.batchWrites().slice(batch?.execution === 'autonomous' ? -200 : 0),
            latest = new Map(this.saved.records.filter((r) => r.batchId === batch?.id).map((r) => [key(r.write), r]));
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
                    writes.map((w) =>
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
                        w = writes[i]!;
                    const color = window.snapshot.get(w.point);
                    if (color === -2 || window.validUntil < Date.now()) return;
                    target.observedColor = color;
                    target.capturedAt = window.captureRange?.oldest ?? null;
                    target.sourceAt = window.sourceRange?.oldest ?? null;
                    const record = latest.get(key(w));
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
        let regionProgress = null;
        if (batch?.execution === 'continuous')
            try {
                const t = this.context(true),
                    r = batch.scope!.region;
                const w = await this.d.provider.readWindow({
                    minX: batch.origin.x + r.x,
                    minY: batch.origin.y + r.y,
                    width: r.width,
                    height: r.height,
                });
                const p = computeProgress(this.scopedTemplate(t), w.snapshot, Date.now());
                regionProgress = {
                    correct: p.correct,
                    incorrect: p.incorrect,
                    unknown: p.unknown,
                    percent:
                        p.completion === 'complete'
                            ? 100
                            : p.unknown === 0 && p.correct + p.incorrect > 0
                              ? (100 * p.correct) / (p.correct + p.incorrect)
                              : null,
                };
            } catch {
                /* unavailable/expired remains unknown */
            }
        return {
            ...view,
            regionProgress,
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
    control(){const b=this.saved.batch;return {id:b?.id??null,execution:b?.execution??'sequential',scope:b?.scope??null,commandReady:!!this.pending?.ready && !this.pending.delivered && this.state==='running'};}
    view() {
        const b = this.saved.batch;
        const scheduler = this.scheduler?.status();
        const energyPolicy = this.energyPlan();
        let templateId: string | null = null;
        if (b) {
            try {
                const identity: unknown = JSON.parse(b.identity);
                if (Array.isArray(identity) && typeof identity[0] === 'string') templateId = identity[0];
            } catch { /* Identifiers from unreadable archives stay unavailable. */ }
        }
        const latest = new Map(this.saved.records.filter((r) => r.batchId === b?.id).map((r) => [key(r.write), r]));
        const accepted = b ? this.excluded(b.identity) : new Set<string>();
        const targets =
            this.batchWrites().slice(b?.execution === 'autonomous' ? -200 : 0).map((w) => {
                const b = this.saved.batch!;
                const r = latest.get(key(w));
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
            templateId,
            digest: b?.digest ?? null,
            state: this.state,
            mode: b?.mode ?? null,
            execution: b?.execution ?? 'sequential',
            limits:{maxGroupPixels:CONNECTOR_MAX_GROUP_PIXELS,commandBytes:CONNECTOR_COMMAND_BYTES},
            adaptiveGroupSize: Math.min(this.groupLimit(), this.adaptiveWindow, energyPolicy.spendable, b?.budgets ? this.budgetRemaining() : this.groupLimit()),
            energyPolicy,
            groupCeiling: Math.min(this.groupLimit(), this.adaptiveWindow),
            groupReason: this.lastGroupReason,
            energyCost: b && ['continuous','autonomous'].includes(b.execution!) ? Math.min(b.budgets!.pixels, b.budgets!.energy) : targets.length,
            scope: b?.scope ?? null,
            spent: this.used(),
            resources: this.energy(),
            budgets: b?.budgets ?? { pixels: targets.length, energy: targets.length },
            history: [...new Set(this.saved.records.filter((r) => r.batchId === b?.id).map((r) => r.attemptId))]
                .slice(-50)
                .map((id) => {
                    const a = this.d.attempts.get(id)!;
                    return {
                        attemptId: id,
                        state: a.state,
                        pixels: this.saved.records.filter((r) => r.attemptId === id).length,
                        startedAt: a.startedAt ?? null,
                        closedAt: a.closedAt ?? null,
                        accepted: a.state === 'finished' && !('reconciled' in a && a.reconciled),
                        reason: 'reason' in a ? a.reason : null,
                    };
                }),
            acceptedRequests: new Set(
                this.saved.records
                    .filter((r) => r.batchId === b?.id && this.accounted(r) && accepted.has(key(r.write)))
                    .map((r) => r.attemptId)
            ).size,
            targets,
            confirmed: b?.execution === 'autonomous' ? this.saved.records.filter(r=>r.batchId===b.id && this.accounted(r) && accepted.has(key(r.write))).length : targets.filter((t) => t.confirmed).length,
            total: b && ['continuous','autonomous'].includes(b.execution!) ? Math.min(b.budgets!.pixels, b.budgets!.energy) : targets.length,
            error: this.error,
            uncertain: this.d.attempts.open().filter((a) => a.state === 'needs-reconciliation').length,
            expires: b?.execution === 'autonomous' ? null : this.deadline || null,
            untilStopped: b?.execution === 'autonomous',
            completedRegions: this.completedRegions.size,
            regionCount: b?.execution === 'autonomous' ? Math.ceil(b.project.width/256)*Math.ceil(b.project.height/256) : null,
            remainingMs: b?.execution !== 'autonomous' && this.deadline ? Math.max(0,this.deadline-Date.now()) : null,
            commandReady: !!this.pending?.ready && !this.pending.delivered && this.state === 'running',
            scheduler: scheduler?.state ?? null,
            schedulerReason: scheduler?.reason ?? null,
            nextGroup: this.pending && {
                attemptId: this.pending.command.attemptId,
                state: this.pending.delivered ? 'delivered' as const : this.pending.ready ? 'ready' as const : 'reserving' as const,
                pixels: this.pending.command.protocol === 2 ? this.pending.command.pixels : [{
                    gridX: this.pending.command.gridX,
                    gridY: this.pending.command.gridY,
                    color: this.pending.command.color,
                }],
            },
        };
    }
    grant() {
        const b = this.saved.batch;
        if (!b || this.state !== 'running' || this.deadline <= Date.now()) return null;
        const t = this.d.template();
        if (!t) return null;
        const energyReserve = b.scope?.energy?.mode === 'bursts' ? this.energyPlan().reserve : undefined;
        if (energyReserve === null) return null;
        return {
            id: b.id,
            digest: b.digest,
            expires: Math.min(this.deadline, this.saved.batch!.execution === 'autonomous' ? Date.now()+30000 : this.deadline),
            project: b.project,
            ...(b.execution === 'autonomous' ? {execution:'autonomous' as const,budgets:b.budgets!,region:b.scope!.region,groupSize:this.groupLimit(),
                ...(energyReserve !== undefined ? { energyReserve } : {})} : {}),
            ...(b.execution === 'continuous'
                ? { execution: 'continuous' as const, budgets: b.budgets!, region: b.scope!.region }
                : {}),
            ...(b.execution === 'grouped'
                ? { execution: 'grouped' as const }
                : b.execution === 'session'
                  ? { execution: 'session' as const, budgets: b.budgets! }
                  : {}),
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
