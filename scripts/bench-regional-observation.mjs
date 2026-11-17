/** Local contracts only. Fresh child per case, three passes, no GeoPixels requests. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { webcrypto, randomBytes } from 'node:crypto';
import { createCanvas } from 'canvas';
import express from 'express';
import { createPrivilegedReaderRouter } from '../src/api/v1/connector-http.ts';

const BASE='a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1';
const out=path.resolve(process.argv[2] ?? 'test-logs/phase2e/benchmark');mkdirSync(out,{recursive:true});
const BUDGET=768*1024*1024;
if(!process.argv.includes('--case')) {
  const source=path.join(out,'baseline-2d');mkdirSync(source,{recursive:true});
  const files=execFileSync('git',['ls-tree','-r','--name-only',BASE,'packages/engine-service/src/geopixels'],{encoding:'utf8'}).trim().split('\n');
  for(const file of files)writeFileSync(path.join(source,path.basename(file)),execFileSync('git',['show',`${BASE}:${file}`]));
  const cases=[];
  for(const [w,h] of [[64,64],[595,894],[2000,2000],[4096,4096]])for(const mode of ['2d-full','2e-full','2e-region']) {
    if(w===4096 && mode==='2d-full'){cases.push({width:w,height:h,mode,unsupported:'2D reader limit is 2000 per side'});continue;}
    const name=`${mode}-${w}x${h}`;
    if(process.argv.includes('--resume')) {try {const prior=JSON.parse(readFileSync(path.join(out,name+'.json'),'utf8'));if(prior.runs.length===3){cases.push(prior);console.log(name+' verified prior three passes');continue;}}catch{}}
    const r=spawnSync(process.execPath,['--expose-gc','--import','tsx',path.resolve('scripts/bench-regional-observation.mjs'),out,'--case',mode,String(w),String(h)],{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
    writeFileSync(path.join(out,name+'.log'),r.stdout+'\n'+r.stderr);
    if(r.status!==0)throw new Error(`Benchmark child failed: ${name}, see log`);
    cases.push(JSON.parse(readFileSync(path.join(out,name+'.json'),'utf8')));
    console.log(name+' completed');
  }
  writeFileSync(path.join(out,'metrics.json'),JSON.stringify({baseline:BASE,budgetBytes:BUDGET,scope:'Single Node process, native canvas + GM shim + HTTP + provider; mutable canvas, no immutable bitmap cache benefit, not browser CPU',cases},null,2));
} else {
  const at=process.argv.indexOf('--case'),mode=process.argv[at+1],width=Number(process.argv[at+2]),height=Number(process.argv[at+3]);
  const baseline=mode.startsWith('2d'),regional=mode.endsWith('region');
  const moduleFile=name=>pathToFileURL(path.resolve(baseline?path.join(out,'baseline-2d',name+'.ts'):'packages/engine-service/src/geopixels/'+name+'.ts')).href;
  const {GeoPixelsProvider}=await import(moduleFile('provider')),{ConnectorPairing}=await import(moduleFile('pairing')),{ConnectorHttpChannel}=await import(moduleFile('http-channel'));
  const key=randomBytes(32).toString('hex'),provider=new GeoPixelsProvider(),channel=new ConnectorHttpChannel(new ConnectorPairing(),provider,key);
  const originalBatch=channel.batch.bind(channel);channel.batch=(...args)=>{try{return originalBatch(...args);}catch(error){console.error('Benchmark channel validation:',error.message);throw error;}};
  const app=express();app.use('/api/v1/connector/privileged',createPrivilegedReaderRouter(channel));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,tiles=new Map(),topLeft={gridX:999,gridY:1001};
  for(let ty=Math.floor((topLeft.gridY-height+1)/1000)*1000;ty<=1000;ty+=1000)for(let tx=0;tx<=Math.floor((topLeft.gridX+width-1)/1000)*1000;tx+=1000){
    const bitmap=createCanvas(1000,1000),ctx=bitmap.getContext('2d');ctx.fillStyle='#000000';ctx.fillRect(0,0,1000,1000);tiles.set(`${tx},${ty}`,{colorBitmap:bitmap});
  }
  const data=new Uint8ClampedArray(width*height*4);for(let i=3;i<data.length;i+=4)data[i]=255;
  let bytes=0,peak=process.memoryUsage().rss;const latencies=[];
  const context=vm.createContext({crypto:webcrypto,TextEncoder,URL,Date,performance,setTimeout,clearTimeout,
    document:{scripts:[]},location:{origin:'https://geopixels.net'},getSelectedEventId:()=>null,
    ghostImageOriginalData:{width,height,data},ghostImageTopLeft:topLeft,ghostActivePaletteColors:new Set(),tileImageCache:tiles,userData:{},Colors:[],
    OffscreenCanvas:class{constructor(w,h){return createCanvas(w,h);}},gm:o=>{
      bytes+=Buffer.byteLength(o.data);const start=performance.now(),abort=new AbortController();
      fetch(o.url,{method:'POST',headers:o.headers,body:o.data,redirect:'error',signal:abort.signal}).then(async r=>{const text=await r.text();if(!r.ok)console.error('Benchmark HTTP failure:',new URL(o.url).pathname,r.status,text);if(o.url.endsWith('/observations'))latencies.push(performance.now()-start);o.onload({status:r.status,finalUrl:r.url,responseText:text});}).catch(()=>o.onerror());return{abort:()=>abort.abort()};
    }});
  for(const name of ['capture','reader','http-transport'])vm.runInContext(baseline?execFileSync('git',['show',`${BASE}:browser/geopixels-${name}.js`],{encoding:'utf8'}):readFileSync(`browser/geopixels-${name}.js`,'utf8'),context);
  vm.runInContext(`globalThis.reader=GeoPlacerPageReader;globalThis.transport=GeoPlacerHttpTransport(${JSON.stringify(base)},gm);`,context);
  const runs=[];
  try {
    await context.transport.pair(channel.issue(key,'https://geopixels.net').token,'https://geopixels.net',()=>channel.approve(key,channel.info().pending.requestId));
    const r={id:'main',name:'main',x:0,y:0,width:Math.min(width,64),height:Math.min(height,64),priority:'primary',enabled:true};
    if(regional)provider.monitoring.configureRegions([r],width,height);
    for(let round=0;round<3;round++) {
      global.gc?.();let cancel=false;
      const cpu=process.cpuUsage(),start=performance.now(),sent=bytes,before=latencies.length;
      const value=await context.reader.observe(async o=>{
        await context.transport.send(o);peak=Math.max(peak,process.memoryUsage().rss);
        if(peak>BUDGET)cancel=true;
      },()=>context.transport.connected(),regional?provider.monitoring.control().region:null,()=>cancel).catch(e=>{
        if(e.name!=='AbortError')throw e;
        provider.monitoring.abortCapture(e.captureId);return{aborted:true};
      });
      const elapsed=performance.now()-start,used=process.cpuUsage(cpu);
      const summary=provider.monitoring.view().lastCapture;
      if(!value.aborted){assert.equal(value.cacheStats.known,regional?r.width*r.height:width*height);assert.equal(summary.sourceObservedAt,null);}
      runs.push({round,durationMs:elapsed,cpuMs:(used.user+used.system)/1000,bytes:bytes-sent,bands:latencies.length-before,rssBytes:process.memoryUsage().rss,aborted:!!value.aborted});
      if(value.aborted)break;
    }
    // Explicit cooperative cancellation also exercises the 4096² path without changing expiry.
    let abortedCleanly=null;
    if(!baseline && width===4096){let sent=0;await context.reader.observe(async o=>{await context.transport.send(o);sent++;},()=>true,null,()=>sent>=1).then(()=>{throw new Error('missing cancellation');}).catch(e=>{assert.equal(e.name,'AbortError');provider.monitoring.abortCapture(e.captureId);abortedCleanly=!provider.monitoring.view().inFlight;});}
    const durations=runs.map(r=>r.durationMs).toSorted((a,b)=>a-b),lat=latencies.toSorted((a,b)=>a-b);
    const result={mode,width,height,runs,medianMs:durations[Math.floor(durations.length/2)],minMs:durations[0],maxMs:durations.at(-1),peakRssBytes:peak,budgetBytes:BUDGET,abortedCleanly,requestMedianMs:lat[Math.floor(lat.length/2)],requestMaxMs:lat.at(-1),sourceObservedAt:null};
    writeFileSync(path.join(out,`${mode}-${width}x${height}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally {await context.transport.disconnect().catch(()=>{});provider.close();await new Promise(resolve=>server.close(resolve));}
}
