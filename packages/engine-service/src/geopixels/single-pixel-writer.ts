import { randomUUID } from 'node:crypto';
import {
    createAttemptManager,
    createResourceManager,
    createWorkPlanner,
    prepareTemplate,
    type AgentId,
    type AttemptId,
    type ResourceRules,
    type ResourceManager,
    type Template,
} from '@geoplacer/core';
import {
    FileAttemptJournal,
    FileHistoryStore,
    nodeSha256Hasher,
    type DataDirectoryLock,
} from '@geoplacer/adapters-node';
import { check, type BrowserProject } from './protocol.js';
import { nativePoint, type GeoPixelsProvider } from './provider.js';

export type SinglePixelCommand = {
    protocol: 1;
    attemptId: string;
    project: BrowserProject;
    gridX: number;
    gridY: number;
    color: number;
    deadline: number;
};
type Intent = {
    schema: 1;
    attemptId: string;
    identity: string;
    mode: 'fake' | 'real';
    command: SinglePixelCommand;
};
const AGENT = 'single-pixel-authorization' as AgentId;
// Local execution allowance, NOT a report or prediction of GeoPixels account resources.
// Real energy, availability and owned color are checked again inside the browser.
function allowance(template: Template): ResourceRules {
    return {
        schemaVersion: 1,
        id: 'single-pixel-local-allowance',
        version: 1,
        energy: {
            costPerPixel: 1,
            baseCapacity: 1,
            regenAmount: 1,
            regenIntervalMs: Number.MAX_SAFE_INTEGER,
            aboveCapacity: 'cap',
        },
        palette: { initialColors: template.palette.colors.map((c) => c.rgb), unlockable: [] },
        upgrades: {},
        currency: {},
    };
}
const INITIAL: ResourceRules = {
    schemaVersion: 1,
    id: 'single-pixel-local-allowance',
    version: 1,
    energy: {
        costPerPixel: 1,
        baseCapacity: 1,
        regenAmount: 1,
        regenIntervalMs: Number.MAX_SAFE_INTEGER,
        aboveCapacity: 'cap',
    },
    palette: { initialColors: [], unlockable: [] },
    upgrades: {},
    currency: {},
};

/** One-shot coordinator over the shared core planner/journal. No paint loop or retry queue. */
export class SinglePixelWriter {
    private readonly journal: FileAttemptJournal;
    private readonly history: FileHistoryStore;
    private resources = createResourceManager(INITIAL);
    // Stable AttemptManager dependency; a new local allowance replaces resources only with no open attempt.
    private readonly resourcePort = new Proxy({} as ResourceManager, {
        get: (_target, key) => Reflect.get(this.resources, key),
    });
    private readonly attempts;
    private intent: Intent | null = null;
    private epoch = -1;
    private armed = false;
    private durable = false;
    private abort: AbortController | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private closed = false;
    private error: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(
        lock: DataDirectoryLock,
        private readonly provider: GeoPixelsProvider,
        private readonly template: () => Template | null,
        private readonly save: (value: Intent) => Promise<void>,
        private readonly now = Date.now
    ) {
        this.journal = new FileAttemptJournal(lock, { namespace: 'geopixels-writer' });
        this.history = new FileHistoryStore(lock, { namespace: 'geopixels-writer' });
        this.attempts = createAttemptManager({
            journal: this.journal,
            history: this.history,
            resources: this.resourcePort,
            newAttemptId: () => randomUUID() as AttemptId,
        });
    }
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const task = this.queue.then(fn);
        this.queue = task.catch(() => undefined);
        return task;
    }
    async open(saved: unknown): Promise<void> {
        await this.attempts.recover(this.now());
        if (saved !== null) {
            const s = saved as Intent;
            check(
                s.schema === 1 &&
                    typeof s.identity === 'string' &&
                    typeof s.attemptId === 'string' &&
                    ['fake', 'real'].includes(s.mode) &&
                    s.command?.attemptId === s.attemptId,
                'invalid writer intent: preserve file and repair before writing'
            );
            this.intent = s;
        }
        check(this.attempts.open().length === 0 || this.intent !== null, 'missing writer identity; journal preserved');
        // Permission is deliberately not restored. Recovered starts stay uncertain.
        this.timer = setInterval(() => {
            void this.serial(() => this.expire()).catch(() => {
                this.error = 'Journal du placement indisponible ; redémarrer avant toute nouvelle opération.';
            });
        }, 1000);
        this.timer.unref();
    }
    private identity(t: Template): string {
        return JSON.stringify([t.id, t.revision, t.quantizedImageHash, t.placement, this.provider.status().project]);
    }
    private context(reconnect = false): Template {
        const t = this.template();
        check(!this.closed && t !== null, 'select the GeoPixels source and stop the engine first');
        this.provider.assertBinding(t);
        if (this.intent)
            check(
                this.provider.status().mode === (this.intent.mode === 'fake' ? 'local-fake' : 'read-only'),
                'writer provider mode changed; simulated observations cannot reconcile real writes'
            );
        if (this.intent)
            check(
                this.identity(t) === this.intent.identity && (reconnect || this.epoch === this.provider.channelEpoch),
                'writer model, position or session changed'
            );
        return t;
    }
    private async expire(): Promise<void> {
        const open = this.attempts.open()[0];
        if (!open) return;
        try {
            this.context();
        } catch {
            await this.stopNow('Contexte du navigateur modifié ou déconnecté.');
            return;
        }
        if (this.now() >= open.expiresAt) await this.stopNow('Autorisation du pixel expirée.');
    }
    prepare(mode: 'fake' | 'real') {
        return this.serial(async () => {
            check(
                !this.closed && this.attempts.open().length === 0,
                'one operation at a time; reconcile the pending pixel first'
            );
            const t = this.template();
            check(t !== null, 'select GeoPixels and stop the engine first');
            this.provider.assertBinding(t);
            check(
                this.provider.status().mode === (mode === 'fake' ? 'local-fake' : 'read-only'),
                'wrong provider mode'
            );
            this.error = null;
            const p = this.provider.status().project!;
            const window = await this.provider.readWindow({
                minX: t.placement.topLeft.x,
                minY: t.placement.topLeft.y,
                width: t.image.width,
                height: t.image.height,
            });
            const now = this.now();
            const rules = allowance(t);
            this.resources = createResourceManager(rules);
            // No energy regeneration or account currency is inferred on the server.
            const state = this.resources.observe({
                type: 'resource-observation',
                agent: AGENT,
                observedAt: now,
                energy: 1,
                capacity: 1,
                currency: 0,
                unlockedColors: rules.palette.initialColors,
                upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
                availability: { status: 'available' },
            }).state;
            const plan = createWorkPlanner().nextBatch(await prepareTemplate(t, { hasher: nodeSha256Hasher }), {
                agent: AGENT,
                snapshot: window.snapshot,
                resources: state,
                rules,
                maxBatch: 1,
                inFlight: this.attempts.inFlight(),
                committedEnergy: this.attempts.committedEnergy(AGENT),
                unknownPixels: 'skip',
                damageFloor: this.attempts.damage()?.at ?? null,
                now,
            });
            check(
                plan.status === 'ok' && plan.writes.length === 1,
                'no known incorrect paintable pixel; observe and bind first'
            );
            const lease = await this.attempts.lease({
                agent: AGENT,
                projectId: t.projectId,
                templateId: t.id,
                revision: t.revision,
                writes: plan.writes,
                now,
                ttlMs: 30_000,
                evidence: window.snapshot,
            });
            const write = lease.writes[0]!;
            const point = nativePoint(p, write.point.x - t.placement.topLeft.x, write.point.y - t.placement.topLeft.y);
            this.intent = {
                schema: 1,
                attemptId: lease.attemptId,
                identity: this.identity(t),
                mode,
                command: {
                    protocol: 1,
                    attemptId: lease.attemptId,
                    project: p,
                    gridX: point.x,
                    gridY: point.y,
                    color: write.color,
                    deadline: lease.expiresAt,
                },
            };
            this.epoch = this.provider.channelEpoch;
            this.armed = false;
            this.durable = false;
            await this.save(this.intent); // durable destination BEFORE any execution can be authorized
            this.durable = true;
            this.context();
            return this.view();
        });
    }
    confirm(id: string, destination: { gridX: number; gridY: number; color: number }) {
        return this.serial(async () => {
            this.context();
            const i = this.intent;
            check(
                this.durable &&
                    i !== null &&
                    i.attemptId === id &&
                    this.attempts.get(id as AttemptId)?.state === 'leased',
                'pixel not prepared'
            );
            check(
                destination.gridX === i.command.gridX &&
                    destination.gridY === i.command.gridY &&
                    destination.color === i.command.color,
                'explicit destination confirmation required'
            );
            check(this.now() < i.command.deadline, 'authorization expired');
            this.armed = true;
            if (i.mode === 'fake') {
                await this.attempts.start(id as AttemptId, this.now());
                this.armed = false;
                this.abort = new AbortController();
                const a = this.attempts.open()[0]!;
                // Do not hold the control queue while the adapter is waiting: STOP remains immediate.
                void this.provider.writer
                    .applyPixels(AGENT, a.writes, { attemptId: a.attemptId, signal: this.abort.signal })
                    .then((result) =>
                        this.result(
                            id,
                            result.outcomes.every((o) => o.status === 'applied' || o.status === 'already-correct')
                                ? 'confirmed'
                                : 'uncertain'
                        )
                    )
                    .catch(() => this.stop('Réponse factice perdue : réconciliation nécessaire.'));
            }
            return this.view();
        });
    }
    claim() {
        return this.serial(async () => {
            await this.expire();
            if (!this.armed || this.intent?.mode !== 'real') return null;
            this.context();
            this.armed = false;
            await this.attempts.start(this.intent.attemptId as AttemptId, this.now());
            // At-most-once delivery. A lost HTTP reply leaves a durable uncertain intent, never a redelivery.
            return this.intent.command;
        });
    }
    result(id: string, status: 'confirmed' | 'not-sent' | 'uncertain') {
        return this.serial(async () => {
            check(id === this.intent?.attemptId, 'result identity mismatch');
            const a = this.attempts.get(id as AttemptId);
            if (!a || a.state !== 'started') return this.view(); // late/duplicate ACK cannot resurrect a stopped attempt
            try {
                this.context();
            } catch {
                await this.stopNow('Résultat reçu après changement de contexte.');
                return this.view();
            }
            if (status === 'uncertain') await this.stopNow('Résultat ambigu : aucun renvoi autorisé.');
            else if (status === 'not-sent')
                await this.attempts.fail(
                    a.attemptId,
                    'Browser refused before sending',
                    [{ taskId: a.writes[0]!.taskId, status: 'rejected', reason: 'other' }],
                    this.now()
                );
            else
                await this.attempts.finish(
                    a.attemptId,
                    [{ taskId: a.writes[0]!.taskId, status: 'applied' }],
                    this.now()
                );
            return this.view();
        });
    }
    stop(reason = 'Arrêt immédiat demandé.') {
        return this.serial(async () => {
            await this.stopNow(reason);
            return this.view();
        });
    }
    private async stopNow(reason: string) {
        this.armed = false;
        this.abort?.abort();
        this.abort = null;
        const a = this.attempts.open()[0];
        if (a?.state === 'leased') await this.attempts.cancel(a.attemptId, reason, this.now());
        else if (a?.state === 'started') await this.attempts.interrupt(a.attemptId, reason, this.now());
        this.error = reason;
    }
    reconcile() {
        return this.serial(async () => {
            const t = this.context(true);
            const a = this.attempts.open()[0];
            check(a?.state === 'needs-reconciliation', 'no uncertain operation');
            const point = a.writes[0]!.point;
            const w = await this.provider.readWindow({ minX: point.x, minY: point.y, width: 1, height: 1 });
            check(
                w.sourceRange !== null &&
                    !w.sourceUndated &&
                    w.sourceRange.oldest > (a.needsReconciliationAt ?? a.startedAt ?? 0),
                'source freshness unverified: cached colors cannot reconcile a real placement'
            );
            this.provider.assertBinding(t);
            check(this.identity(t) === this.intent!.identity, 'changed reconciliation identity');
            await this.attempts.reconcile(a.attemptId, w.snapshot, this.now());
            this.error = null;
            return this.view();
        });
    }
    view() {
        const a = this.intent ? this.attempts.get(this.intent.attemptId as AttemptId) : undefined;
        return {
            mode: this.intent?.mode ?? null,
            state: a?.state ?? 'idle',
            armed: this.armed,
            destination: this.intent?.command ?? null,
            error: this.error,
            reconciled:
                (a && ('reconciled' in a ? a.reconciled : a.results.some((r) => r.result.startsWith('observed-')))) ||
                false,
            reservationUnits: 'local authorization only; not account energy',
            open: this.attempts.open().length,
        };
    }
    async close() {
        if (this.timer) clearInterval(this.timer);
        this.closed = true;
        await this.stop('Arrêt du serveur : toute exécution commencée reste à réconcilier.');
        await this.journal.close();
        await this.history.close();
    }
}
