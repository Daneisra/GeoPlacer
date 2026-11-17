import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { assembleProgress, computeProgressWithinBounds, UNKNOWN, TRANSPARENT_U32, type CanvasRect, type CanvasSnapshot, type ProgressSnapshot, type Template } from '@geoplacer/core';
import type { GeoPixelsProvider } from './provider.js';
import type { ImageRegion } from './regions.js';
import { check } from './protocol.js';

// The provider expires individual pixels; a snapshot-wide date must not erase mixed-age valid pixels.
const OPTIONS = {};
type Window = Awaited<ReturnType<GeoPixelsProvider['readWindow']>>;
type Entry = { stamp:number; until:number; progress:ProgressSnapshot; captureRange:Window['captureRange']; sourceRange:Window['sourceRange'] };
type RegionResult = ImageRegion & { progress:ProgressSnapshot; captureRange:Window['captureRange']; sourceRange:Window['sourceRange']; lastOwnCapture:number|null; ownCaptureExpired:boolean; coverageKnown:number; composite:true };
type Result = {progress:ProgressSnapshot;regions:RegionResult[];recomputedCells:number};
const intersection=(a:CanvasRect,b:CanvasRect):CanvasRect|null=>{
  const minX=Math.max(a.minX,b.minX),minY=Math.max(a.minY,b.minY);
  const width=Math.min(a.minX+a.width,b.minX+b.width)-minX,height=Math.min(a.minY+a.height,b.minY+b.height)-minY;
  return width>0&&height>0?{minX,minY,width,height}:null;
};

/** Calculation cells of one image, not tasks/models. Core owns every pixel classification. */
export class RegionalProgressCache {
  private key='';private image:Template['image']|null=null;private transparent=0;
  private readonly entries=new Map<string,Entry>();private pending:Promise<Result>|null=null;
  async compute(template:Template,provider:GeoPixelsProvider,now:number):Promise<Result> {
    // Completion/history callers revisit dirty cells after the preceding computation.
    while(this.pending)await this.pending;
    const task=this.computeNow(template,provider,Math.max(now,provider.monitoring.view().at));this.pending=task;
    try{return await task;}finally{if(this.pending===task)this.pending=null;}
  }
  private async computeNow(t:Template,p:GeoPixelsProvider,now:number,retried=false):Promise<Result> {
    p.assertBinding(t);
    const key=JSON.stringify([t.id,t.revision,t.placement,t.coordinateSystem,p.channelEpoch,p.status().project]);
    if(key!==this.key||this.image!==t.image){
      this.key=key;this.image=t.image;this.entries.clear();this.transparent=0;
      for(let i=0;i<t.image.pixels.length;i++){
        if(t.image.pixels[i]===TRANSPARENT_U32)this.transparent++;
        if((i+1)%262144===0){await yieldToEventLoop();p.assertBinding(t);}
      }
    }
    let recomputedCells=0;const active=new Set<string>();
    const calculate=async(rect:CanvasRect):Promise<Entry>=>{
      const cacheKey=JSON.stringify(rect);active.add(cacheKey);
      const stamp=p.regionStamp(rect),old=this.entries.get(cacheKey),at=p.monitoring.view().at;
      if(old&&old.stamp===stamp&&at<=old.until)return old;
      const w=await p.readWindow(rect);p.assertBinding(t);
      const coordinateSystem={yAxis:'down' as const,bounds:rect};
      const progress=computeProgressWithinBounds({...t,coordinateSystem},{...w.snapshot,coordinateSystem},at,OPTIONS);
      const entry={stamp,until:w.validUntil,progress,captureRange:w.captureRange,sourceRange:w.sourceRange};
      this.entries.set(cacheKey,entry);recomputedCells++;
      // At most 256 squared copied/classified pixels before allowing channel/control I/O.
      await yieldToEventLoop();p.assertBinding(t);return entry;
    };
    const whole={minX:t.placement.topLeft.x,minY:t.placement.topLeft.y,width:t.image.width,height:t.image.height};
    const source=p.status().mode==='local-fake'?'geopixels-fixture' as const:'geopixels-observed' as const;
    const collect=async(area:CanvasRect,wholeImage=false)=>{
      const colors=new Map<number,number[]>();let transparent=0,invalid=0,observedAt=Infinity;
      let oldestCapture=Infinity,newestCapture=0,oldestSource=Infinity,newestSource=0,sourceUnknown=false;
      const bounded=t.coordinateSystem.bounds?intersection(area,t.coordinateSystem.bounds):area;
      if(bounded){
        const x0=Math.max(0,Math.floor((bounded.minX-whole.minX)/256)),y0=Math.max(0,Math.floor((bounded.minY-whole.minY)/256));
        for(let cy=y0;cy<Math.ceil((bounded.minY+bounded.height-whole.minY)/256);cy++)
          for(let cx=x0;cx<Math.ceil((bounded.minX+bounded.width-whole.minX)/256);cx++){
            const rect=intersection(bounded,{minX:whole.minX+cx*256,minY:whole.minY+cy*256,width:256,height:256});
            if(!rect)continue;const e=await calculate(rect);
            transparent+=e.progress.excluded.transparent;invalid+=e.progress.invalidObservations;
            if(e.progress.correct+e.progress.incorrect>0)observedAt=Math.min(observedAt,e.progress.basis.observedAt);
            if(e.captureRange){oldestCapture=Math.min(oldestCapture,e.captureRange.oldest);newestCapture=Math.max(newestCapture,e.captureRange.newest);if(!e.sourceRange)sourceUnknown=true;}
            if(e.sourceRange){oldestSource=Math.min(oldestSource,e.sourceRange.oldest);newestSource=Math.max(newestSource,e.sourceRange.newest);}
            for(const c of e.progress.byColor){const v=colors.get(c.color)??[0,0,0,0,0];v[0]!+=c.total;v[1]!+=c.correct;v[2]!+=c.wrongColor;v[3]!+=c.missing;v[4]!+=c.unknown;colors.set(c.color,v);}
          }
      }
      const snapshot:CanvasSnapshot={rect:area,coordinateSystem:t.coordinateSystem,source,observedAt:Number.isFinite(observedAt)?observedAt:0,get:()=>UNKNOWN};
      const palette=[...colors.keys()],counters=new Float64Array(palette.length*5);palette.forEach((c,i)=>counters.set(colors.get(c)!,i*5));
      return {progress:assembleProgress(t,snapshot,now,OPTIONS,palette,counters,invalid,wholeImage?this.transparent:transparent),
        captureRange:newestCapture?{oldest:oldestCapture,newest:newestCapture}:null,
        sourceRange:!sourceUnknown&&newestSource?{oldest:oldestSource,newest:newestSource}:null};
    };
    const global=await collect(whole,true),regions:RegionResult[]=[];
    const monitor=p.monitoring.view();
    for(const r of monitor.configuredRegions){
      const e=await collect({minX:whole.minX+r.x,minY:whole.minY+r.y,width:r.width,height:r.height});
      const own=[...monitor.history].reverse().find(h=>h.regionId===r.id&&h.captureRegion?.x===r.x&&h.captureRegion?.y===r.y&&h.captureRegion?.width===r.width&&h.captureRegion?.height===r.height&&h.projectKey===monitor.lastCapture?.projectKey);
      regions.push({...r,...e,lastOwnCapture:own?.capturedAt??null,ownCaptureExpired:own!==undefined&&now-own.capturedAt>30000,coverageKnown:e.progress.correct+e.progress.incorrect,composite:true});
    }
    p.assertBinding(t);
    const finished=p.monitoring.view().at;
    if([...active].some(k=>finished>this.entries.get(k)!.until)){
      check(!retried,'observations expired during progression calculation; retry');
      return this.computeNow(t,p,finished,true);
    }
    for(const k of this.entries.keys())if(!active.has(k))this.entries.delete(k);
    return{progress:global.progress,regions,recomputedCells};
  }
}
