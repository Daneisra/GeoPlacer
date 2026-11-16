import { writeFileSync } from 'node:fs';
import { GeoPixelsProvider } from '@geoplacer/engine-service';
import { computeProgress } from '@geoplacer/core';
import assert from 'node:assert/strict';
const report = [];
for (const [width, height] of [[64,64],[595,894],[2000,2000]]) {
  const now=Date.now(),begin=performance.now(),provider=new GeoPixelsProvider(()=>now);
  provider.connect('local-fake',()=>{});
  const image=new Uint32Array(width*height);
  for(let i=0;i<image.length;i++)image[i]=i%13===0?0xffffffff:i%2===0?0:0xffffff;
  const project={id:'bench',generation:'1',width,height,gridX:-1001,gridY:1001,layer:'base'};
  let sequence=0;
  for(let row=0;row<height;){
    const h=Math.min(height-row,Math.floor(65536/width)),pixels=[];
    for(let y=0;y<h;y++)for(let x=0;x<width;x++){const c=image[(row+h-1-y)*width+x];pixels.push(c===0xffffffff?-1:c);}
    provider.observe({type:'observation',sequence:++sequence,session:'bench',project,capturedAt:now,observedAt:now,rect:{x:-1001,y:1001-row-h+1,width,height:h},pixels,resources:null});row+=h;
  }
  const template={id:'bench',revision:1,image:{width,height,pixels:image},placement:{topLeft:{x:0,y:0}},coordinateSystem:{yAxis:'down'}};
  provider.bind(template);const ingested=performance.now();
  const snapshot=await provider.reader.readRegion({minX:0,minY:0,width,height}),read=performance.now();
  const progress=computeProgress(template,snapshot,now),end=performance.now();
  assert.equal(progress.incorrect,0);assert.equal(progress.unknown,0);assert.equal(progress.correct+progress.excluded.transparent,width*height);
  report.push({width,height,ingestMs:Math.round(ingested-begin),readMs:Math.round(read-ingested),progressMs:Math.round(end-read),rssMiB:Math.round(process.memoryUsage().rss/1048576),eligible:progress.total,transparent:progress.excluded.transparent});
  provider.close();
}
const result=JSON.stringify({node:process.version,platform:process.platform,measurements:report},null,2);
if(process.argv[2])writeFileSync(process.argv[2],result+'\n');
console.log(result);
