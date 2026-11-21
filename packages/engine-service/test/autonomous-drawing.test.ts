import { afterEach, describe, expect, it, vi } from 'vitest';
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
describe('Synchronized GeoPixels account palette', () => {
    it('updates new imports from native evidence and keeps saved and manually prepared colors', async () => {
        const { service } = await openFast(await tempDir());
        opened.push(service);
        const batch = service.singlePixelWriter.batch;
        const orange = 0xff9f1c;
        const white = 0xffffff;
        const png = await pngjsCodec.encode({ width: 1, height: 1, rgba: Uint8Array.of(255, 159, 28, 255) });
        const importColor = async (useAccountPalette = true) => {
            const info = await service.importDrawing({ name: 'Orange fixture', png, palette: ['#ffffff'], useAccountPalette });
            const drawn = await service.exportDrawing(info.templateId);
            return { id: info.templateId, rgb: [...(await pngjsCodec.decode(drawn.png)).rgba.slice(0, 3)] };
        };
        const at = Date.now();
        const frame = { source: 'native-worker-response', sequence: 1, requestStartedAt: at, capturedAt: at, energy: 10, available: 10, colors: [orange] };
        service.connector.connect('local-fake', () => undefined);
        batch.observeResources(frame);
        expect(batch.accountPalette().state).toBe('unknown');
        service.connector.connect('read-only', () => undefined);
        batch.observeResources({ ...frame, colors: [white] });
        expect(batch.accountPalette()).toMatchObject({ state: 'fresh', colors: [white], capturedAt: at });
        const saved = await importColor();
        expect(saved.rgb).toEqual([255, 255, 255]);
        const updated = { ...frame, sequence: 2, source: 'native-user-response', capturedAt: Date.now(), colors: [white, orange] };
        batch.observeResources(updated);
        batch.observeResources(frame); // An older response may arrive after the unlock.
        batch.observeResources({ ...updated, colors: [white] }); // Conflicting replay of the same response.
        expect(batch.accountPalette()).toMatchObject({ state: 'fresh', colors: [white, orange], source: 'native-user-response' });
        expect((await importColor()).rgb).toEqual([255, 159, 28]);
        expect((await importColor(false)).rgb).toEqual([255, 255, 255]);
        expect([...(await pngjsCodec.decode((await service.exportDrawing(saved.id)).png)).rgba.slice(0, 3)]).toEqual(saved.rgb);
        const realNow = Date.now;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
        try {
            service.connector.heartbeat();
            expect(batch.accountPalette()).toMatchObject({ state: 'stale', capturedAt: updated.capturedAt });
            expect((await importColor()).rgb).toEqual([255, 255, 255]);
        } finally {
            clock.mockRestore();
        }
        service.connector.disconnect();
        expect(batch.accountPalette()).toEqual({ state: 'unknown', source: null, capturedAt: null, colors: [] });
        expect((await importColor()).rgb).toEqual([255, 255, 255]);
    });
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
    function energy(n: number,shop?:import('../src/geopixels/upgrade-policy.js').ShopObservation) {
        const now = Date.now();
        const frame={
            source: 'native-worker-response',
            sequence: ++resourceSequence,
            requestStartedAt: now,
            capturedAt: now,
            energy: n,
            available: n,
            colors: [0],
            ...(shop?{shop}:{}),
        };
        current.singlePixelWriter.batch.observeResources(frame);return frame;
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
    it('ignores 7 then 1, drains a 200-energy manual burst and waits for 200 again', async () => {
        const f = await fixture(), batch = f.s.singlePixelWriter.batch;
        const threshold = { units: 200, percent: 0 };
        const preview = await f.s.previewDrawing(250, 400, undefined,
            { mode: 'bursts', start: threshold, restart: threshold, reserve: { units: 0, percent: 0 } },
            { mode: 'manual', minimum: 0, allowFinal: false });
        f.energy(7);
        await batch.approve(preview.id!, preview.digest!);
        await wait(() => batch.view().scheduler === 'waiting-resources');
        expect(f.calls()).toBe(0);
        f.energy(1);
        expect(batch.view().adaptiveGroupSize).toBe(0);
        f.energy(200);
        await wait(() => batch.view().confirmed === 200);
        expect(batch.view().history[0]!.pixels).toBe(200);
        await new Promise(r => setTimeout(r, 5));
        f.energy(1);
        await wait(() => batch.view().scheduler === 'waiting-resources');
        expect(batch.view().energyPolicy).toMatchObject({ phase: 'recharge', target: 200 });
        expect(f.calls()).toBe(1);
        f.energy(200);
        await wait(() => batch.view().state === 'completed');
        expect(batch.view().history.map(h => h.pixels)).toEqual([200, 200]);
        expect(new Set(f.writes.map(w => `${w.x},${w.y}`)).size).toBe(400);
    });

    it.each([false,true])('allows a smaller final group only by explicit policy (%s)', async (allowFinal) => {
        const f = await fixture(false, 3, 2), batch = f.s.singlePixelWriter.batch;
        const threshold = { units: 8, percent: 0 };
        const preview = await f.s.previewDrawing(250, 6, undefined,
            { mode: 'bursts', start: threshold, restart: threshold, reserve: { units: 2, percent: 0 } },
            { mode: 'manual', minimum: 8, allowFinal });
        f.energy(8);
        await batch.approve(preview.id!, preview.digest!);
        if (allowFinal) await wait(() => batch.view().state === 'completed');
        else await wait(() => !!batch.view().groupReason?.includes('Minimum 8'));
        expect(batch.view().confirmed).toBe(allowFinal ? 6 : 0);
        expect(f.calls()).toBe(allowFinal ? 1 : 0);
    });

    it('uses two verified upgrades during a burst wait with unlimited game currency and zero reserve', async () => {
        const f = await fixture(), batch = f.s.singlePixelWriter.batch, upgrades = f.s.singlePixelWriter.upgrades;
        const threshold = { units: 200, percent: 0 };
        const policy = { maxBudget: null, minimumReserve: 0, targetCapacity: 0, energyBelow: 0, priority: ['max-energy', 'regen-speed'] as ('max-energy'|'regen-speed')[] };
        const preview = await f.s.previewDrawing(250, 20, policy, { mode: 'bursts', start: threshold, restart: threshold, reserve: { units: 0, percent: 0 } });
        const shop = { catalog: 'geopixels-shop-74783af-v1', currency: 100, capacity: 100, intervalMs: 20_000 };
        f.energy(0, shop);
        await batch.approve(preview.id!, preview.digest!);
        for (let i = 0; i < 2; i++) {
            await wait(() => upgrades.view().commandReady);
            const command = await upgrades.claim();
            expect(command).toMatchObject({ kind: 'max-energy', cost: 50 });
            await upgrades.result(command!.id, 'accepted');
            await new Promise(r => setTimeout(r, 5));
            shop.currency -= 50;
            shop.capacity += 5;
            f.energy(0, shop);
            await wait(() => upgrades.view().history.at(-1)?.state === 'verified');
            await new Promise(r => setTimeout(r, 5));
            f.energy(0, shop);
        }
        expect(upgrades.view(preview.id).budgetUsed).toBe(100);
        expect(upgrades.view().history.map(h => h.state)).toEqual(['verified', 'verified']);
        expect(f.calls()).toBe(0);
    });

    it('seals the saved strategy into the drawing and retains confirmations across modes and restart', async () => {
        const f = await fixture(false, 4, 3), batch = f.s.singlePixelWriter.batch;
        f.energy(12);
        const first = await f.s.previewDrawing(1, 1);
        await batch.approve(first.id!, first.digest!);
        await wait(() => batch.view().state === 'completed');
        expect(f.writes[0]!.y).toBe(f.project.gridY);

        const updated = await f.s.setDrawingStrategy(f.t.templateId, 'bottom-to-top');
        expect(updated).toMatchObject({ strategy: 'bottom-to-top', revision: f.t.revision });
        const preview = await f.s.previewDrawing(1, 1);
        expect(preview.scope?.strategy).toBe('bottom-to-top');
        await batch.approve(preview.id!, preview.digest!);
        await expect(f.s.setDrawingStrategy(f.t.templateId, 'random')).rejects.toThrow(/Arrêter|reconcile/i);
        await wait(() => batch.view().state === 'completed');
        expect(f.writes[1]!.y).toBe(f.project.gridY - 2);
        expect((await f.s.drawingLibrary()).templates.find(t => t.templateId === f.t.templateId)?.receipts).toEqual({ real: 0, fake: 2 });

        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect((await restored.drawingLibrary()).templates.find(t => t.templateId === f.t.templateId)).toMatchObject({
            revision: f.t.revision, strategy: 'bottom-to-top', receipts: { real: 0, fake: 2 },
        });
        expect(restored.singlePixelWriter.batch.view().state).not.toBe('running');
    });

    it('switches away from an inactive preview and removes a model only with its exact name, keeping its files', async () => {
        const f = await fixture();
        const next = await f.s.importTemplate({ name: 'Dessin conservé', png: await demoPng(3, 2, () => 0), x: 0, y: 0, strategy: 'top-to-bottom' });
        await f.s.previewDrawing();
        await expect(f.s.deleteDrawing(f.t.templateId, 'autre nom')).rejects.toThrow(/nom/);
        await f.s.selectTemplate(next.templateId);
        expect(f.s.singlePixelWriter.batch.view().state).toBe('stopped');
        const files = path.join(f.dir, 'projects', 'simulation', 'templates', f.t.templateId);
        await f.s.deleteDrawing(f.t.templateId, f.t.name);
        expect((await f.s.drawingLibrary()).templates.map(t => t.templateId)).toContain(next.templateId);
        expect((await f.s.drawingLibrary()).templates.map(t => t.templateId)).not.toContain(f.t.templateId);
        expect(await readdir(files)).not.toHaveLength(0);
        expect(f.s.settings.selection?.templateId).toBe(next.templateId);
        expect(f.calls()).toBe(0);
    });

    it('draws a complete 400-pixel image, stops monitoring, and excludes every ACK against a stale cache', async () => {
        const f = await fixture(),
            b = f.s.singlePixelWriter.batch;
        f.energy(400);
        const p = await f.s.previewDrawing();
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
        expect(b.view()).toMatchObject({ confirmed: 400, acceptedRequests: 5, uncertain: 0 });
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
        expect(f.calls()).toBe(5);
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
        expect(b.view()).toMatchObject({ confirmed: 600, acceptedRequests: 8, uncertain: 0 });
        expect(new Set(f.writes.map((w) => w.x + ',' + w.y)).size).toBe(600);
    });
    it('reduces a known HTTP 413 refusal, requires NEW resource proof and never redelivers the original attempt',async()=>{
        const f=await fixture(),b=f.s.singlePixelWriter.batch;
        f.s.connector.connect('read-only',()=>{throw new Error('no generic writer');});f.s.connector.monitoring.capabilities(true,true);f.observe();
        const old=f.energy(100),p=await f.s.previewDrawing(100,40);await b.approve(p.id!,p.digest!);
        await wait(()=>b.view().commandReady);const first=b.claim()!;expect(first.protocol===2 && first.pixels.length).toBe(16);
        await b.result(first.attemptId,'rejected-size');expect(b.claim()).toBeNull();b.observeResources(old);expect(b.view().resources).toBeNull();
        await new Promise(r=>setTimeout(r,5));f.energy(100);await wait(()=>b.view().commandReady);const next=b.claim()!;
        expect(next.attemptId).not.toBe(first.attemptId);expect(next.protocol===2 && next.pixels.length).toBe(8);
        await b.result(next.attemptId,'confirmed');expect(b.view().adaptiveGroupSize).toBeLessThanOrEqual(8);await b.stop('test complete');expect(b.view().uncertain).toBe(0);
    });
    it('serializes a budgeted upgrade with the existing scheduler and resumes only on an observed balance',async()=>{
        const f=await fixture(),b=f.s.singlePixelWriter.batch,u=f.s.singlePixelWriter.upgrades;
        const shop={catalog:'geopixels-shop-74783af-v1',currency:100,capacity:100,intervalMs:20000};
        f.energy(0,shop);
        const p=await f.s.previewDrawing(0,20,{maxBudget:10,minimumReserve:50,targetCapacity:100,energyBelow:5,priority:['energy-pack']});
        await b.approve(p.id!,p.digest!);await u.tick();
        expect(u.view().commandReady).toBe(true);expect(f.calls()).toBe(0);
        const c=await u.claim();await u.result(c!.id,'accepted');
        await new Promise(r=>setTimeout(r,5));f.energy(20,{...shop,currency:90});await u.tick();
        expect(u.view().history[0]!.state).toBe('verified');
        await new Promise(r=>setTimeout(r,5));f.energy(20,{...shop,currency:90});
        await wait(()=>b.view().state==='completed',()=>b.view().confirmed);
        expect(b.view().confirmed).toBe(20);expect(u.view().history).toHaveLength(1);
    });
    it.each([1,5,20,100,300])('keeps configurable group size %s below transport and observed energy',async(size)=>{
        const f=await fixture(false,25,1),b=f.s.singlePixelWriter.batch;f.energy(25);
        const p=await f.s.previewDrawing(size);await b.approve(p.id!,p.digest!);
        await wait(()=>b.view().state==='completed',()=>b.view().confirmed);
        expect(b.view().confirmed).toBe(25);expect(b.view().history.every(h=>h.pixels<=size)).toBe(true);
        expect(new Set(f.writes.map(w=>w.x+','+w.y)).size).toBe(25);
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
