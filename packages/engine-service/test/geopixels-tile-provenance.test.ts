import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';
import { ObservationMonitor } from '../src/geopixels/monitor.js';
describe('Native tile provenance, never a fabricated server date', () => {
    it('correlates a native merge bitmap and rejects overlapping merge jobs instead of guessing their provenance',async()=>{
        const listeners=new Set<(e:unknown)=>void>(),cache=new Map<string,{timestamp:number;colorBitmap:object|null}>([['0,0',{timestamp:1,colorBitmap:{}}]]);
        let forwarded=0;
        const worker={postMessage:()=>{forwarded++;},addEventListener:(_k:string,fn:(e:unknown)=>void)=>listeners.add(fn),removeEventListener:(_k:string,fn:(e:unknown)=>void)=>listeners.delete(fn)};
        const context=vm.createContext({tileImageCache:cache,mergeWorker:worker});
        vm.runInContext(await readFile(new URL('../../../browser/geopixels-tiles.js',import.meta.url),'utf8')+';globalThis.api=GeoPlacerTiles;',context);
        const a=context.api,rect={x:0,y:0,width:1,height:1},old=a.request({tiles:[{x:0,y:0}]});
        cache.set('0,0',{timestamp:2,colorBitmap:null});worker.postMessage();
        // The actual public worker message has only tile identity and pixel data, no session credentials.
        Reflect.apply(worker.postMessage,worker,[{tileKey:'0,0'}]);
        a.receive({ok:true,processedTiles:{tile_0_0:{type:'delta',deltas:[{}],timestamp:2}}},old,100);
        const bitmap={};cache.set('0,0',{timestamp:2,colorBitmap:bitmap});for(const fn of listeners)fn({data:{tileKey:'0,0',colorBitmap:bitmap}});
        expect(a.inspect(rect)[0]).toMatchObject({state:'native-updated',nativeReceivedAt:100});
        const requested=a.request({tiles:[{x:0,y:0}]});cache.set('0,0',{timestamp:3,colorBitmap:null});
        for(let n=0;n<2;n++)Reflect.apply(worker.postMessage,worker,[{tileKey:'0,0'}]);
        a.receive({ok:true,processedTiles:{tile_0_0:{type:'delta',deltas:[{}],timestamp:3}}},requested,200);
        for(let n=0;n<2;n++){const bitmap={};cache.set('0,0',{timestamp:3,colorBitmap:bitmap});for(const fn of listeners)fn({data:{tileKey:'0,0',colorBitmap:bitmap}});}
        expect(a.inspect(rect)[0].state).toBe('cache-only');expect(forwarded).toBe(4);
    });
    it('prioritizes loaded regions of a 2048 × 2731 image with fair probes, without requesting any tile',()=>{
        let now=100000;const m=new ObservationMonitor(()=>now);m.capabilities(true,true);m.automaticRegions(2048,2731);m.command('start',5000);
        const project={id:'large',generation:'g',width:2048,height:2731,gridX:0,gridY:2730,layer:'base' as const};
        let knownRegions=0,missingRegions=0,wraps=0;
        for(let n=0;n<100;n++) {
            const c=m.control(),r=c.region!;now++;
            const loaded=r.x<1000 && r.y<731;if(loaded)knownRegions++;else missingRegions++;
            if(!c.sweepMore)wraps++;
            const o={type:'observation' as const,sequence:n+1,session:'s',project,capturedAt:now,observedAt:null,rect:{x:r.x,y:2730-r.y-r.height+1,width:r.width,height:r.height},pixels:new Array(r.width*r.height).fill(loaded?0:-2),resources:null,capture:{id:'capture-'+n,index:0,count:1,region:r},cacheCoverage:{keys:['0,2000'],complete:true}};
            m.prepare(o,JSON.stringify(project));m.region(o,{changedKnown:0,newlyKnown:0,becameUnknown:0,unchanged:o.pixels.length});
        }
        expect(knownRegions).toBeGreaterThan(80);expect(missingRegions).toBeGreaterThan(0);expect(wraps).toBeGreaterThan(0);expect(m.automaticRegionCount()).toBe(88);
        expect(m.view().history.length).toBeLessThanOrEqual(120);expect(m.view().lastCapture?.sourceObservedAt).toBeNull();
    });
    it('tracks full replacements and unchanged deltas, invalidates replacement/cursor/merges and keeps receipt age', async () => {
        const bitmap = {},
            cache = new Map([['0,0', { colorBitmap: bitmap, timestamp: 1 }]]),
            context = vm.createContext({ tileImageCache: cache });
        vm.runInContext(
            (await readFile(new URL('../../../browser/geopixels-tiles.js', import.meta.url), 'utf8')) +
                ';globalThis.api=GeoPlacerTiles;',
            context
        );
        const a = context.api,
            r = { x: 0, y: 0, width: 2, height: 2 };
        const requested = a.request({ tiles: [{ x: 0, y: 0, timestamp: 1 }], tokenUser: 'private-not-copied' });
        expect(JSON.stringify(requested)).not.toMatch(/token|private/);
        a.receive(
            { ok: true, processedTiles: { tile_0_0: { type: 'delta', deltas: [], timestamp: 999999999 } } },
            requested,
            100
        );
        expect(a.inspect(r)[0]).toEqual({ key: '0,0', state: 'native-checked', nativeReceivedAt: 100 });
        expect(a.inspect(r)[0].nativeReceivedAt).toBe(100);
        cache.set('0,0', { colorBitmap: {}, timestamp: 2 });
        expect(a.inspect(r)[0].state).toBe('cache-only');
        const next = {};
        a.receive(
            { ok: true, processedTiles: { tile_0_0: { type: 'full', deltas: [], colorBitmap: next, timestamp: 3 } } },
            a.request({ tiles: [{ x: 0, y: 0 }] }),
            200
        );
        expect(a.inspect(r)[0].state).toBe('cache-only');
        cache.set('0,0', { colorBitmap: next, timestamp: 3 });
        expect(a.inspect(r)[0].state).toBe('native-updated');
        a.receive(
            { ok: true, processedTiles: { tile_0_0: { type: 'delta', deltas: [{}], timestamp: 4 } } },
            a.request({ tiles: [{ x: 0, y: 0 }] }),
            300
        );
        expect(a.inspect(r)[0].state).toBe('cache-only');
        cache.clear();
        expect(a.inspect(r)[0].state).toBe('missing');
    });
    it('expires native proof independently of repeated captures and rejects evidence outside the observed region', () => {
        let now = 100000;
        const p = new GeoPixelsProvider(() => now);
        p.connect('read-only', () => {});
        const o = {
            type: 'observation',
            sequence: 1,
            session: 's',
            project: { id: 'p', generation: 'g', width: 2, height: 1, gridX: 0, gridY: 0, layer: 'base' },
            capturedAt: now,
            observedAt: null,
            rect: { x: 0, y: 0, width: 2, height: 1 },
            pixels: [0, -2],
            resources: null,
            tiles: [{ key: '0,0', state: 'native-updated', nativeReceivedAt: now }],
        };
        p.observe(o);
        expect(p.status().tileEvidence.nativeUpdated).toBe(1);
        expect(p.status().freshness).toBe('unverified');
        now += 30001;
        p.observe({ ...o, sequence: 2, capturedAt: now });
        expect(p.status().tileEvidence.nativeUpdated).toBe(0);
        expect(() =>
            p.observe({
                ...o,
                sequence: 3,
                capturedAt: now,
                tiles: [{ key: '1000,0', state: 'native-updated', nativeReceivedAt: now }],
            })
        ).toThrow();
        p.close();
    });
});
