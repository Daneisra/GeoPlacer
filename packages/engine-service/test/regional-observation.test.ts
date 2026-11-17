import { describe, expect, it } from 'vitest';
import { computeProgress, TRANSPARENT_U32, type Template } from '@geoplacer/core';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';
import { RegionalProgressCache } from '../src/geopixels/region-progress.js';
import { parseRegions, chooseRegion, type ImageRegion } from '../src/geopixels/regions.js';
import type { BrowserObservation } from '../src/geopixels/protocol.js';

const region = (id = 'left', patch: Partial<ImageRegion> = {}): ImageRegion => ({
    id,
    name: id,
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    priority: 'secondary',
    enabled: true,
    ...patch,
});
function setup(width = 4, height = 2) {
    let now = 100_000,
        sequence = 0,
        serial = 0;
    const p = new GeoPixelsProvider(() => now);
    p.connect('read-only', () => {});
    p.monitoring.capabilities(true, true);
    const project = {
        id: 'model',
        generation: 'palette',
        width,
        height,
        gridX: 999,
        gridY: 1000,
        layer: 'base' as const,
    };
    const t = {
        id: 'local',
        revision: 1,
        image: { width, height, pixels: new Uint32Array(width * height).fill(0), palette: [0] },
        placement: { topLeft: { x: 10, y: 20 } },
        coordinateSystem: { yAxis: 'down' },
    } as unknown as Template;
    const send = (
        area = { x: 0, y: 0, width, height },
        pixels = new Array(area.width * area.height).fill(0),
        capture?: BrowserObservation['capture'],
        observedAt: number | null = null
    ) => {
        const o: BrowserObservation = {
            type: 'observation',
            sequence: ++sequence,
            session: 'session',
            project,
            capturedAt: now,
            observedAt,
            rect: {
                x: project.gridX + area.x,
                y: project.gridY - area.y - area.height + 1,
                width: area.width,
                height: area.height,
            },
            pixels,
            resources: null,
            ...(capture ? { capture } : {}),
        };
        p.observe(o);
    };
    send({ x: 0, y: 0, width: 1, height: 1 }, [-2]);
    p.bind(t);
    const capture = (r: ImageRegion, pixels?: number[]) => {
        const meta = { ...p.monitoring.control().region!, id: r.id, x: r.x, y: r.y, width: r.width, height: r.height };
        send(r, pixels, { id: `capture-${++serial}`, index: 0, count: 1, region: meta });
    };
    const cache = new RegionalProgressCache();
    return {
        p,
        t,
        send,
        capture,
        view: () => cache.compute(t, p, now),
        advance: (ms: number) => {
            now += ms;
            p.heartbeat();
        },
        now: () => now,
    };
}

describe('Regional observations: one project, independent pixel expiration', () => {
    it.each([
        { width: 0 },
        { x: -1 },
        { x: 3, width: 2 },
        { height: 3 },
        { id: 'whole-model' },
        { priority: 'other' },
        { enabled: 1 },
        { extra: 1 },
    ])('refuses malformed regions %j', (patch) =>
        expect(() => parseRegions([region('left', patch as Partial<ImageRegion>)], 4, 2)).toThrow()
    );
    it('rejects duplicate identifiers and an unbounded aggregate work budget', () => {
        expect(() => parseRegions([region(), region()], 4, 2)).toThrow();
        expect(() =>
            parseRegions(
                [region('a', { width: 4096, height: 4096 }), region('b', { width: 4096, height: 4096 })],
                4096,
                4096
            )
        ).toThrow();
    });
    it('services secondary regions without starvation and skips suspended regions', () => {
        const values = [region('a', { priority: 'primary' }), region('b'), region('suspended', { enabled: false })],
            served = new Map<string, number>();
        for (let i = 0; i < 40; i++) {
            const r = chooseRegion(values, served)!;
            served.set(r.id, (served.get(r.id) ?? 0) + 1);
        }
        expect(served.get('a')).toBe(30);
        expect(served.get('b')).toBe(10);
        expect(served.has('suspended')).toBe(false);
    });
    it('preserves unknown areas and does not double count overlapping regions', async () => {
        const s = setup(),
            left = region(),
            overlap = region('overlap', { x: 1 });
        s.p.monitoring.configureRegions([left, overlap], 4, 2);
        s.capture(left);
        let v = await s.view();
        expect(v.progress).toMatchObject({ total: 8, correct: 4, unknown: 4 });
        s.capture(overlap);
        v = await s.view();
        expect(v.progress).toMatchObject({ total: 8, correct: 6, unknown: 2 });
        expect(v.regions.map((r) => r.progress.correct)).toEqual([4, 4]);
    });
    it('matches the existing complete calculator including transparent target pixels', async () => {
        const s = setup();
        s.t.image.pixels[0] = TRANSPARENT_U32;
        s.send();
        const actual = (await s.view()).progress;
        const snapshot = await s.p.reader.readRegion({ minX: 10, minY: 20, width: 4, height: 2 });
        expect(actual).toEqual(computeProgress(s.t, snapshot, s.now()));
    });
    it('expires an older region without extending it when its neighbour is captured', async () => {
        const s = setup(),
            left = region(),
            right = region('right', { x: 2 });
        s.p.monitoring.configureRegions([left, right], 4, 2);
        s.capture(left);
        s.advance(20_000);
        s.capture(right);
        s.advance(10_001);
        const v = await s.view();
        expect(v.progress).toMatchObject({ correct: 4, unknown: 4 });
        expect(v.regions[0]).toMatchObject({ ownCaptureExpired: true, progress: { unknown: 4 } });
        expect(v.regions[1]).toMatchObject({ ownCaptureExpired: false, progress: { correct: 4 } });
    });
    it('retains unknown source age even when repeating identical cached values', async () => {
        const s = setup(),
            r = region();
        s.p.monitoring.configureRegions([r], 4, 2);
        s.capture(r);
        s.advance(5000);
        s.capture(r);
        expect((await s.view()).regions[0]!.sourceRange).toBe(null);
        expect(s.p.monitoring.view().lastCapture!.sourceObservedAt).toBe(null);
    });
    it('does not refresh a dated stale source with a new capture date', async () => {
        const s = setup();
        s.send(undefined, undefined, undefined, s.now() - 31_000);
        expect((await s.view()).progress.unknown).toBe(8);
    });
    it('recomputes changed cells once and uses cached counts between updates', async () => {
        const s = setup(512, 1);
        s.send({ x: 0, y: 0, width: 512, height: 1 });
        expect((await s.view()).recomputedCells).toBe(2);
        expect((await s.view()).recomputedCells).toBe(0);
        s.advance(1);
        s.send({ x: 0, y: 0, width: 1, height: 1 }, [1]);
        expect(await s.view()).toMatchObject({ recomputedCells: 1, progress: { correct: 511, incorrect: 1 } });
    });
    it('expires early bands during a slow capture instead of dating the whole rectangle at completion',async()=>{
        const s=setup(),r=region();s.p.monitoring.configureRegions([r],4,2);
        const meta=s.p.monitoring.control().region!;
        s.send({x:0,y:0,width:2,height:1},[0,0],{id:'slow',index:0,count:2,region:meta});
        s.advance(30001);
        s.send({x:0,y:1,width:2,height:1},[0,0],{id:'slow',index:1,count:2,region:meta});
        expect((await s.view()).regions[0]!.progress).toMatchObject({correct:2,unknown:2});
        expect(s.p.monitoring.view().lastCapture!.capturedAt).toBe(s.now()-30001);
    });
    it('yields to control I/O between calculation cells',async()=>{
        const s=setup(512,1);s.send({x:0,y:0,width:512,height:1});let served=false;
        setImmediate(()=>{served=true;});await s.view();expect(served).toBe(true);
    });
    it('revisits expiry reached during a cooperative calculation',async()=>{
        const s=setup();s.send();setImmediate(()=>s.advance(30001));
        expect((await s.view()).progress).toMatchObject({correct:0,unknown:8});
    });
    it('revisits dirty cells for a status request queued behind an older computation',async()=>{
        const s=setup();s.send();setImmediate(()=>s.send(undefined,new Array(8).fill(1)));
        const first=s.view(),second=s.view();await first;
        expect((await second).progress).toMatchObject({correct:0,incorrect:8});
    });
    it('preserves original template bounds for global and regional counts',async()=>{
        const s=setup(),left=region(),outside=region('outside',{x:2});s.send();
        const t={...s.t,coordinateSystem:{yAxis:'down' as const,bounds:{minX:10,minY:20,width:1,height:1}}};s.p.bind(t);
        s.p.monitoring.configureRegions([left,outside],4,2);
        const v=await new RegionalProgressCache().compute(t,s.p,s.now());
        expect(v.progress).toMatchObject({total:1,correct:1});
        expect(v.regions.map(r=>r.progress.total)).toEqual([1,0]);
    });
    it('keeps interrupted bands dated, but never adds a completed history point', async () => {
        const s = setup(),
            r = region();
        s.p.monitoring.configureRegions([r], 4, 2);
        const meta = s.p.monitoring.control().region!;
        s.send({ x: 0, y: 0, width: 2, height: 1 }, [0, 0], { id: 'partial', index: 0, count: 2, region: meta });
        expect(s.p.monitoring.view().history).toHaveLength(0);
        s.p.monitoring.abortCapture('partial');
        expect(s.p.monitoring.view()).toMatchObject({ inFlight: false, history: [], usage: { aborted: 1 } });
        expect((await s.view()).progress).toMatchObject({ correct: 2, unknown: 6 });
    });
    it('refuses reconfiguration during a capture and all-suspended monitoring', () => {
        const s = setup(),
            r = region();
        s.p.monitoring.configureRegions([r], 4, 2);
        s.send({ x: 0, y: 0, width: 2, height: 1 }, [0, 0], {
            id: 'partial',
            index: 0,
            count: 2,
            region: s.p.monitoring.control().region!,
        });
        expect(() => s.p.monitoring.configureRegions([], 4, 2)).toThrow();
        s.p.monitoring.abortCapture('partial');
        s.p.monitoring.configureRegions([region('a', { enabled: false })], 4, 2);
        expect(() => s.p.monitoring.command('start', 5000)).toThrow(/suspended/);
    });
    it('clears regional authority on disconnect and requires a new explicit configuration', () => {
        const s = setup();
        s.p.monitoring.configureRegions([region()], 4, 2);
        s.p.disconnect('revoked');
        expect(s.p.monitoring.view()).toMatchObject({
            configuredRegions: [],
            regionalSupported: false,
            state: 'stopped',
        });
        expect(() => s.p.monitoring.requestRegion('left')).toThrow();
    });
});
