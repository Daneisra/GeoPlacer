/** LOCAL contract benchmark: real capture calculations, GM shim, HTTP and provider; no service requests. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto, randomBytes } from 'node:crypto';
import { createCanvas } from 'canvas';
import express from 'express';
import { GeoPixelsProvider, ConnectorPairing, ConnectorHttpChannel } from '@geoplacer/engine-service';
import { createPrivilegedReaderRouter } from '../src/api/v1/connector-http.ts';

const out=process.argv[2] ?? 'test-logs/phase2d/benchmark'; mkdirSync(out,{recursive:true});
const key=randomBytes(32).toString('hex'), results=[];
for (const [width,height] of [[64,64],[595,894],[2000,2000]]) {
  const provider=new GeoPixelsProvider(), pairing=new ConnectorPairing(), channel=new ConnectorHttpChannel(pairing,provider,key);
  const app=express(); app.use('/api/v1/connector/privileged',createPrivilegedReaderRouter(channel));
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const requests=[], captures=[]; let bytes=0, peakRss=process.memoryUsage().rss;
  const tiles=new Map(), topLeft={gridX:999,gridY:1001};
  for(let ty=Math.floor((topLeft.gridY-height+1)/1000)*1000;ty<=1000;ty+=1000)
    for(let tx=0;tx<=Math.floor((topLeft.gridX+width-1)/1000)*1000;tx+=1000){
      const bitmap=createCanvas(1000,1000),ctx=bitmap.getContext('2d');ctx.fillStyle='#000000';ctx.fillRect(0,0,1000,1000);
      tiles.set(`${tx},${ty}`,{colorBitmap:bitmap});
    }
  const data=new Uint8ClampedArray(width*height*4);for(let i=3;i<data.length;i+=4)data[i]=255;
  const context=vm.createContext({crypto:webcrypto,TextEncoder,URL,Date,performance,setTimeout,clearTimeout,
    document:{scripts:[]},location:{origin:'https://geopixels.net'},getSelectedEventId:()=>null,
    ghostImageOriginalData:{width,height,data},ghostImageTopLeft:topLeft,ghostActivePaletteColors:new Set(),
    tileImageCache:tiles,userData:{},Colors:[],
    OffscreenCanvas:class{constructor(w,h){return createCanvas(w,h);}},
    gm:(o)=>{
      const start=performance.now();bytes+=Buffer.byteLength(o.data);
      const abort=new AbortController();
      fetch(o.url,{method:'POST',headers:o.headers,body:o.data,signal:abort.signal,redirect:'error'})
        .then(async r=>{requests.push(performance.now()-start);o.onload({status:r.status,finalUrl:r.url,responseText:await r.text()});})
        .catch(()=>o.onerror());
      return{abort:()=>abort.abort()};
    }});
  for(const name of ['capture','reader','http-transport'])vm.runInContext(readFileSync(`browser/geopixels-${name}.js`,'utf8'),context);
  vm.runInContext(`globalThis.reader=GeoPlacerPageReader;globalThis.transport=GeoPlacerHttpTransport(${JSON.stringify(base)},gm);`,context);
  try {
    await context.transport.pair(channel.issue(key,'https://geopixels.net').token,'https://geopixels.net',()=>channel.approve(key,channel.info().pending.requestId));
    const starts=[];
    for(let round=0;round<3;round++){
      if(round)await new Promise(resolve=>setTimeout(resolve,5000));
      const corner=tiles.get('0,1000').colorBitmap.getContext('2d');
      if(round===1){corner.fillStyle='#ff0000';corner.fillRect(999,1,1,1);}
      if(round===2)corner.clearRect(999,1,1,1);
      const cpu=process.cpuUsage(),start=performance.now(),beforeBytes=bytes; starts.push(start);
      const value=await context.reader.observe(async observation=>{
        await context.transport.send(observation);peakRss=Math.max(peakRss,process.memoryUsage().rss);
      },()=>context.transport.connected());
      const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu),summary=provider.monitoring.view().lastCapture;
      assert.equal(value.cacheStats.known,width*height);assert.equal(summary.sourceObservedAt,null);
      if(round)assert.equal(summary.changedKnown,1);
      captures.push({round,elapsedMs,cpuMs:(used.user+used.system)/1000,processCpuPercentOneCore:(used.user+used.system)/10/elapsedMs,
        sentBytes:bytes-beforeBytes,bands:summary.regionCount,known:summary.known,unknown:summary.unknown,changedKnown:summary.changedKnown,
        sourceObservedAt:summary.sourceObservedAt,rssBytes:process.memoryUsage().rss});
    }
    const sorted=requests.toSorted((a,b)=>a-b);
    results.push({width,height,scope:'Single Node process: capture+canvas+GM shim+HTTP+provider; not actual GeoPixels/browser CPU',
      configuredRestMs:5000,startIntervalsMs:starts.slice(1).map((t,i)=>t-starts[i]),captures,peakRssBytes:peakRss,
      requestLatencyMeanMs:requests.reduce((a,b)=>a+b,0)/requests.length,requestLatencyP95Ms:sorted[Math.floor(sorted.length*.95)]});
    console.log(JSON.stringify(results.at(-1)));
  } finally { await context.transport.disconnect().catch(()=>{});provider.close();await new Promise(resolve=>server.close(resolve)); }
}
writeFileSync(`${out}/metrics.json`,JSON.stringify(results,null,2));
