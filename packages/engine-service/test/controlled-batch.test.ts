import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PixelWrite, WriteOptions, ApplyResult } from '@geoplacer/core';
import { EngineService } from '../src/index.js';
import { cleanup, demoPng, openFast, tempDir } from './helpers.js';
const opened: EngineService[] = [];
afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
    await cleanup();
});
const wait = async (fn: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!fn()) {
        if (Date.now() > end) throw new Error('batch did not settle');
        await new Promise((r) => setTimeout(r, 10));
    }
};
async function fixture(opts: { real?: boolean; lost?: boolean; refuse?: boolean; omit?: number } = {}) {
    const dir = await tempDir(),
        { service: s } = await openFast(dir);
    opened.push(s);
    const t = await s.importTemplate({
        name: 'Controlled batch fixture',
        png: await demoPng(8, 5, () => 0),
        x: 2,
        y: 3,
        strategy: 'top-to-bottom',
    });
    await s.selectTemplate(t.templateId);
    await s.selectSource('geopixels');
    let service = s,
        sequence = 0,
        calls = 0;
    const pixels = new Array<number>(40).fill(-1),
        project = { id: 'batch-ghost', generation: '1', width: 8, height: 5, gridX: 999, gridY: 1001, layer: 'base' };
    const observe = (dated = true) => {
        const now = Date.now();
        return service.connector.observe({
            type: 'observation',
            sequence: ++sequence,
            session: 'fixture-context',
            project,
            capturedAt: now,
            observedAt: dated ? now : null,
            rect: { x: project.gridX, y: project.gridY - 4, width: 8, height: 5 },
            pixels: Array.from({ length: 40 }, (_, i) => pixels[(4 - Math.floor(i / 8)) * 8 + (i % 8)]!),
            resources: null,
        });
    };
    const connect = (target = s) => {
        service = target;
        sequence = 0;
        service.connector.connect(opts.real ? 'read-only' : 'local-fake', (c) => {
            calls++;
            if (opts.refuse) {
                service.connector.result({
                    type: 'result',
                    id: c.id,
                    attemptId: c.attemptId,
                    session: c.session,
                    outcomes: c.writes.map((w) => ({ taskId: w.taskId, status: 'unknown' })),
                });
                return;
            }
            if (calls !== opts.omit)
                for (const w of c.writes) pixels[(project.gridY - w.gridY) * 8 + w.gridX - project.gridX] = w.color;
            if (!opts.lost)
                service.connector.result({
                    type: 'result',
                    id: c.id,
                    attemptId: c.attemptId,
                    session: c.session,
                    outcomes: c.writes.map((w) => ({ taskId: w.taskId, status: 'applied' })),
                });
        });
        observe();
    };
    connect();
    await s.bindConnector();
    return { s, t, dir, project, pixels, observe, connect, calls: () => calls };
}
describe('Bounded work through the existing TaskScheduler', () => {
    it('executes five unique targets with a stale cache, journals each and keeps observed progress independent', async () => {
        const f = await fixture(),
            batch = f.s.singlePixelWriter.batch;
        const preview = await batch.prepare('fake', 5);
        expect(preview.total).toBe(5);
        expect(f.calls()).toBe(0);
        await expect(batch.approve(preview.id!, '0'.repeat(64))).rejects.toThrow(/identity/);
        await batch.approve(preview.id!, preview.digest!);
        await wait(() => batch.view().state === 'completed');
        expect(batch.view()).toMatchObject({ confirmed: 5, uncertain: 0, total: 5 });
        expect(f.calls()).toBe(5);
        expect((await f.s.connectorView()).progress).toMatchObject({ correct: 0, incorrect: 40 });
        f.observe();
        expect((await f.s.connectorView()).progress!.correct).toBe(5);
        // Even after an old bitmap is captured again, confirmations exclude these exact targets.
        f.pixels.fill(-1);
        f.observe(false);
        const next = await batch.prepare('fake', 5);
        expect(next.targets.some((n) => preview.targets.some((p) => p.x === n.x && p.y === n.y))).toBe(false);
    });
    it('pauses between operations and resumes only the same authorized scope', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 1);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        const count = f.calls();
        await new Promise((r) => setTimeout(r, 1100));
        expect(f.calls()).toBe(count);
        await expect(b.approve(p.id!, p.digest!)).rejects.toThrow();
        b.resume(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        expect(f.calls()).toBe(5);
    });
    it('stops on a lost result, never replays the uncertain operation, and restores without permission', async () => {
        const f = await fixture({ lost: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        expect(b.view().uncertain).toBe(1);
        expect(f.calls()).toBe(1);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.batch.view()).toMatchObject({
            expires: null,
            uncertain: 1,
            commandReady: false,
        });
        f.connect(restored);
        await restored.bindConnector();
        f.observe(false);
        await expect(restored.singlePixelWriter.batch.reconcile()).rejects.toThrow(/freshness/);
        await expect(restored.singlePixelWriter.batch.approve(p.id!, p.digest!)).rejects.toThrow();
        expect(f.calls()).toBe(1);
    });
    it('delivers an HTTP command only once and pauses on a known refusal before send', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const command = b.claim()!;
        expect(b.claim()).toBe(null);
        expect(b.allowed(command.attemptId)).toBe(true);
        await b.result(command.attemptId, 'not-sent');
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 0, state: 'paused' });
        expect(f.calls()).toBe(0);
    });
    it('retains confirmed targets across restart, then reauthorizes only the remaining lot', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 1);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        await b.stop();
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const next = restored.singlePixelWriter.batch;
        expect(next.view().expires).toBe(null);
        await next.approve(p.id!, p.digest!);
        await wait(() => next.view().state === 'completed');
        expect(f.calls()).toBe(5);
    });
    it('rejects out-of-bound sizes and stops before delivery after a project move', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch;
        await expect(b.prepare('real', 6)).rejects.toThrow();
        const p = await b.prepare('real', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        f.s.connector.disconnect('moved');
        await b.tick();
        expect(b.view().commandReady).toBe(false);
        expect(f.calls()).toBe(0);
    });
    it('leaves a lost claim uncertain and ignores late confirmations after stop', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        expect(b.claim()).toBeNull();
        await b.stop();
        expect(b.allowed(c.attemptId)).toBe(false);
        await b.result(c.attemptId, 'confirmed');
        expect(b.view()).toMatchObject({ uncertain: 1, confirmed: 0, commandReady: false });
        await expect(b.prepare('real', 5)).rejects.toThrow();
    });
    it('completes an already delivered response during pause, but sends no next operation', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        await b.pause();
        expect(b.allowed(c.attemptId)).toBe(false);
        await b.result(c.attemptId, 'confirmed');
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view()).toMatchObject({ confirmed: 1, uncertain: 0, commandReady: false });
    });
    it('revokes the grant at its absolute deadline, without accepting a late result or renewing on resume', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        const expires = b.view().expires!,
            clock = vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
        try {
            await b.tick();
            expect(b.allowed(c.attemptId)).toBe(false);
            await b.result(c.attemptId, 'confirmed');
            expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 1, expires: null });
            expect(() => b.resume(p.id!, p.digest!)).toThrow();
        } finally {
            clock.mockRestore();
        }
    });
    it('cancels before delivery when the cache expires while preparing an operation', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
        try {
            await b.approve(p.id!, p.digest!);
            await new Promise((r) => setTimeout(r, 60));
            expect(b.view().commandReady).toBe(false);
            expect(b.view().confirmed).toBe(0);
        } finally {
            clock.mockRestore();
            await b.stop();
        }
    });
    it('fails closed if confirmation metadata is lost, rather than replanning journaled targets', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 1);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        await rm(path.join(f.dir, 'connector-batch.json'));
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        await expect(restored.singlePixelWriter.batch.prepare('fake', 5)).rejects.toThrow(/archive incomplete/);
        expect(f.calls()).toBe(1);
    });
    it('never counts fake confirmations as real confirmations for the same model and coordinates', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 1);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        f.s.connector.disconnect('switch to passive channel');
        f.s.connector.connect('read-only', () => {});
        f.pixels.fill(-1);
        f.observe();
        await f.s.bindConnector();
        const actual = await b.prepare('real', 1);
        expect(actual.targets[0]).toMatchObject({ x: p.targets[0]!.x, y: p.targets[0]!.y, confirmed: false });
        expect(actual.mode).toBe('real');
        expect(actual.confirmed).toBe(0);
    });
    it('imports the confirmed 2F intent under its original identity even after a ghost move', async () => {
        const f = await fixture(),
            single = f.s.singlePixelWriter,
            c = (await single.prepare('fake')).destination!;
        await single.confirm(c.attemptId, c);
        await wait(() => single.view().state === 'finished');
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        await rm(path.join(f.dir, 'connector-batch.json')); // A genuine 2F installation has only its old intent and journal.
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.project.gridX += 10;
        f.pixels.fill(-1);
        f.connect(restored);
        await restored.bindConnector();
        const next = await restored.singlePixelWriter.batch.prepare('fake', 1);
        expect(next.targets[0]!.x).toBe(c.gridX + 10);
        expect(next.confirmed).toBe(0);
    });
    it('reports four observed matches despite five ACKs, without retrying the missing target', async () => {
        const f = await fixture({ omit: 3 }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        const before = (await f.s.connectorView()).batch;
        expect(before.confirmed).toBe(5);
        expect(before.verification).toMatchObject({ correct: 0, different: 0, pending: 5 });
        await new Promise((r) => setTimeout(r, 2));
        f.observe(false);
        const after = (await f.s.connectorView()).batch;
        expect(after.confirmed).toBe(5);
        expect(after.verification).toEqual({
            correct: 4,
            different: 1,
            pending: 0,
            unknown: 0,
            sourceUnverified: true,
        });
        expect(after.targets.filter((t) => t.observation === 'different')).toHaveLength(1);
        expect(after.targets.find((t) => t.observation === 'different')!.observedColor).toBe(-1);
        expect((await f.s.connectorView()).progress!.correct).toBe(4);
        expect(f.calls()).toBe(5);
        const next = await b.prepare('fake', 5);
        expect(next.targets.some((n) => p.targets.some((old) => old.x === n.x && old.y === n.y))).toBe(false);
        expect(f.calls()).toBe(5);
    });
    it('leaves per-target verification unknown on expired captures or a disconnected channel', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 1);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        await new Promise((r) => setTimeout(r, 2));
        f.observe();
        expect((await b.observedView()).verification.correct).toBe(1);
        const future = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
        try {
            expect((await b.observedView()).verification).toMatchObject({ correct: 0, unknown: 1 });
        } finally {
            future.mockRestore();
        }
        f.s.connector.disconnect('test');
        expect((await b.observedView()).verification).toMatchObject({ correct: 0, unknown: 1 });
    });
    it('compares five-target native grouping with sequential execution using the same scheduler and planner', async () => {
        const grouped = await fixture(),
            g = grouped.s.singlePixelWriter.batch,
            p = await g.prepare('fake', 5, 'grouped');
        expect(p.energyCost).toBe(5);
        await g.approve(p.id!, p.digest!);
        await wait(() => g.view().state === 'completed');
        expect(grouped.calls()).toBe(1);
        expect(g.view()).toMatchObject({ confirmed: 5, acceptedRequests: 1, execution: 'grouped' });
        const seq = await fixture(),
            s = seq.s.singlePixelWriter.batch,
            q = await s.prepare('fake', 5, 'sequential');
        await s.approve(q.id!, q.digest!);
        await wait(() => s.view().state === 'completed');
        expect(seq.calls()).toBe(5);
        expect(s.view().acceptedRequests).toBe(5);
        grouped.observe();
        seq.observe();
        expect((await grouped.s.connectorView()).progress!.correct).toBe(
            (await seq.s.connectorView()).progress!.correct
        );
    });
    it('journals all group targets before one-shot delivery, then separates global acceptance from partial observation', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5, 'grouped');
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const stored = JSON.parse(await readFile(path.join(f.dir, 'connector-batch.json'), 'utf8'));
        expect(stored.records).toHaveLength(5);
        expect(new Set(stored.records.map((r: { attemptId: string }) => r.attemptId)).size).toBe(1);
        expect(await readFile(path.join(f.dir, 'providers/geopixels-writer/journal/attempts.log'), 'utf8')).toContain(
            'started'
        );
        const c = b.claim()!;
        expect(c.protocol).toBe(2);
        if (c.protocol !== 2) throw new Error('expected group');
        expect(c.pixels).toHaveLength(5);
        expect(b.claim()).toBeNull();
        await b.result(c.attemptId, 'confirmed');
        await wait(() => b.view().state === 'completed');
        expect(b.view()).toMatchObject({ confirmed: 5, acceptedRequests: 1, uncertain: 0 });
        for (const w of c.pixels.slice(0, 4))
            f.pixels[(f.project.gridY - w.gridY) * 8 + w.gridX - f.project.gridX] = w.color;
        await new Promise((r) => setTimeout(r, 2));
        f.observe(false);
        expect((await b.observedView()).verification).toMatchObject({
            correct: 4,
            different: 1,
            sourceUnverified: true,
        });
        expect(f.calls()).toBe(0);
    });
    it('blocks all five targets after a lost group reply, including restart and attempted sequential fallback', async () => {
        const f = await fixture({ lost: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5, 'grouped');
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        expect(b.view().targets.every((t) => t.state === 'needs-reconciliation')).toBe(true);
        await expect(b.prepare('fake', 5, 'sequential')).rejects.toThrow();
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const recovered = restored.singlePixelWriter.batch;
        expect(recovered.view()).toMatchObject({ expires: null, uncertain: 1, commandReady: false });
        expect(recovered.view().targets.every((t) => t.state === 'needs-reconciliation')).toBe(true);
        f.observe(false);
        await expect(recovered.reconcile()).rejects.toThrow(/freshness/);
        await expect(recovered.approve(p.id!, p.digest!)).rejects.toThrow();
        expect(f.calls()).toBe(1);
    });
    it('cancels an undelivered group during pause, then explicitly resumes without duplicate dispatch', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 5, 'grouped');
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 0, commandReady: false });
        b.resume(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        await b.result(c.attemptId, 'not-sent');
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view().targets.every((t) => t.state === 'failed')).toBe(true);
        expect(b.view().acceptedRequests).toBe(0);
    });
    it('refuses oversized or invalid execution modes and an incomplete group before delivery', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch;
        for (const n of [0, 6, 1.5]) await expect(b.prepare('real', n, 'grouped')).rejects.toThrow();
        await expect(b.prepare('real', 5, 'unsafe' as 'grouped')).rejects.toThrow();
        const p = await b.prepare('real', 5, 'grouped');
        f.pixels[0] = 0;
        f.observe();
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'blocked');
        expect(b.view()).toMatchObject({ uncertain: 0, confirmed: 0, commandReady: false });
        expect(f.calls()).toBe(0);
    });
    it('preserves 2G archives without an execution field as sequential with no restored authorization', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        await b.prepare('fake', 1);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const filename = path.join(f.dir, 'connector-batch.json'),
            saved = JSON.parse(await readFile(filename, 'utf8')),
            a = saved.batch;
        delete a.execution;
        a.digest = createHash('sha256')
            .update(JSON.stringify([a.id, a.identity, a.mode, a.project, a.origin, a.writes]))
            .digest('hex');
        await writeFile(filename, JSON.stringify(saved));
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.batch.view()).toMatchObject({
            execution: 'sequential',
            expires: null,
            commandReady: false,
        });
    });
    it('restores a prepared native group without permission, then executes only after a fresh explicit approval', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5, 'grouped');
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const next = restored.singlePixelWriter.batch;
        expect(next.view()).toMatchObject({ execution: 'grouped', expires: null, confirmed: 0, commandReady: false });
        expect(f.calls()).toBe(0);
        await next.approve(p.id!, p.digest!);
        await wait(() => next.view().state === 'completed');
        expect(f.calls()).toBe(1);
    });
    it('honors a pause arriving after durable start but before dispatch without inventing an uncertain send', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5);
        const port = b as unknown as { dispatch: (w: readonly PixelWrite[], o: WriteOptions) => Promise<ApplyResult> };
        const original = port.dispatch.bind(port);
        vi.spyOn(port, 'dispatch').mockImplementationOnce(async (w, o) => {
            await b.pause();
            return original(w, o);
        });
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view()).toMatchObject({ uncertain: 0, confirmed: 0 });
        expect(f.calls()).toBe(0);
        b.resume(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        expect(f.calls()).toBe(5);
    });
    it('requires dated post-interruption coverage of EVERY target before reconciling an uncertain group', async () => {
        const f = await fixture({ lost: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 5, 'grouped');
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        const missing = (p.targets[4]!.y - f.project.gridY) * -8 + p.targets[4]!.x - f.project.gridX;
        f.pixels[missing] = -2;
        await new Promise((r) => setTimeout(r, 2));
        f.observe();
        await expect(b.reconcile()).rejects.toThrow(/freshness/);
        expect(b.view().uncertain).toBe(1);
        expect(b.view().targets.every((t) => t.state === 'needs-reconciliation')).toBe(true);
        f.pixels[missing] = 0;
        await new Promise((r) => setTimeout(r, 2));
        f.observe();
        await b.reconcile();
        expect(b.view()).toMatchObject({ uncertain: 0, acceptedRequests: 0, confirmed: 0 });
        expect(b.view().targets.every((t) => t.state === 'finished')).toBe(true);
        expect(f.calls()).toBe(1);
    });
    it('runs exactly 25 distinct authorized targets in five native groups and keeps an old cache from reselecting them', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 25, 'session', 25);
        expect(p).toMatchObject({
            total: 25,
            energyCost: 25,
            budgets: { pixels: 25, energy: 25 },
            execution: 'session',
        });
        expect(f.calls()).toBe(0);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        expect(b.view()).toMatchObject({ confirmed: 25, acceptedRequests: 5, uncertain: 0 });
        expect(f.calls()).toBe(5);
        expect(f.pixels.filter((c) => c === 0)).toHaveLength(25);
        expect(
            b
                .view()
                .history.filter((h) => h.accepted)
                .map((h) => h.pixels)
        ).toEqual([5, 5, 5, 5, 5]);
        expect((await f.s.connectorView()).progress!.correct).toBe(0);
        const next = await b.prepare('fake', 25, 'session', 25);
        expect(next.total).toBe(15);
        expect(next.targets.some((n) => p.targets.some((old) => old.x === n.x && old.y === n.y))).toBe(false);
    });
    it('seals both budgets before authorization and uses a smaller final group without exceeding energy', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        for (const [n, e] of [
            [26, 25],
            [25, 26],
            [25, 0],
            [0, 25],
        ])
            await expect(b.prepare('fake', n!, 'session', e!)).rejects.toThrow();
        await expect(b.prepare('fake', 25, 'session')).rejects.toThrow();
        const p = await b.prepare('fake', 25, 'session', 12);
        expect(p).toMatchObject({ total: 12, energyCost: 12, budgets: { pixels: 25, energy: 12 } });
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed');
        expect(f.calls()).toBe(3);
        expect(
            b
                .view()
                .history.filter((h) => h.accepted)
                .map((h) => h.pixels)
        ).toEqual([5, 5, 2]);
        expect(b.view().confirmed).toBe(12);
    });
    it('pauses after two groups, restores history without permission and explicitly resumes only the remaining 15 targets', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 25, 'session', 25);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 10);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        const calls = f.calls();
        await new Promise((r) => setTimeout(r, 1100));
        expect(f.calls()).toBe(calls);
        await b.stop();
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const next = restored.singlePixelWriter.batch;
        expect(next.view()).toMatchObject({ execution: 'session', expires: null, confirmed: 10, commandReady: false });
        expect(f.calls()).toBe(2);
        await next.approve(p.id!, p.digest!);
        await wait(() => next.view().state === 'completed');
        expect(f.calls()).toBe(5);
        expect(next.view()).toMatchObject({ confirmed: 25, acceptedRequests: 5 });
        expect(f.pixels.filter((c) => c === 0)).toHaveLength(25);
    });
    it('stops the whole session on an ambiguous group, rejects fallback and ignores a late result', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 25, 'session', 25);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        expect(c.protocol).toBe(2);
        expect(b.grant()?.writes).toHaveLength(25);
        await b.result(c.attemptId, 'uncertain');
        await b.result(c.attemptId, 'confirmed');
        expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 1, commandReady: false, expires: null });
        expect(b.view().targets.filter((t) => t.state === 'needs-reconciliation')).toHaveLength(5);
        await expect(b.prepare('real', 5, 'sequential')).rejects.toThrow();
        expect(f.calls()).toBe(0);
    });
    it('can resume after a known energy refusal, but never extends the absolute authorization', async () => {
        const f = await fixture({ real: true }),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('real', 25, 'session', 25);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const expires = b.view().expires!,
            c = b.claim()!;
        await b.result(c.attemptId, 'not-sent');
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 0 });
        b.resume(p.id!, p.digest!);
        expect(b.view().expires).toBe(expires);
        await wait(() => b.view().commandReady);
        const time = vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
        try {
            await b.tick();
            expect(b.view()).toMatchObject({ expires: null, commandReady: false, confirmed: 0 });
        } finally {
            time.mockRestore();
        }
    });
    it('stops a session after durable start but before publication without claiming an uncertain send', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await b.prepare('fake', 25, 'session', 25);
        const port = b as unknown as { dispatch: (w: readonly PixelWrite[], o: WriteOptions) => Promise<ApplyResult> };
        const original = port.dispatch.bind(port);
        let stopped: Promise<unknown> | null = null;
        vi.spyOn(port, 'dispatch').mockImplementationOnce((w, o) => {
            stopped = b.stop();
            return original(w, o);
        });
        await b.approve(p.id!, p.digest!);
        await wait(() => stopped !== null);
        await stopped;
        expect(b.view()).toMatchObject({ confirmed: 0, uncertain: 0, state: 'stopped', commandReady: false });
        expect(f.calls()).toBe(0);
    });
});
