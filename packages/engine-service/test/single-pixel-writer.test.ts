import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EngineService, ConnectorHttpChannel, verifyBackup, restoreBackup } from '../src/index.js';
import { cleanup, demoPng, openFast, tempDir, waitFor } from './helpers.js';

const opened: EngineService[] = [];
afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
    await cleanup();
});
async function setup(real = false, lost = false) {
    const dir = await tempDir();
    const backupDir = await tempDir('gp-single-pixel-backups-');
    const { service: s } = await openFast(dir, { backupDir });
    opened.push(s);
    const t = await s.importTemplate({
        name: 'One pixel contract fixture',
        png: await demoPng(3, 2, () => 0),
        x: 2,
        y: 3,
        strategy: 'top-to-bottom',
    });
    await s.selectTemplate(t.templateId);
    await s.selectSource('geopixels');
    const key = 'a'.repeat(64);
    let service = s,
        sequence = 0,
        commands = 0;
    const project = {
        id: 'single-pixel-ghost',
        generation: '1',
        width: 3,
        height: 2,
        gridX: -1001,
        gridY: 1001,
        layer: 'base',
    };
    const pixels = new Array<number>(6).fill(-1);
    let dated = true;
    function observe() {
        const now = Date.now();
        service.connector.observe({
            type: 'observation',
            sequence: ++sequence,
            session: 'synthetic-context',
            project,
            capturedAt: now,
            observedAt: dated ? now : null,
            rect: { x: -1001, y: 1000, width: 3, height: 2 },
            pixels: [...pixels.slice(3), ...pixels.slice(0, 3)],
            resources: null,
        });
    }
    function connect(target = s) {
        service = target;
        sequence = 0;
        service.connector.connect(real ? 'read-only' : 'local-fake', (c) => {
            commands++;
            const w = c.writes[0]!;
            pixels[(project.gridY - w.gridY) * 3 + w.gridX - project.gridX] = w.color;
            if (!lost)
                service.connector.result({
                    type: 'result',
                    id: c.id,
                    attemptId: c.attemptId,
                    session: c.session,
                    outcomes: [{ taskId: w.taskId, status: 'applied' }],
                });
        });
        observe();
    }
    connect();
    await s.bindConnector();
    return {
        s,
        dir,
        backupDir,
        t,
        key,
        project,
        pixels,
        observe,
        connect,
        commands: () => commands,
        undated: () => {
            dated = false;
            observe();
        },
    };
}
async function prepared(s: EngineService, mode: 'fake' | 'real' = 'fake') {
    const v = await s.singlePixelWriter.prepare(mode);
    expect(v.state).toBe('leased');
    expect(v.open).toBe(1);
    return v.destination!;
}
describe('Single-operation writer through existing core planner and durable attempts', () => {
    it('plans exactly one pixel, executes on fake provider and measures progress independently', async () => {
        const f = await setup();
        const c = await prepared(f.s);
        expect(c).toMatchObject({ gridX: -1001, gridY: 1001 }); // Y-down local -> native Y-up
        await f.s.singlePixelWriter.confirm(c.attemptId, c);
        await waitFor(f.s, () => f.s.singlePixelWriter.view().state === 'finished');
        expect(f.commands()).toBe(1);
        f.observe();
        expect((await f.s.connectorView()).progress).toMatchObject({ correct: 1, incorrect: 5, unknown: 0 });
        const journal = await readFile(path.join(f.dir, 'providers/geopixels-writer/journal/attempts.log'), 'utf8');
        expect(journal.indexOf('started')).toBeLessThan(journal.indexOf('finished'));
    });
    it('refuses concurrent preparation, wrong destination and scheduler start; cancels before dispatch', async () => {
        const f = await setup();
        const c = await prepared(f.s);
        await expect(f.s.singlePixelWriter.prepare('fake')).rejects.toThrow(/one operation/);
        await expect(f.s.singlePixelWriter.confirm(c.attemptId, { ...c, gridY: c.gridY + 1 })).rejects.toThrow(
            /destination/
        );
        await expect(f.s.start()).rejects.toThrow(/single pixel/);
        await expect(f.s.moveTemplate(f.t.templateId, 5, 6)).rejects.toThrow(/single pixel/);
        await f.s.singlePixelWriter.stop();
        expect(f.s.singlePixelWriter.view().state).toBe('cancelled');
        expect(f.commands()).toBe(0);
    });
    it('keeps a lost result reserved across stop/restart and reconciles only from a later dated read', async () => {
        const f = await setup(false, true);
        const c = await prepared(f.s);
        await f.s.singlePixelWriter.confirm(c.attemptId, c);
        await f.s.singlePixelWriter.stop();
        expect(f.s.singlePixelWriter.view().state).toBe('needs-reconciliation');
        expect(f.commands()).toBe(1);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.view()).toMatchObject({ state: 'needs-reconciliation', armed: false });
        await expect(restored.singlePixelWriter.prepare('fake')).rejects.toThrow(/reconcile/);
        f.connect(restored);
        await restored.bindConnector();
        f.undated();
        await expect(restored.singlePixelWriter.reconcile()).rejects.toThrow(/source freshness/);
        // A fixture can provide a genuinely dated fresh read; a real undated cache cannot.
        await new Promise((r) => setTimeout(r, 5));
        restored.connector.observe({
            type: 'observation',
            sequence: 3,
            session: 'synthetic-context',
            project: f.project,
            capturedAt: Date.now(),
            observedAt: Date.now(),
            rect: { x: -1001, y: 1001, width: 1, height: 1 },
            pixels: [c.color],
            resources: null,
        });
        await restored.singlePixelWriter.reconcile();
        expect(restored.singlePixelWriter.view().open).toBe(0);
        expect(f.commands()).toBe(1);
        expect((await restored.connectorView()).progress!.correct).toBe(1);
    });
    it('cancels a prepared operation on restart without restoring authorization', async () => {
        const f = await setup();
        await prepared(f.s);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.view()).toMatchObject({ state: 'cancelled', armed: false, open: 0 });
        expect(f.commands()).toBe(0);
    });
    it('recovers a durably started command after a process exits without shutdown', async () => {
        const f = await setup(true);
        await f.s.close();
        opened.splice(opened.indexOf(f.s), 1);
        const child = spawnSync(
            process.execPath,
            [fileURLToPath(new URL('./fixtures/single-pixel-crash.mjs', import.meta.url)), f.dir],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        );
        expect({ status: child.status, error: child.stderr }).toEqual({ status: 0, error: '' });
        const restored = await EngineService.open({ dataDir: f.dir });
        opened.push(restored);
        expect(restored.singlePixelWriter.view()).toMatchObject({
            state: 'needs-reconciliation',
            armed: false,
            open: 1,
        });
        expect(await restored.singlePixelWriter.claim()).toBe(null);
        await expect(restored.singlePixelWriter.prepare('real')).rejects.toThrow(/reconcile/);
    });
    it('withdraws the write grant before backup and restores the isolated journal and intent', async () => {
        const f = await setup();
        await prepared(f.s);
        const saved = await f.s.backup();
        expect(f.s.singlePixelWriter.view().state).toBe('cancelled');
        const backup = path.join(f.backupDir, saved.name);
        const manifest = await verifyBackup(backup);
        expect(manifest.files.some((file) => file.path.startsWith('providers/geopixels-writer/journal/'))).toBe(true);
        expect(manifest.files.some((file) => file.path === 'connector-writer-intent.json')).toBe(true);
        const target = path.join(await tempDir(), 'restored');
        await restoreBackup(backup, target);
        const restored = await EngineService.open({ dataDir: target });
        opened.push(restored);
        expect(restored.singlePixelWriter.view()).toMatchObject({ state: 'cancelled', armed: false, open: 0 });
    });
    it.each([false, true])('expires a single grant without renewal (dispatched=%s)', async (started) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const f = await setup(true);
            const c = await prepared(f.s, 'real');
            await f.s.singlePixelWriter.confirm(c.attemptId, c);
            if (started) await f.s.singlePixelWriter.claim();
            vi.setSystemTime(c.deadline + 1);
            f.s.connector.heartbeat();
            expect(await f.s.singlePixelWriter.claim()).toBe(null);
            expect(f.s.singlePixelWriter.view().state).toBe(started ? 'needs-reconciliation' : 'cancelled');
        } finally {
            vi.useRealTimers();
        }
    });
    it('does not classify an unknown pixel as a placement candidate', async () => {
        const f = await setup();
        f.pixels.fill(-2);
        f.observe();
        await expect(f.s.singlePixelWriter.prepare('fake')).rejects.toThrow(/no known incorrect/);
    });
    it('isolates the live HTTP operation, delivers it once, refuses stale approval and ignores late success after stop', async () => {
        const f = await setup(true);
        const http = new ConnectorHttpChannel(f.s.pairing, f.s.connector, f.key, Date.now, f.s.singlePixelWriter);
        const origin = 'https://geopixels.net';
        const issued = http.issue(f.key, origin);
        const paired = http.claim(origin, issued.token);
        expect(() => http.claimPixel(paired.capability)).toThrow(/approved/);
        http.approve(f.key, paired.requestId);
        f.observe();
        await f.s.bindConnector();
        f.undated();
        const c = await prepared(f.s, 'real');
        expect(await http.claimPixel(paired.capability)).toBe(null);
        await f.s.singlePixelWriter.confirm(c.attemptId, c);
        expect(await http.claimPixel(paired.capability)).toEqual(c);
        expect(await http.claimPixel(paired.capability)).toBe(null);
        expect(http.pixelAllowed(paired.capability, c.attemptId).allowed).toBe(true);
        await f.s.singlePixelWriter.stop();
        expect(http.pixelAllowed(paired.capability, c.attemptId).allowed).toBe(false);
        await http.pixelResult(paired.capability, c.attemptId, 'confirmed');
        expect(f.s.singlePixelWriter.view().state).toBe('needs-reconciliation');
        await expect(f.s.singlePixelWriter.reconcile()).rejects.toThrow(/source freshness/);
        http.revoke();
        expect(() => http.pixelAllowed(paired.capability, c.attemptId)).toThrow();
        expect(f.commands()).toBe(0);
    });
    it('never reconciles a real intent using a simulated provider', async () => {
        const f = await setup(true);
        const c = await prepared(f.s, 'real');
        await f.s.singlePixelWriter.confirm(c.attemptId, c);
        await f.s.singlePixelWriter.claim();
        await f.s.singlePixelWriter.stop();
        f.s.connector.connect('local-fake', () => {});
        f.observe();
        await f.s.bindConnector();
        await expect(f.s.singlePixelWriter.reconcile()).rejects.toThrow(/simulated observations/);
        expect(f.s.singlePixelWriter.view().state).toBe('needs-reconciliation');
    });
    it('does not accept an old model/session result', async () => {
        const f = await setup(true);
        const c = await prepared(f.s, 'real');
        await f.s.singlePixelWriter.confirm(c.attemptId, c);
        await f.s.singlePixelWriter.claim();
        f.s.connector.disconnect('session changed');
        await f.s.singlePixelWriter.result(c.attemptId, 'confirmed');
        expect(f.s.singlePixelWriter.view().state).toBe('needs-reconciliation');
    });
});
