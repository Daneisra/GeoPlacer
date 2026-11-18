import { afterEach, describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
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
async function fixture(opts: { real?: boolean; lost?: boolean; refuse?: boolean } = {}) {
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
});
