import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { EngineService } from '../src/index.js';
import { BatchMetadataStore } from '../src/geopixels/batch-store.js';
import { cleanup, demoPng, openFast, tempDir } from './helpers.js';
const opened: EngineService[] = [];
afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
    await cleanup();
});
async function wait(fn: () => boolean, progress: () => number = () => 0) {
    let deadline = Date.now() + 10000,
        last = progress();
    while (!fn()) {
        if (progress() !== last) {
            last = progress();
            deadline = Date.now() + 10000;
        }
        if (Date.now() > deadline) throw new Error('drawing stalled');
        await new Promise((r) => setTimeout(r, 10));
    }
}
async function fixture(lost = false, width = 20, height = 20) {
    const dir = await tempDir(),
        { service: s } = await openFast(dir);
    opened.push(s);
    await s.selectSource('geopixels');
    const t = await s.importDrawing({
        name: `Complete ${width} x ${height}`,
        png: await demoPng(width, height, () => 0),
        palette: ['#000000'],
    });
    const exported = await s.exportDrawing(t.templateId),
        decoded = await pngjsCodec.decode(exported.png);
    const project = {
        id: createHash('sha256').update(decoded.rgba).digest('hex'),
        generation: 'filters-v1',
        width,
        height,
        gridX: 1000,
        gridY: 1000,
        layer: 'base',
    };
    let current = s,
        sequence = 0,
        resourceSequence = 0,
        calls = 0,
        respond = !lost;
    const writes: { x: number; y: number; color: number }[] = [],
        pixels = new Array<number>(width * height).fill(-1);
    function observe() {
        current.connector.observe({
            type: 'observation',
            sequence: ++sequence,
            session: 'test-context',
            project,
            capturedAt: Date.now(),
            observedAt: null,
            rect: { x: 1000, y: 1000 - height + 1, width, height },
            pixels: Array.from(
                { length: width * height },
                (_, i) => pixels[(height - 1 - Math.floor(i / width)) * width + (i % width)]!
            ),
            resources: null,
        });
    }
    function captureRegion() {
        const r = current.connector.monitoring.control().region!;
        current.connector.observe({
            type: 'observation',
            sequence: ++sequence,
            session: 'test-context',
            project,
            capturedAt: Date.now(),
            observedAt: null,
            rect: { x: project.gridX + r.x, y: project.gridY - r.y - r.height + 1, width: r.width, height: r.height },
            pixels: Array.from(
                { length: r.width * r.height },
                (_, i) => pixels[(r.y + r.height - 1 - Math.floor(i / r.width)) * width + r.x + (i % r.width)]!
            ),
            resources: null,
            capture: { id: 'region-' + sequence, index: 0, count: 1, region: r },
        });
    }
    function connect(target = s) {
        current = target;
        sequence = 0;
        current.connector.connect('local-fake', (c) => {
            calls++;
            for (const w of c.writes) {
                writes.push({ x: w.gridX, y: w.gridY, color: w.color });
                pixels[(1000 - w.gridY) * width + w.gridX - 1000] = w.color;
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
        current.connector.monitoring.capabilities(true, true);
        observe();
    }
    function energy(n: number) {
        const now = Date.now();
        current.singlePixelWriter.batch.observeResources({
            source: 'native-worker-response',
            sequence: ++resourceSequence,
            requestStartedAt: now,
            capturedAt: now,
            energy: n,
            available: n,
            colors: [0],
        });
    }
    connect();
    return {
        s,
        t,
        dir,
        project,
        writes,
        pixels,
        observe,
        captureRegion,
        connect,
        energy,
        calls: () => calls,
        respond: () => {
            respond = true;
        },
    };
}
describe('Autonomous drawing: same scheduler, explicit whole-image authority', () => {
    it('draws a complete 400-pixel image, stops monitoring, and excludes every ACK against a stale cache', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(400);
        const p = await f.s.previewDrawing(5);
        expect(p).toMatchObject({
            execution: 'autonomous',
            state: 'prepared',
            total: 400,
            untilStopped: true,
            expires: null,
        });
        expect(f.calls()).toBe(0);
        await b.approve(p.id!, p.digest!);
        await wait(
            () => b.view().state === 'completed',
            () => b.view().confirmed
        );
        expect(b.view()).toMatchObject({ confirmed: 400, acceptedRequests: 80, uncertain: 0 });
        expect(f.s.connector.monitoring.control().state).toBe('stopped');
        expect(new Set(f.writes.map((w) => w.x + ',' + w.y)).size).toBe(400);
        expect((await f.s.connectorView()).progress).toMatchObject({ correct: 0, incorrect: 400, unknown: 0 });
        f.observe();
        expect((await f.s.connectorView()).progress).toMatchObject({ correct: 400, incorrect: 0 });
        f.pixels.fill(-1);
        f.observe();
        f.energy(400);
        const next = await f.s.previewDrawing(3);
        await b.approve(next.id!, next.digest!);
        await wait(() => b.view().state === 'completed');
        expect(f.calls()).toBe(80);
    });
    it('draws across three regional views of one 600-pixel model without changing revision or selecting a target twice', async () => {
        const f = await fixture(false, 600, 1),
            b = f.s.singlePixelWriter.batch;
        f.energy(600);
        const p = await f.s.previewDrawing();
        await b.approve(p.id!, p.digest!);
        await wait(
            () => b.view().confirmed === 256,
            () => b.view().confirmed
        );
        f.captureRegion();
        f.captureRegion(); // Commit auto-0, then the requested auto-1.
        await wait(
            () => b.view().confirmed === 512,
            () => b.view().confirmed
        );
        f.captureRegion(); // auto-2 is 88 x 1, still the same image and authority.
        await wait(
            () => b.view().state === 'completed',
            () => b.view().confirmed
        );
        expect(b.view()).toMatchObject({ confirmed: 600, acceptedRequests: 122, uncertain: 0 });
        expect(new Set(f.writes.map((w) => w.x + ',' + w.y)).size).toBe(600);
    });
    it('waits for measured energy, pauses/stops and restores without permission or duplicate targets', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(5);
        const p = await f.s.previewDrawing(5, 20);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 5);
        await new Promise((r) => setTimeout(r, 100));
        expect(f.calls()).toBe(1);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        expect(b.transportRenewable()).toBe(true);
        await b.stop();
        expect(b.transportRenewable()).toBe(false);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        const rb = restored.singlePixelWriter.batch;
        expect(rb.view().commandReady).toBe(false);
        expect(rb.transportRenewable()).toBe(false);
        await new Promise((r) => setTimeout(r, 50));
        expect(f.calls()).toBe(1);
        f.energy(20);
        const next = await restored.previewDrawing(3, 15);
        await rb.approve(next.id!, next.digest!);
        await wait(
            () => rb.view().state === 'completed',
            () => rb.view().confirmed
        );
        expect(f.writes).toHaveLength(20);
        expect(new Set(f.writes.map((w) => w.x + ',' + w.y)).size).toBe(20);
    });
    it('keeps a lost response uncertain across restart; undated pixels cannot clear it or authorize a resend', async () => {
        const f = await fixture(true),
            b = f.s.singlePixelWriter.batch;
        f.energy(400);
        const p = await f.s.previewDrawing();
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        expect(b.view().uncertain).toBeGreaterThan(0);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        f.connect(restored);
        await restored.bindConnector();
        await expect(restored.singlePixelWriter.batch.reconcile()).rejects.toThrow(/freshness/);
        await expect(restored.previewDrawing()).rejects.toThrow();
        expect(f.calls()).toBe(1);
    });
    it('prepares more than 1000 pixels under whole-model authority and waits safely without measured energy', async () => {
        const f = await fixture(false, 40, 40),
            b = f.s.singlePixelWriter.batch,
            p = await f.s.previewDrawing(4, 1500);
        expect(p.total).toBe(1500);
        expect(p.scope?.groupSize).toBe(4);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().scheduler === 'waiting-resources');
        expect(b.transportRenewable()).toBe(true);
        expect(f.calls()).toBe(0);
        await b.stop();
        expect(b.transportRenewable()).toBe(false);
    });
    it('rejects an image mismatch without authorizing anything, and admits a resource-bounded side above 4096', async () => {
        const f = await fixture();
        f.project.id = 'different-image';
        f.observe();
        await expect(f.s.previewDrawing()).rejects.toThrow();
        expect(f.calls()).toBe(0);
        const t = await f.s.importDrawing({ name: 'Wide', png: await demoPng(5000, 2, () => 0), palette: ['#000000'] });
        expect(t.width).toBe(5000);
        expect((await pngjsCodec.decode((await f.s.exportDrawing(t.templateId)).png)).width).toBe(5000);
    });
});
describe('Import after a drawing: preserve receipts, never stop live or uncertain operations', () => {
    const nextImage = async () => ({
        name: 'New imported image',
        png: await demoPng(4, 3, () => 0),
        palette: ['#000000'],
    });
    it('imports after restart with 55 historical ACKs, without a new pairing or losing any confirmation', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        await f.s.bindConnector();
        f.energy(55);
        const p = await b.prepare('fake', 100, 'continuous', 100, {
            region: { x: 0, y: 0, width: 20, height: 20 },
            durationMs: 600000,
        });
        await b.approve(p.id!, p.digest!);
        await wait(
            () => b.view().confirmed === 55,
            () => b.view().confirmed
        );
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.batch.view()).toMatchObject({
            state: 'interrupted',
            confirmed: 55,
            uncertain: 0,
        });
        expect(restored.singlePixelWriter.view()).toMatchObject({ locked: true, open: 0 });
        const before = JSON.parse(await readFile(path.join(f.dir, 'connector-batch.json'), 'utf8'));
        const imported = await restored.importDrawing(await nextImage());
        expect(restored.status().selection?.templateId).toBe(imported.templateId);
        expect(restored.singlePixelWriter.view().locked).toBe(false);
        expect(restored.singlePixelWriter.batch.view()).toMatchObject({
            state: 'stopped',
            confirmed: 55,
            acceptedRequests: 11,
            uncertain: 0,
        });
        expect(restored.singlePixelWriter.batch.transportRenewable()).toBe(false);
        const after = JSON.parse(await readFile(path.join(f.dir, 'connector-batch.json'), 'utf8'));
        expect(after.head).toBe(before.head);
        expect(after.recordCount).toBe(55);
        expect(f.calls()).toBe(11);
    });
    it('retires an unapproved preview before importing, without executing it', async () => {
        const f = await fixture();
        await f.s.previewDrawing();
        expect(f.s.singlePixelWriter.batch.view().state).toBe('prepared');
        const imported = await f.s.importDrawing(await nextImage());
        expect(f.s.status().selection?.templateId).toBe(imported.templateId);
        expect(f.calls()).toBe(0);
    });
    it('refuses import during an authorized paused drawing and preserves its selected model', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(5);
        const p = await f.s.previewDrawing(5, 25);
        await b.approve(p.id!, p.digest!);
        await wait(() => b.view().confirmed === 5);
        await b.pause();
        await wait(() => b.view().scheduler === 'paused');
        await expect(f.s.importDrawing(await nextImage())).rejects.toThrow(/Arrêter le dessin/);
        expect(b.view()).toMatchObject({ state: 'paused', confirmed: 5 });
        expect(f.s.status().selection?.templateId).toBe(f.t.templateId);
        expect(f.calls()).toBe(1);
    });
    it('refuses import while a result is uncertain and keeps the operation blocked', async () => {
        const f = await fixture(true),
            b = f.s.singlePixelWriter.batch;
        f.energy(5);
        const p = await f.s.previewDrawing(5, 5);
        await b.approve(p.id!, p.digest!);
        await wait(() => f.calls() === 1);
        await b.stop();
        await expect(f.s.importDrawing(await nextImage())).rejects.toThrow(/incertaine/);
        expect(b.view().uncertain).toBeGreaterThan(0);
        expect(f.s.status().selection?.templateId).toBe(f.t.templateId);
        expect(f.calls()).toBe(1);
    });
});

describe('Durable confirmation segments without a 4096-record ceiling', () => {
    it('preserves a v1 archive, appends only new records and restores valid orphan segments after a manifest loss', async () => {
        const dir = await tempDir();
        let manifest: unknown = null;
        const records = Array.from({ length: 5000 }, (_, i) => ({ attemptId: 'attempt-' + i, write: { x: i } }));
        const old = { schema: 1, batch: null, records };
        await writeFile(path.join(dir, 'connector-batch.json'), JSON.stringify(old));
        const store = new BatchMetadataStore(dir, async (v) => {
            manifest = v;
        });
        await store.load(old);
        await store.save(old);
        const first = manifest;
        await store.save({ ...old, records: [...records, { attemptId: 'new' }] });
        const names = await readdir(path.join(dir, 'connector-confirmations'));
        expect(names.filter((n) => n.startsWith('segment-'))).toHaveLength(2);
        expect(JSON.parse(await readFile(path.join(dir, 'connector-confirmations', 'legacy-v1.json'), 'utf8'))).toEqual(
            old
        );
        const recovered = (await new BatchMetadataStore(dir, async () => {}).load(first)) as { records: unknown[] };
        expect(recovered.records).toHaveLength(5001);
        const segment = path.join(dir, 'connector-confirmations', 'segment-0000000000000002.json');
        await writeFile(segment, '{}');
        await expect(new BatchMetadataStore(dir, async () => {}).load(manifest)).rejects.toThrow(/chain/);
    });
});
