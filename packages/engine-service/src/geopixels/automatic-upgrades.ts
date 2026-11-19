import { randomUUID } from 'node:crypto';
import type { ProgressSnapshot } from '@geoplacer/core';
import { check, type BrowserProject } from './protocol.js';
import { SHOP_CATALOG, upgradeProposals, type AutomaticUpgradePolicy } from './upgrade-policy.js';
import type { WriterResources } from './writer-resources.js';
import { assertMetadataHeadroom } from './capacity.js';

type RecordEntry = {
    id: string;
    job: string;
    project: BrowserProject;
    kind: string;
    color: number | null;
    cost: number;
    at: number;
    deadline: number;
    state: 'prepared' | 'delivered' | 'accepted' | 'verified' | 'refused' | 'cancelled' | 'uncertain';
    before: WriterResources;
    closedAt?: number;
};
type Dependencies = {
    save: (v: unknown) => Promise<void>;
    active: () => { job: string; project: BrowserProject; policy: AutomaticUpgradePolicy } | null;
    resources: () => WriterResources | null;
    lock: () => Promise<boolean>;
    unlock: () => void;
    progress: () => Promise<{ progress: ProgressSnapshot; colors: number[] }>;
};
/** Purchase port driven by the existing writer tick, serialized with the SAME paint scheduler.
 * The durable intent precedes delivery. No redelivery or optimistic balance projection. */
export class AutomaticUpgrades {
    private records: RecordEntry[] = [];
    private pending: RecordEntry | null = null;
    private healthy = true;
    private error: string | null = null;
    private proposals: ReturnType<typeof upgradeProposals> = [];
    private proposalJob: string | null = null;
    constructor(private readonly d: Dependencies) {}
    async open(value: unknown) {
        if (value === null) return;
        const v = value as { schema: number; records: RecordEntry[] };
        check(
            v?.schema === 1 &&
                Array.isArray(v.records) &&
                v.records.every(
                    (r) =>
                        typeof r.id === 'string' &&
                        Number.isSafeInteger(r.cost) &&
                        r.cost >= 0 &&
                        ['prepared', 'delivered', 'accepted', 'verified', 'refused', 'cancelled', 'uncertain'].includes(
                            r.state
                        )
                ),
            'invalid upgrade journal'
        );
        this.records = v.records;
        for (const r of this.records) {
            if (r.state === 'prepared') r.state = 'cancelled';
            else if (['delivered', 'accepted'].includes(r.state)) r.state = 'uncertain';
        }
        await this.persist(); // No restored spending permission.
    }
    private async persist() {
        try {
            assertMetadataHeadroom((this.records.length + 1) * 2048);
            await this.d.save({ schema: 1, records: structuredClone(this.records) });
        } catch (e) {
            this.healthy = false;
            this.error =
                'Stockage des améliorations indisponible. Achats suspendus ; conserver le journal avant de redémarrer.';
            throw e;
        }
    }
    private permitted(r: RecordEntry) {
        const a = this.d.active();
        return (
            this.healthy &&
            a?.job === r.job &&
            JSON.stringify(a.project) === JSON.stringify(r.project) &&
            Date.now() < r.deadline
        );
    }
    async tick() {
        if (!this.healthy) return;
        const r = this.pending,
            frame = this.d.resources();
        if (r) {
            if (!this.permitted(r)) {
                r.state = r.state === 'prepared' ? 'cancelled' : 'uncertain';
                r.closedAt = Date.now();
                await this.persist();
                this.pending = null;
                this.d.unlock();
                return;
            }
            if (r.state === 'accepted' && frame?.shop && frame.requestStartedAt > (r.closedAt ?? r.at)) {
                const before = r.before.shop!,
                    after = frame.shop;
                const effect =
                    r.kind === 'energy-pack'
                        ? frame.energy >= r.before.energy + 20
                        : r.kind === 'max-energy'
                          ? after.capacity >= before.capacity + 5
                          : r.kind === 'regen-speed'
                            ? after.intervalMs <= before.intervalMs - 1000
                            : frame.colors.includes(r.color!);
                // A missing effect or unverified debit is ambiguous, never a licence to retry.
                r.state = effect && after.currency === before.currency - r.cost ? 'verified' : 'uncertain';
                await this.persist();
                this.pending = null;
                this.d.unlock();
            }
            return;
        }
        const active = this.d.active();
        if (!active || !frame?.shop || Date.now() - frame.capturedAt > 30000) return;
        const blocked = new Set(this.records.filter((r) => r.state === 'uncertain').map((r) => r.kind));
        const relevant = this.records.filter((r) => r.job === active.job);
        const last = relevant.at(-1);
        if (last && frame.requestStartedAt <= (last.closedAt ?? last.at)) return;
        const { progress, colors } = await this.d.progress();
        const spent = this.usedBudget(active.job);
        this.proposals = upgradeProposals(
            frame.shop,
            frame.available,
            frame.colors,
            colors,
            active.policy,
            spent,
            progress,
            frame.capturedAt
        );
        this.proposalJob = active.job;
        const proposal = this.proposals.find((p) => p.allowed && !blocked.has(p.proposal.kind))?.proposal;
        if (!proposal || !(await this.d.lock())) return;
        if (
            this.d.active()?.job !== active.job ||
            this.d.resources()?.sequence !== frame.sequence ||
            Date.now() - frame.capturedAt > 30000
        ) {
            this.d.unlock();
            return;
        }
        const intent: RecordEntry = {
            id: randomUUID(),
            job: active.job,
            project: active.project,
            kind: proposal.kind,
            color: proposal.color,
            cost: proposal.cost!,
            at: Date.now(),
            deadline: Date.now() + 30000,
            state: 'prepared',
            before: structuredClone(frame),
        };
        this.records.push(intent);
        this.pending = intent;
        try {
            await this.persist();
        } catch (e) {
            this.pending = null;
            this.d.unlock();
            throw e;
        }
    }
    async claim() {
        const r = this.pending;
        if (!r || r.state !== 'prepared' || !this.permitted(r)) return null;
        r.state = 'delivered';
        await this.persist();
        if (!this.permitted(r)) return null;
        return {
            id: r.id,
            project: r.project,
            kind: r.kind,
            color: r.color,
            cost: r.cost,
            catalog: SHOP_CATALOG,
            job: r.job,
            policy: this.d.active()!.policy,
            deadline: r.deadline,
        };
    }
    allowed(id: string) {
        return (
            !!this.pending &&
            this.pending.id === id &&
            this.pending.state === 'delivered' &&
            this.permitted(this.pending)
        );
    }
    async result(id: string, result: 'accepted' | 'not-sent' | 'uncertain') {
        const r = this.pending;
        if (!r || r.id !== id || r.state !== 'delivered') return;
        r.state = !this.permitted(r)
            ? 'uncertain'
            : result === 'accepted'
              ? 'accepted'
              : result === 'not-sent'
                ? 'refused'
                : 'uncertain';
        r.closedAt = Date.now();
        await this.persist();
        if (r.state !== 'accepted') {
            this.pending = null;
            this.d.unlock();
        }
    }
    commandReady(){return this.pending?.state==='prepared' && this.permitted(this.pending);}
    private usedBudget(job: string) {
        return this.records.reduce((total, record) =>
            record.job === job && !['refused', 'cancelled'].includes(record.state) ? total + record.cost : total, 0);
    }
    view(job = this.d.active()?.job ?? null) {
        return {
            error: this.error,
            commandReady: this.commandReady(),
            history: this.records.slice(-30).map(({ id, kind, cost, state, at }) => ({ id, kind, cost, state, at })),
            uncertain: this.records.filter((r) => r.state === 'uncertain').length,
            budgetUsed: job === null ? 0 : this.usedBudget(job),
            proposals: (job === this.proposalJob ? this.proposals : []).map((p) => ({
                kind: p.proposal.kind,
                color: p.proposal.color,
                cost: p.proposal.cost,
                allowed: p.allowed,
                reasons: p.reasons,
            })),
        };
    }
}
