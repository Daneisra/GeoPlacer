/** Local backend status cost, separate from capture/transport and browser rendering. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import express from 'express';
import { GeoPixelsProvider } from '@geoplacer/engine-service';
import { RegionalProgressCache } from '../packages/engine-service/dist/geopixels/region-progress.js';

const out=path.resolve(process.argv[2]??'test-logs/phase2e/progress-benchmark');mkdirSync(out,{recursive:true});
if(!process.argv.includes('--case')) {
  const cases=[];
  for(const [w,h] of [[64,64],[595,894],[2000,2000],[4096,4096]]) {
    const child=spawnSync(process.execPath,['--expose-gc',path.resolve('scripts/bench-regional-progress.mjs'),out,'--case',String(w),String(h)],{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
    writeFileSync(path.join(out,`${w}x${h}.log`),child.stdout+'\n'+child.stderr);assert.equal(child.status,0);
    cases.push(JSON.parse(readFileSync(path.join(out,`${w}x${h}.json`),'utf8')));console.log(`${w}x${h} status measured`);
  }
  writeFileSync(path.join(out,'metrics.json'),JSON.stringify({scope:'Loopback HTTP wrapper around the same regional progression cache. Complete synthetic coverage. No browser rendering, no real service.',cases},null,2));
} else {
  const at=process.argv.indexOf('--case'),width=Number(process.argv[at+1]),height=Number(process.argv[at+2]);
  const p=new GeoPixelsProvider(),cache=new RegionalProgressCache();p.connect('read-only',()=>{});
  const project={id:'local-benchmark',generation:'0',width,height,gridX:999,gridY:1001,layer:'base'};
  let sequence=0;const send=(x,y,w,h,color=0)=>p.observe({type:'observation',sequence:++sequence,session:'benchmark',project,capturedAt:Date.now(),observedAt:null,
    rect:{x:project.gridX+x,y:project.gridY-y-h+1,width:w,height:h},pixels:new Array(w*h).fill(color),resources:null});
  for(let row=0;row<height;){const h=Math.min(height-row,Math.floor(65536/width));send(0,row,width,h);row+=h;}
  const template={id:'local',revision:1,image:{width,height,pixels:new Uint32Array(width*height)},placement:{topLeft:{x:0,y:0}},coordinateSystem:{yAxis:'down'}};
  p.bind(template);const app=express();app.get('/status',async(_req,res)=>res.json(await cache.compute(template,p,Date.now())));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const loop=monitorEventLoopDelay({resolution:10});loop.enable();await new Promise(r=>setTimeout(r,20));
  const results=[];let peak=process.memoryUsage().rss;
  try {
    for(let round=0;round<3;round++) {
      global.gc?.();if(round)send(0,0,Math.min(64,width),Math.min(64,height),round);
      const start=performance.now(),cpu=process.cpuUsage();
      const r=await fetch(`http://127.0.0.1:${server.address().port}/status`),bytes=await r.text(),v=JSON.parse(bytes),used=process.cpuUsage(cpu);
      assert.equal(r.status,200);assert.equal(v.progress.total,width*height);assert.equal(v.progress.unknown,0);
      peak=Math.max(peak,process.memoryUsage().rss);assert.ok(peak<=768*1024*1024,'explicit 768 MiB benchmark budget exceeded');
      results.push({round,httpStatusMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,responseBytes:Buffer.byteLength(bytes),recomputedCells:v.recomputedCells,rssBytes:process.memoryUsage().rss});
      await new Promise(r=>setTimeout(r,20));
    }
    const warm=results.slice(1).map(r=>r.httpStatusMs).sort((a,b)=>a-b);
    writeFileSync(path.join(out,`${width}x${height}.json`),JSON.stringify({width,height,results,coldMs:results[0].httpStatusMs,warmMinMs:warm[0],warmMaxMs:warm.at(-1),maxEventLoopGapMs:loop.max/1e6,peakRssBytes:peak},null,2));
  } finally {loop.disable();p.close();await new Promise(resolve=>server.close(resolve));}
}
