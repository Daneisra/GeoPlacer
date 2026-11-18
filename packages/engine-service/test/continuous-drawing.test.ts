import { afterEach, describe, it, expect, vi } from 'vitest';
import { EngineService } from '../src/index.js';
import { cleanup, demoPng, openFast, tempDir } from './helpers.js';
const opened: EngineService[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of opened.splice(0)) await s.close();
    await cleanup();
});
async function wait(fn: () => boolean, progress: () => unknown = () => null) {
    // Same 10 s stall bound; the project's 30 s test limit still bounds total time.
    // A hundred fsynced groups must be judged by forward progress, not a five-pixel smoke deadline.
    let until = Date.now() + 10000, previous = progress();
    while (!fn()) {
        const current = progress();
        if (current !== previous) { previous = current; until = Date.now()+10000; }
        if (Date.now() > until) throw new Error('continuous session did not settle');
        await new Promise((r) => setTimeout(r, 10));
    }
}
async function fixture(real = false, lost = false) {
    const dir = await tempDir(),
        { service: s } = await openFast(dir);
    opened.push(s);
    const t = await s.importTemplate({
        name: 'Continuous 20 x 20',
        png: await demoPng(20, 20, () => 0),
        x: 2,
        y: 3,
        strategy: 'top-to-bottom',
    });
    await s.selectTemplate(t.templateId);
    await s.selectSource('geopixels');
    let current = s,
        sequence = 0,
        calls = 0,
        resourceSequence = 0;
    const writes: { x: number; y: number; color: number }[] = [],
        pixels = new Array<number>(400).fill(-1);
    const project = {
        id: 'continuous-fixture',
        generation: '1',
        width: 20,
        height: 20,
        gridX: 1000,
        gridY: 1000,
        layer: 'base',
    };
    function observe(dated = false) {
        const now = Date.now();
        current.connector.observe({
            type: 'observation',
            sequence: ++sequence,
            session: 'fixture',
            project,
            capturedAt: now,
            observedAt: dated ? now : null,
            rect: { x: project.gridX, y: project.gridY - 19, width: 20, height: 20 },
            pixels: Array.from({ length: 400 }, (_, i) => pixels[(19 - Math.floor(i / 20)) * 20 + (i % 20)]!),
            resources: null,
        });
    }
    function connect(target = s, respond = !lost) {
        current = target;
        sequence = 0;
        current.connector.connect(real ? 'read-only' : 'local-fake', (c) => {
            calls++;
            for (const w of c.writes) {
                writes.push({ x: w.gridX, y: w.gridY, color: w.color });
                pixels[(1000 - w.gridY) * 20 + w.gridX - 1000] = w.color;
            }
            if (respond)
                current.connector.result({
                    type: 'result',
                    id: c.id,
                    attemptId: c.attemptId,
                    session: c.session,
                    outcomes: c.writes.map((w) => ({ taskId: w.taskId, status: 'applied' })),
                });
        });
        observe();
    }
    connect();
    await s.bindConnector();
    function energy(amount: number, extra: object = {}) {
        const now = Date.now();
        const frame = {
            source: 'native-worker-response',
            sequence: ++resourceSequence,
            requestStartedAt: now,
            capturedAt: now,
            energy: amount,
            available: amount,
            colors: [0],
            ...extra,
        };
        current.singlePixelWriter.batch.observeResources(frame);
        return frame;
    }
    async function prepare(
        pixels = 100,
        energyBudget = pixels,
        region = { x: 0, y: 0, width: 20, height: 20 },
        durationMs = 120000
    ) {
        return current.singlePixelWriter.batch.prepare(real ? 'real' : 'fake', pixels, 'continuous', energyBudget, {
            region,
            durationMs,
        });
    }
    return { s, t, dir, project, pixels, writes, observe, connect, energy, prepare, calls: () => calls };
}
describe('Continuous scope through the existing scheduler and durable attempt journal', () => {
    it('draws 300 distinct pixels on a 400-pixel model, groups <=5, never reselects ACKed points from old cache', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(400);
        const p = await f.prepare(300);
        expect(p.targets).toHaveLength(0);
        expect(f.calls()).toBe(0);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().state === 'completed', () => b.view().confirmed);
        expect(b.view()).toMatchObject({ confirmed: 300, total: 300, spent: 300, acceptedRequests: 60, uncertain: 0 });
        expect(f.writes).toHaveLength(300);
        expect(new Set(f.writes.map((w) => `${w.x},${w.y}`)).size).toBe(300);
        expect((await b.observedView()).verification.correct).toBe(0);
        f.observe();
        expect((await b.observedView()).regionProgress).toMatchObject({ correct: 300, incorrect: 100, unknown: 0 });
        f.pixels.fill(-1);
        f.observe();
        await b.stop();
        const next = await f.prepare(100);
        await b.approve(next.id!, next.digest!);
        await wait(() => b.view().state === 'completed', () => b.view().confirmed);
        expect(new Set(f.writes.map((w) => `${w.x},${w.y}`)).size).toBe(400);
    });
    it('waits after exhausting observed energy; only a new post-write native response can replenish it', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            frame = f.energy(5),
            p = await f.prepare(15);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 5 && b.view().scheduler === 'waiting-resources');
        const count = f.calls();
        await new Promise((r) => setTimeout(r, 1100));
        expect(f.calls()).toBe(count);
        b.observeResources({ ...frame, available: 5 });
        expect(b.view().resources?.available).toBe(0);
        b.observeResources({ ...frame, sequence: frame.sequence + 1, energy: 100, available: 100 });
        expect(b.view().resources?.available).toBe(0); // delayed pre-write request
        await new Promise((r) => setTimeout(r, 2));
        f.energy(10);
        await wait(() => b.view().state === 'completed', () => b.view().confirmed);
        expect(b.view().confirmed).toBe(15);
        expect(f.calls()).toBe(3);
    });
    it('authorizes a rectangle, waits when correct/unknown, then plans newly incorrect points dynamically', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.pixels.fill(0);
        f.observe();
        f.energy(100);
        const p = await f.prepare(10, 3, { x: 3, y: 4, width: 4, height: 3 });
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'waiting-observation');
        expect(f.calls()).toBe(0);
        // A previously correct pixel changes, a missing tile stays unknown, outside damage is never eligible.
        f.pixels[4 * 20 + 3] = -1;
        f.pixels[4 * 20 + 4] = -2;
        f.pixels[0] = -1;
        f.observe();
        await wait(() => b.view().confirmed === 1);
        expect(f.writes).toEqual([{ x: 1003, y: 996, color: 0 }]);
        f.pixels[4 * 20 + 3] = -1;
        f.pixels[4 * 20 + 4] = -1;
        f.pixels[5 * 20 + 3] = -1;
        f.observe();
        await wait(() => b.view().state === 'completed', () => b.view().confirmed);
        expect(b.view().confirmed).toBe(3);
        expect(f.writes.filter((w) => w.x === 1003 && w.y === 996)).toHaveLength(1);
        expect(f.writes.some((w) => w.x === 1000 && w.y === 1000)).toBe(false);
    });
    it('pauses, resumes without extending authorization, stops, and restores no authority or energy', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(5);
        const p = await f.prepare(10);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 5 && b.view().scheduler === 'waiting-resources');
        const expires = b.view().expires;
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        f.energy(5);
        await new Promise((r) => setTimeout(r, 40));
        expect(f.calls()).toBe(1);
        b.resume(p.id!, p.digest!);
        expect(b.view().expires).toBe(expires);
        await wait(() => b.view().state === 'completed', () => b.view().confirmed);
        await b.stop();
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.batch.view()).toMatchObject({
            state: 'interrupted',
            expires: null,
            resources: null,
            confirmed: 10,
        });
        f.connect(restored);
        await restored.bindConnector();
        await restored.singlePixelWriter.batch.approve(p.id!, p.digest!);
        await restored.singlePixelWriter.batch.tick();
        expect(restored.singlePixelWriter.batch.view().state).toBe('completed');
        expect(f.calls()).toBe(2);
    });
    it('lost response blocks all later groups, including after restart, with no blind reconciliation from undated cache', async () => {
        const f = await fixture(false, true),
            b = f.s.singlePixelWriter.batch;
        f.energy(100);
        const p = await f.prepare(100);
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        expect(b.view().uncertain).toBe(1);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        await expect(restored.singlePixelWriter.batch.approve(p.id!, p.digest!)).rejects.toThrow();
        await expect(restored.singlePixelWriter.batch.reconcile()).rejects.toThrow(/freshness/);
        expect(f.calls()).toBe(1);
    });
    it.each([0, 1001])('rejects a pixel budget %i', async (n) => {
        const f = await fixture();
        await expect(f.prepare(n)).rejects.toThrow();
    });
    it.each([29999, 600001])('rejects an authorization duration %i', async (n) => {
        const f = await fixture();
        await expect(f.prepare(10, 10, { x: 0, y: 0, width: 20, height: 20 }, n)).rejects.toThrow();
    });
    it('rejects a region outside the model and treats malformed resources as invalid', async () => {
        const f = await fixture();
        await expect(f.prepare(10, 10, { x: 19, y: 0, width: 2, height: 1 })).rejects.toThrow();
        expect(() => f.energy(10, { secret: 'unexpected' })).toThrow(/resources/);
        expect(() => f.energy(-1)).toThrow();
    });
    it('refuses stale evidence, does not extend it on repeated receipts, and stops on model movement or expiry', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        const now = Date.now();
        f.energy(100, { capturedAt: now - 30001, requestStartedAt: now - 30002 });
        const p = await f.prepare(50, 50, undefined, 30000);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'waiting-resources');
        expect(f.calls()).toBe(0);
        const actual = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => actual() + 31000);
        await b.tick();
        expect(b.view()).toMatchObject({ state: 'stopped', expires: null });
    });
    it('stops on channel replacement without issuing the next operation', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        const p = await f.prepare(50);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'waiting-resources');
        f.connect();
        await b.tick();
        expect(b.view().state).toBe('stopped');
        expect(f.calls()).toBe(0);
    });
    it('resumes a partially accepted scope after restart only with new approval and new resource evidence', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(5);
        const p = await f.prepare(15);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 5 && b.view().scheduler === 'waiting-resources');
        await b.stop();
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const resumed = restored.singlePixelWriter.batch;
        expect(resumed.view()).toMatchObject({ confirmed: 5, spent: 5, expires: null, resources: null });
        await resumed.approve(p.id!, p.digest!);
        await wait(() => resumed.view().scheduler === 'waiting-resources');
        expect(f.calls()).toBe(1);
        await new Promise((r) => setTimeout(r, 2));
        f.energy(10);
        await wait(() => resumed.view().state === 'completed');
        expect(resumed.view().confirmed).toBe(15);
        expect(new Set(f.writes.map((w) => `${w.x},${w.y}`)).size).toBe(15);
        expect(f.calls()).toBe(3);
    });
    it('stops when the observed project moves, without moving the authorization rectangle', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch,
            p = await f.prepare(50);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'waiting-resources');
        f.project.gridX++;
        f.observe();
        await b.tick();
        expect(b.view().state).toBe('stopped');
        expect(f.calls()).toBe(0);
    });
    it('counts a reconciled uncertain group conservatively and never selects its targets again in the same authorization', async () => {
        const f = await fixture(false, true),
            b = f.s.singlePixelWriter.batch;
        f.energy(100);
        const p = await f.prepare(10);
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        // A new, explicitly dated local read closes uncertainty; it does not restore permission.
        f.pixels.fill(-1);
        await new Promise((r) => setTimeout(r, 2));
        f.observe(true);
        await b.reconcile();
        expect(b.view()).toMatchObject({ uncertain: 0, expires: null, spent: 5 });
        expect(f.calls()).toBe(1);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored, true);
        await restored.bindConnector();
        await new Promise((r) => setTimeout(r, 2));
        f.energy(100);
        const resumed = restored.singlePixelWriter.batch;
        await resumed.approve(p.id!, p.digest!);
        await wait(() => resumed.view().state === 'completed');
        expect(resumed.view()).toMatchObject({ spent: 10, confirmed: 5, uncertain: 0 });
        const targets = resumed.view().targets;
        expect(targets).toHaveLength(10);
        expect(new Set(targets.map((w) => `${w.x},${w.y}`)).size).toBe(10);
    });
    it('known energy refusal waits safely; a different refusal pauses and an ambiguous result blocks', async () => {
        const f = await fixture(true),
            b = f.s.singlePixelWriter.batch;
        f.energy(100);
        const p = await f.prepare(50);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const c = b.claim()!;
        await b.result(c.attemptId, 'waiting-resources');
        await wait(() => b.view().scheduler === 'waiting-resources');
        expect(b.view()).toMatchObject({ state: 'running', confirmed: 0, uncertain: 0, resources: null });
        await new Promise((r) => setTimeout(r, 2));
        f.energy(100);
        await wait(() => b.view().commandReady);
        const d = b.claim()!;
        await b.result(d.attemptId, 'not-sent');
        await wait(() => b.view().scheduler === 'paused');
        expect(b.view().state).toBe('paused');
        b.resume(p.id!, p.digest!);
        await wait(() => b.view().commandReady);
        const e = b.claim()!;
        await b.result(e.attemptId, 'uncertain');
        expect(b.view().uncertain).toBe(1);
        expect(b.claim.bind(b)).toThrow();
    });
});
