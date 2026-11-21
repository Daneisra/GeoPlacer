/** Browser CSP/GM contract fixture. GM requests are simulated by Node, not a real extension. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function runHttpReaderRecipe({ browser, page, api, base, approvalKey, repo, out, record }) {
  const managementResponses = [];
  const trace = response => { const u=new URL(response.url()); if(u.origin === base && u.pathname.startsWith('/api/v1/')) managementResponses.push({path:u.pathname,status:response.status(),at:Date.now()}); };
  page.on('response',trace);
  const { PNG } = createRequire(path.join(repo, 'package.json'))('pngjs');
  const png = PNG.sync.read(readFileSync(path.join(repo, 'public/fixtures/geoplacer-8x5.png')));
  const owned=[...new Set(Array.from({length:40},(_,i)=>png.data[i*4+3]===255 ? (png.data[i*4]<<16)|(png.data[i*4+1]<<8)|png.data[i*4+2] : 0))];
  assert.equal(png.width, 8); assert.equal(png.height, 5);
  await api('connector/source', { source: 'geopixels' });
  await page.reload();
  await page.getByLabel('Source de toile').selectOption('geopixels');
  await page.getByLabel('Réglages avancés',{exact:true}).check();
  await page.getByLabel('Clé locale d’approbation', { exact: true }).fill(approvalKey);
  await page.getByRole('button',{name:'Utiliser le modèle de test 8 × 5',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Modèle local"]')?.selectedOptions[0]?.textContent.includes('Test GeoPixels'));
  const imported=(await api('connector/status',undefined,'GET')).selection;
  const count=(await api('templates',undefined,'GET')).templates.length;
  await page.getByRole('button',{name:'Utiliser le modèle de test 8 × 5',exact:true}).click();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Utiliser le modèle de test 8 × 5')?.disabled);
  assert.equal((await api('templates',undefined,'GET')).templates.length,count);
  record('OK missing test model restored through UI, selected immediately, reused without duplicate');
  const context = await browser.newContext();
  const external = [],
    errors = [],
    timings = [];
  const fixtureUrl = 'https://geopixels.net/__geoplacer_contract_fixture__';
  const html = `<!doctype html><html><head><style nonce="geoplacer-fixture-style">aside,button,p { all:unset!important; }</style></head><body><h1>LOCAL CSP FIXTURE — no GeoPixels connection</h1><script>
let ghostImageOriginalData = new ImageData(new Uint8ClampedArray(${JSON.stringify([...png.data])}),8,5);
let ghostImageTopLeft = {gridX:999,gridY:1001}; let ghostActivePaletteColors = new Set();
let tileImageCache = new Map(); let userID=7; let userData={colors:'${owned.join(',')}'}; let Colors=['#000000','#ffffff'];
let tokenUser='synthetic-browser-fixture-only', subject='synthetic-browser-subject';
let currentEnergy=60, queuedPixelsObjects=new Map(), isPlacingRequestInProgress=false;
function getSelectedEventId(){return null;}
function loadFixtureTiles(){
  tileImageCache.clear();
  for(let y=0;y<5;y++)for(let x=0;x<8;x++){
    const gx=ghostImageTopLeft.gridX+x, gy=ghostImageTopLeft.gridY-y;
    const tx=Math.floor(gx/1000)*1000,ty=Math.floor(gy/1000)*1000,key=tx+','+ty;
    if(!tileImageCache.has(key)){const c=document.createElement('canvas');c.width=c.height=1000;tileImageCache.set(key,{colorBitmap:c});}
    const ctx=tileImageCache.get(key).colorBitmap.getContext('2d'),i=(y*8+x)*4;
    ctx.fillStyle='rgba('+ghostImageOriginalData.data[i]+','+ghostImageOriginalData.data[i+1]+','+ghostImageOriginalData.data[i+2]+','+ghostImageOriginalData.data[i+3]/255+')';
    ctx.fillRect(gx-tx,gy-ty,1,1);
  }
}
document.addEventListener('securitypolicyviolation',e=>{if(e.effectiveDirective==='connect-src')globalThis.blockedByCsp=true;});
</script></body></html>`;
  await context.route('**/*', (route) => {
    if (route.request().url() === fixtureUrl)
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: {
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'nonce-geoplacer-fixture-style'",
        },
        body: html,
      });
    external.push(route.request().url());
    return route.abort();
  });
  await context.exposeBinding('fixturePrivilegedHttp', async (_source, options) => {
    assert.ok(options.url.startsWith(base + '/api/v1/connector/privileged/'));
    const before = performance.now();
    const response = await fetch(options.url, {
      method: 'POST',
      headers: options.headers,
      body: options.data,
      redirect: 'error',
    });
    const responseText = await response.text();
    if (options.url.endsWith('/observations')) timings.push(performance.now() - before);
    return { status: response.status, finalUrl: response.url, responseText };
  });
  await context.addInitScript(() => {
    // Reproduce hidden-tab cadence restrictions without changing browser protections or test deadlines.
    const nativeTimeout = globalThis.setTimeout.bind(globalThis), nativeInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (fn, ms, ...args) => nativeInterval(fn, Math.max(60000, ms), ...args);
    globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms < 5000 ? 60000 : ms, ...args);
    // Emulate privileged style insertion with a fixture-only nonce; page CSP stays enforced.
    globalThis.GM_addElement = (tag, attributes) => {
      if(tag !== 'style') throw new Error('Only scoped panel styles are permitted');
      const element=document.createElement(tag);element.nonce='geoplacer-fixture-style';
      element.textContent=attributes.textContent;document.head.append(element);return element;
    };
    globalThis.GM_xmlhttpRequest = (o) => {
      let aborted = false;
      globalThis
        .fixturePrivilegedHttp({ url: o.url, headers: o.headers, data: o.data })
        .then((r) => {
          if (!aborted) o.onload(r);
        })
        .catch(() => {
          if (!aborted) o.onerror();
        });
      return {
        abort() {
          aborted = true;
          o.onabort();
        },
      };
    };
  });
  const reader = await context.newPage();
  reader.on('pageerror', (e) => errors.push(e.message));
  try {
    await reader.goto(fixtureUrl);
    await reader.evaluate((base) => {
      try {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/v1/connector/channel');
        ws.onerror = () => {};
      } catch (e) {
        globalThis.synchronousSocketRefusal = 'refused';
      }
    }, base);
    await reader.waitForFunction(
      () => globalThis.blockedByCsp === true || typeof globalThis.synchronousSocketRefusal === 'string'
    );
    record(
      (await reader.evaluate(() => globalThis.blockedByCsp))
        ? 'OK local fixture reproduces page WebSocket CSP block'
        : 'OK page WebSocket rejected synchronously; exact CSP event not emitted by this browser'
    );
    await reader.addScriptTag({ content: readFileSync(path.join(repo, 'public/geopixels-connector.user.js'), 'utf8') });
    const presentation=await reader.locator('#geoplacer-reader-panel').evaluate(panel=>({
      position:getComputedStyle(panel).position,
      gap:parseInt(getComputedStyle(panel).gap),
      buttonHeight:panel.querySelector('button').getBoundingClientRect().height,
    }));
    assert.equal(presentation.position,'fixed');assert.ok(presentation.gap>=8);assert.ok(presentation.buttonHeight>=36);
    record('OK scoped privileged panel styles under restrictive style CSP; spaced readable buttons');
    const nativeCache=await reader.evaluate(async()=>{
      const bitmapCanvas=new OffscreenCanvas(1000,1000),ctx=bitmapCanvas.getContext('2d');ctx.fillStyle='#000000';ctx.fillRect(0,0,1000,1000);
      const source=new Map([['0,0',{colorBitmap:await createImageBitmap(bitmapCanvas)}]]),decoded=GeoPlacerCapture.createReadCache(4_000_000);
      let decodes=0;
      const factory=(w,h)=>{const c=new OffscreenCanvas(w,h),context=c.getContext('2d');return{getContext:()=>({drawImage:(...args)=>context.drawImage(...args),getImageData:(...args)=>{decodes++;return context.getImageData(...args);}})};};
      const p={gridX:0,gridY:0,width:1,height:1},r={x:0,y:0,width:1,height:1};
      const read=()=>GeoPlacerCapture.readRegion(p,r,source,factory,undefined,decoded)[0];
      const first=read(),second=read();ctx.fillStyle='#ff0000';ctx.fillRect(0,0,1,1);const immutable=read(),reusedDecodes=decodes;
      source.set('0,0',{colorBitmap:await createImageBitmap(bitmapCanvas)});const replaced=read();source.get('0,0').colorBitmap.close();const closed=read();source.clear();read();
      return{first,second,immutable,replaced,closed,reusedDecodes,totalDecodes:decodes,remainingBytes:decoded.bytes()};
    });
    assert.deepEqual(nativeCache,{first:0,second:0,immutable:0,replaced:0xff0000,closed:-2,reusedDecodes:1,totalDecodes:2,remainingBytes:0});
    writeFileSync(path.join(out,'native-bitmap-cache.json'),JSON.stringify(nativeCache,null,2));
    record('OK native ImageBitmap cache: one decode reused, mutable source cannot alter it, replacement and close invalidate, memory released');
    async function pair() {
      await page.getByRole('button', { name: 'Coupler le lecteur GeoPixels', exact: true }).click();
      const code = await page.getByLabel('Code de couplage', { exact: true }).inputValue();
      const inputs = [base, code];
      const handle = async (dialog) => {
        await dialog.accept(inputs.shift());
      };
      reader.on('dialog', handle);
      await reader.getByRole('button', { name: 'Coupler', exact: true }).click();
      const confirm = page.getByRole('button', { name: 'Confirmer la demande HTTP', exact: true });
      await confirm.waitFor();
      await confirm.click();
      await reader.waitForFunction(()=>document.querySelector('aside')?.textContent.match(/Couplé par HTTP|Observation confirmée/));
      reader.off('dialog', handle);
    }
    await pair();
    await page.locator('#connectorCouplingTime').filter({hasText:'Couplage actif pour la session GeoPlacer.'}).waitFor();
    record('OK dashboard displays a session-long reader pairing');
    await reader.getByRole('button', { name: 'Observer le modèle', exact: true }).click();
    await page.getByText('Modèle du navigateur : 8 × 5, origine (999, 1001)', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Lier ce modèle', exact: true }).click();
    await page.locator('#observedUnknown').filter({ hasText: /^38$/ }).waitFor();
    assert.equal((await page.locator('#observedIncorrect').textContent()).trim(), '0');
    await reader.evaluate(() => loadFixtureTiles());
    const before = performance.now();
    await reader.getByRole('button', { name: 'Observer le modèle', exact: true }).click();
    await page.locator('#observedCorrect').filter({ hasText: /^38$/ }).waitFor();
    const dashboardLatencyMs = performance.now() - before;
    assert.equal((await page.locator('#observedUnknown').textContent()).trim(), '0');
    assert.equal((await page.locator('#observedIncorrect').textContent()).trim(), '0');
    record(
      'OK GM contract shim: controlled approval, 8 x 5, Y orientation, palette, 38 opaque / 2 transparent, four tile edges'
    );
    await reader.evaluate(() => tileImageCache.delete('1000,1000'));
    await reader.getByRole('button', { name: 'Observer le modèle', exact: true }).click();
    await page.waitForFunction(
      () => Number(document.querySelector('#observedUnknown').textContent.replace(/\s/g, '')) > 0
    );
    assert.equal((await page.locator('#observedIncorrect').textContent()).trim(), '0');
    record('OK missing tile stays unknown, never incorrect; resources unavailable remain unavailable');
    const profile = browser.browserType().name() === 'chromium' ? await context.newCDPSession(reader) : null;
    if (profile) await profile.send('Performance.enable');
    const beforeProfile = profile ? await profile.send('Performance.getMetrics') : null;
    const profileStart = performance.now();
    await reader.evaluate(() => loadFixtureTiles());
    await page.getByLabel('Cadence de surveillance', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'Démarrer la surveillance', exact: true }).click();
    await page.locator('#observedCorrect').filter({ hasText: /^38$/ }).waitFor();
    await page.waitForFunction(() => Number(document.querySelector('#observationHistoryCount').textContent.split('/')[0].trim()) >= 4);
    const firstWatch = await api('connector/status', undefined, 'GET');
    const countBeforeChange = firstWatch.monitoring.history.length;
    await reader.evaluate(() => {
      const x=ghostImageTopLeft.gridX, y=ghostImageTopLeft.gridY;
      const key=Math.floor(x/1000)*1000+','+Math.floor(y/1000)*1000;
      const ctx=tileImageCache.get(key).colorBitmap.getContext('2d');
      ctx.fillStyle='#ff0000';ctx.fillRect(x%1000,y%1000,1,1);
    });
    await page.locator('#observedIncorrect').filter({ hasText: /^1$/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('#observationChanges').textContent.includes('connues : 1'));
    const changed = await api('connector/status', undefined, 'GET');
    assert.equal(changed.progress.unknown, 0);
    assert.equal(changed.monitoring.lastCapture.changedKnown, 1);
    assert.equal(changed.monitoring.lastCapture.sourceObservedAt, null);
    assert.ok(changed.monitoring.history.length > countBeforeChange);
    await page.getByRole('button', { name: 'Mettre la surveillance en pause', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#monitorState').dataset.state === 'paused' && !document.querySelector('#monitorState').textContent.includes('attendue'));
    const paused = (await api('connector/status', undefined, 'GET')).monitoring.history.length;
    await reader.evaluate(() => loadFixtureTiles());
    await new Promise(r=>setTimeout(r,6000)); // Actual configured 5 s cadence, no timeout inflation.
    assert.equal((await api('connector/status', undefined, 'GET')).monitoring.history.length, paused);
    await page.getByRole('button', { name: 'Reprendre la surveillance', exact: true }).click();
    await page.locator('#observedCorrect').filter({ hasText: /^38$/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('#monitorState').dataset.state === 'running' && !document.querySelector('#monitorState').textContent.includes('attendue'));
    await page.getByRole('button', { name: 'Arrêter la surveillance', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#monitorState').dataset.state === 'stopped' && !document.querySelector('#monitorState').textContent.includes('attendue'));
    const stopped = (await api('connector/status', undefined, 'GET')).monitoring.history.length;
    await new Promise(r=>setTimeout(r,6000));
    assert.equal((await api('connector/status', undefined, 'GET')).monitoring.history.length, stopped);
    const afterProfile = profile ? await profile.send('Performance.getMetrics') : null;
    const finalView = await api('connector/status', undefined, 'GET');
    assert.equal(finalView.lastCompleteProgress.correct,38);
    assert.equal(finalView.lastCompleteProgress.unknown,0);
    const metric = (p, name) => p?.metrics.find(m=>m.name === name)?.value ?? null;
    writeFileSync(path.join(out,'monitoring-metrics.json'), JSON.stringify({
      fixture: true, sourceFreshness: 'unverified', captions: finalView.monitoring.history.map(p=>({ capturedAt:p.capturedAt, receivedAt:p.receivedAt, sourceObservedAt:p.sourceObservedAt })),
      repeatedCapture: true, pauseResumeStop: true, modifiedPixelDetected: true,
      elapsedMs:performance.now()-profileStart, pageTaskCpuMs:profile ? 1000*(metric(afterProfile,'TaskDuration')-metric(beforeProfile,'TaskDuration')) : null,
      pageJsHeapBytes:metric(afterProfile,'JSHeapUsedSize'), measurement: 'CDP page task time/JS heap on Edge; not total browser CPU/RSS; unavailable on Firefox',
      dashboardHistoryCount:finalView.monitoring.history.length
    },null,2));
    record('OK continuous read-only monitoring with page cadence timers clamped to 60 s: repeated captures, changed pixel, pause/resume/stop, source remains undated');
    // Phase 2E: actual regional form and privileged reader, still a strictly local fixture.
    await reader.evaluate(() => tileImageCache.clear());
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedUnknown').filter({hasText:/^38$/}).waitFor();
    await page.getByRole('button',{name:'Ajouter une région',exact:true}).click();
    await page.getByLabel('Nom région 1',{exact:true}).fill('Gauche');
    await page.getByLabel('width région 1',{exact:true}).fill('4');
    await page.getByLabel('height région 1',{exact:true}).fill('5');
    await page.getByLabel('Priorité région 1',{exact:true}).selectOption('primary');
    await page.getByRole('button',{name:'Ajouter une région',exact:true}).click();
    await page.getByLabel('Nom région 2',{exact:true}).fill('Droite');
    await page.getByLabel('x région 2',{exact:true}).fill('4');
    await page.getByLabel('width région 2',{exact:true}).fill('4');
    await page.getByLabel('height région 2',{exact:true}).fill('5');
    await page.getByRole('button',{name:'Enregistrer les régions',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-region-id]').length===2);
    await reader.evaluate(()=>loadFixtureTiles());
    await page.locator('[data-region-id]').nth(0).getByRole('button',{name:'Observer cette région',exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('#observedCorrect').textContent)>0 && Number(document.querySelector('#observedUnknown').textContent)>0);
    let regional=await api('connector/status',undefined,'GET');
    assert.equal(regional.monitoring.lastCapture.total,20);assert.equal(regional.monitoring.lastCapture.regionId,regional.monitoring.configuredRegions[0].id);
    assert.equal(regional.regionViews[0].progress.unknown,0);assert.ok(regional.regionViews[1].progress.unknown>0);
    await page.getByRole('button',{name:'Démarrer la surveillance',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^38$/}).waitFor();
    regional=await api('connector/status',undefined,'GET');
    const ids=regional.monitoring.configuredRegions.map(r=>r.id);
    assert.ok(regional.monitoring.history.some(p=>p.regionId===ids[0]));assert.ok(regional.monitoring.history.some(p=>p.regionId===ids[1]));
    await page.getByRole('button',{name:'Mettre la surveillance en pause',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#monitorState').dataset.state==='paused' && !document.querySelector('#monitorState').textContent.includes('attendue'));
    await page.getByRole('button',{name:'Arrêter la surveillance',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#monitorState').dataset.state==='stopped' && !document.querySelector('#monitorState').textContent.includes('attendue'));
    const regionalEnd=await api('connector/status',undefined,'GET');
    writeFileSync(path.join(out,'regional-metrics.json'),JSON.stringify({fixture:true,realExtension:false,regions:regionalEnd.monitoring.configuredRegions,progress:regionalEnd.progress,regionViews:regionalEnd.regionViews,usage:regionalEnd.monitoring.usage},null,2));
    record('OK regional UI: two image rectangles, one-shot partial coverage, weighted monitoring covers both, pause and stop; no service requests');
    // One-pixel UI flow. The page's site fetch is replaced by a stub; no request can reach GeoPixels.
    await reader.evaluate(()=>{
      const entry=tileImageCache.get('0,1000');
      entry.colorBitmap.getContext('2d').clearRect(999,1,1,1);
      globalThis.fixtureSiteCalls=0;globalThis.fixtureWrites=[];
      globalThis.fetch=async(url,options)=>{
        if(url!==location.origin+'/PlacePixels' || !Array.isArray(JSON.parse(options.body).Pixels) || JSON.parse(options.body).Pixels.length<1 || JSON.parse(options.body).Pixels.length>793)
          throw new Error('Unexpected fixture site operation');
        globalThis.fixtureSiteCalls++;globalThis.fixtureWrites.push(...JSON.parse(options.body).Pixels);
        return new Response('Ok',{status:200});
      };
    });
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedIncorrect').filter({hasText:/^1$/}).waitFor();
    await page.getByText('Essai unitaire (ancien parcours)',{exact:true}).click();
    const pixelPanel=page.getByRole('group',{name:/3. Tester un pixel/});
    await pixelPanel.getByRole('button',{name:'Préparer un pixel',exact:true}).click();
    await pixelPanel.getByText('Préparée — réservation durable',{exact:true}).waitFor();
    await pixelPanel.getByRole('button',{name:'Autoriser ce pixel',exact:true}).click();
    await reader.getByText('Options du lecteur',{exact:true}).click();
    reader.once('dialog',dialog=>dialog.accept());
    await reader.getByRole('button',{name:'Placer le pixel préparé',exact:true}).click();
    await pixelPanel.getByText('Confirmée',{exact:true}).waitFor();
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),1);
    await reader.getByText('Options du lecteur',{exact:true}).click();
    assert.equal((await api('connector/status',undefined,'GET')).progress.incorrect,1);
    await reader.evaluate(()=>loadFixtureTiles());
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^38$/}).waitFor();
    await pixelPanel.getByRole('button',{name:'Arrêter l’essai',exact:true}).click();
    record('OK single-pixel dashboard and trusted browser confirmation; site fetch STUB ONLY, independent reader progress, stop available');
    // Approved five-pixel batch: actual HTTP routes and generated userscript, native fetch STUB ONLY.
    await page.getByText('Essai unitaire (ancien parcours)',{exact:true}).click();
    await reader.evaluate(()=>{
      for(const entry of tileImageCache.values())entry.colorBitmap.getContext('2d').clearRect(0,0,1000,1000);
      globalThis.fixtureWrites=[];
    });
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedIncorrect').filter({hasText:/^38$/}).waitFor();
    const batchPanel=page.getByRole('group',{name:/3. Dessiner un lot/});
    await batchPanel.getByLabel('Mode d’envoi',{exact:true}).selectOption('sequential');
    await batchPanel.getByRole('button',{name:'Préparer le lot',exact:true}).click();
    await page.locator('[data-batch-state="prepared"]').waitFor();
    assert.equal(await batchPanel.locator('tbody tr').count(),5);
    let unexpectedDialogs=0;
    const rejectDialog=dialog=>{unexpectedDialogs++;void dialog.dismiss();};
    reader.on('dialog',rejectDialog);
    await batchPanel.getByRole('button',{name:'Autoriser et démarrer le lot',exact:true}).click();
    await page.locator('[data-batch-state="completed"]').waitFor();
    reader.off('dialog',rejectDialog);assert.equal(unexpectedDialogs,0);
    const batchStatus=await api('connector/status',undefined,'GET');
    assert.equal(batchStatus.batch.confirmed,5);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),6);
    assert.equal(batchStatus.progress.correct,0); // An ACK never changes the observed bitmap.
    await reader.evaluate(()=>{
      for(const w of globalThis.fixtureWrites.slice(0,4)){
        const tx=Math.floor(w.GridX/1000)*1000,ty=Math.floor(w.GridY/1000)*1000;
        const ctx=tileImageCache.get(tx+','+ty).colorBitmap.getContext('2d');
        ctx.fillStyle='#'+w.Color.toString(16).padStart(6,'0');ctx.fillRect(w.GridX-tx,w.GridY-ty,1,1);
      }
    });
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^4$/}).waitFor();
    await batchPanel.getByRole('cell',{name:/Couleur différente/}).waitFor();
    const partial=await api('connector/status',undefined,'GET');
    assert.equal(partial.batch.confirmed,5);assert.equal(partial.batch.verification.correct,4);assert.equal(partial.batch.verification.different,1);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),6);
    await reader.evaluate(()=>{
      const w=globalThis.fixtureWrites[4],tx=Math.floor(w.GridX/1000)*1000,ty=Math.floor(w.GridY/1000)*1000;
      const ctx=tileImageCache.get(tx+','+ty).colorBitmap.getContext('2d');
      ctx.fillStyle='#'+w.Color.toString(16).padStart(6,'0');ctx.fillRect(w.GridX-tx,w.GridY-ty,1,1);
    });
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^5$/}).waitFor();
    assert.equal((await api('connector/status',undefined,'GET')).batch.verification.correct,5);
    record('OK five ACKs with only four observed matches: per-target discrepancy displayed, no retry; subsequent read-only observation sees the fifth');
    record('OK one dashboard authorization, five sequential native-stub sends, no per-pixel dialog, five durable confirmations, independent recapture measures progress');
    // Native grouped mode: one approved request, all five targets; no actual GeoPixels traffic.
    await reader.evaluate(()=>{for(const entry of tileImageCache.values())entry.colorBitmap.getContext('2d').clearRect(0,0,1000,1000);globalThis.fixtureWrites=[];});
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedIncorrect').filter({hasText:/^38$/}).waitFor();
    await batchPanel.getByLabel('Mode d’envoi',{exact:true}).selectOption('grouped');
    await batchPanel.getByRole('button',{name:'Préparer le lot',exact:true}).click();
    await page.locator('[data-batch-state="prepared"]').waitFor();
    await batchPanel.getByText(/Coût maximal : 5 énergie/).waitFor();
    reader.on('dialog',rejectDialog);
    await batchPanel.getByRole('button',{name:'Autoriser et démarrer le lot',exact:true}).click();
    await page.locator('[data-batch-state="completed"]').waitFor();
    reader.off('dialog',rejectDialog);assert.equal(unexpectedDialogs,0);
    const grouped=await api('connector/status',undefined,'GET');
    assert.equal(grouped.batch.execution,'grouped');assert.equal(grouped.batch.acceptedRequests,1);assert.equal(grouped.batch.confirmed,5);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),7);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureWrites.length),5);
    assert.equal(grouped.progress.correct,0);
    await reader.evaluate(()=>{for(const w of globalThis.fixtureWrites.slice(0,4)){
      const tx=Math.floor(w.GridX/1000)*1000,ty=Math.floor(w.GridY/1000)*1000,ctx=tileImageCache.get(tx+','+ty).colorBitmap.getContext('2d');
      ctx.fillStyle='#'+w.Color.toString(16).padStart(6,'0');ctx.fillRect(w.GridX-tx,w.GridY-ty,1,1);
    }});
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^4$/}).waitFor();
    await batchPanel.getByRole('cell',{name:/Couleur différente/}).waitFor();
    assert.equal((await api('connector/status',undefined,'GET')).batch.verification.correct,4);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),7);
    record('OK native group: one HTTP site-stub request for five targets versus five sequential requests; one accepted request stays separate from four observed matches; no retry');
    // A sealed 25-target session; first refuse on actual fixture energy, then explicitly resume unchanged.
    await reader.evaluate(()=>{for(const entry of tileImageCache.values())entry.colorBitmap.getContext('2d').clearRect(0,0,1000,1000);globalThis.fixtureWrites=[];currentEnergy=4;});
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedIncorrect').filter({hasText:/^38$/}).waitFor();
    await batchPanel.getByLabel('Mode d’envoi',{exact:true}).selectOption('session');
    await batchPanel.getByLabel('Budget maximal d’énergie',{exact:true}).fill('25');
    await batchPanel.getByRole('button',{name:'Prévisualiser la session',exact:true}).click();
    await page.locator('[data-batch-state="prepared"]').waitFor();
    assert.equal(await batchPanel.getByRole('table',{name:'Pixels du lot',exact:true}).locator('tbody tr').count(),25);
    await batchPanel.getByText(/Coût maximal : 25 énergie/).waitFor();assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),7);
    reader.on('dialog',rejectDialog);
    await batchPanel.getByRole('button',{name:'Autoriser et démarrer la session',exact:true}).click();
    await page.locator('[data-batch-state="paused"]').waitFor();
    {const paused=await api('connector/status',undefined,'GET');assert.equal(paused.batch.confirmed,0);assert.equal(paused.batch.uncertain,0);}
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),7);
    await reader.evaluate(()=>{currentEnergy=49;}); // Explicit fixture resource observation, never inferred regeneration.
    await batchPanel.getByRole('button',{name:'Reprendre la session autorisée',exact:true}).click();
    await page.locator('[data-batch-state="completed"]').waitFor();
    reader.off('dialog',rejectDialog);assert.equal(unexpectedDialogs,0);
    const session=await api('connector/status',undefined,'GET');
    assert.equal(session.batch.acceptedRequests,5);assert.equal(session.batch.confirmed,25);
    assert.deepEqual(session.batch.budgets,{pixels:25,energy:25});assert.equal(session.progress.correct,0);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),12);
    assert.equal(await reader.evaluate(()=>new Set(globalThis.fixtureWrites.map(p=>p.GridX+','+p.GridY)).size),25);
    await reader.evaluate(()=>{for(const w of globalThis.fixtureWrites){
      const tx=Math.floor(w.GridX/1000)*1000,ty=Math.floor(w.GridY/1000)*1000,ctx=tileImageCache.get(tx+','+ty).colorBitmap.getContext('2d');
      ctx.fillStyle='#'+w.Color.toString(16).padStart(6,'0');ctx.fillRect(w.GridX-tx,w.GridY-ty,1,1);
    }});
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.locator('#observedCorrect').filter({hasText:/^25$/}).waitFor();
    assert.equal((await api('connector/status',undefined,'GET')).batch.verification.correct,25);
    await batchPanel.getByText(/Historique des groupes/).click();
    assert.equal(await batchPanel.getByRole('table',{name:'Historique des groupes',exact:true}).locator('tbody tr').count(),6);
    record('OK supervised session: 25 sealed targets, one approval, known energy refusal then explicit resume, five automatic groups, 25 distinct targets, durable group history and independently observed progress; no external requests');
    await reader.screenshot({ path: path.join(out, 'http-reader-local-fixture.png'), fullPage: true });
    await page.screenshot({ path: path.join(out, 'http-dashboard-local-fixture.png'), fullPage: true });
    await reader.getByText('Options du lecteur',{exact:true}).click();
    await reader.getByRole('button', { name: 'Déconnecter', exact: true }).click();
    await page
      .locator('#connectorConnection')
      .filter({ hasText: /^Déconnecté$/ })
      .waitFor();
    await pair();
    await page.getByRole('button', { name: 'Révoquer le canal', exact: true }).click();
    await reader.getByRole('button', { name: 'Coupler', exact: true }).waitFor({ state: 'visible' });
    await reader.waitForFunction(
      () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Coupler')?.disabled === false
    );
    await page.locator('#connectorTermination').filter({hasText:/révoqué|déconnecté/}).waitFor();
    record('OK HTTP disconnect, new pairing and live revocation');
    // 2J: larger model, real reader code + privileged transport, all service writes mocked locally.
    const large = PNG.sync.read(readFileSync(path.join(repo,'public/fixtures/geoplacer-20x20.png')));
    assert.equal(large.width,20); assert.equal(large.height,20);
    const largeTemplate=await api('templates',{name:'LOCAL FIXTURE — continuous 20 × 20',pngBase64:PNG.sync.write(large).toString('base64'),x:0,y:0,strategy:'top-to-bottom'});
    await api('engine/selection',{templateId:largeTemplate.templateId},'PUT');
    await reader.evaluate((rgba)=>{
      ghostImageOriginalData=new ImageData(new Uint8ClampedArray(rgba),20,20);
      tileImageCache.clear();
      for(let y=0;y<20;y++)for(let x=0;x<20;x++){
        const gx=ghostImageTopLeft.gridX+x,gy=ghostImageTopLeft.gridY-y,tx=Math.floor(gx/1000)*1000,ty=Math.floor(gy/1000)*1000,key=tx+','+ty;
        if(!tileImageCache.has(key)){const c=document.createElement('canvas');c.width=c.height=1000;tileImageCache.set(key,{colorBitmap:c});}
      }
      globalThis.fixtureEnergyListeners=new Set();
      globalThis.syncWorker={postMessage(){},addEventListener(type,fn){if(type==='message')fixtureEnergyListeners.add(fn);},removeEventListener(type,fn){if(type==='message')fixtureEnergyListeners.delete(fn);}};
      currentEnergy=100;globalThis.fixtureWrites=[];
    },[...large.data]);
    await page.reload();
    await page.getByLabel('Clé locale d’approbation',{exact:true}).fill(approvalKey);
    await pair();
    await reader.getByRole('button',{name:'Observer le modèle',exact:true}).click();
    await page.getByText('Modèle du navigateur : 20 × 20, origine (999, 1001)',{exact:true}).waitFor();
    await page.getByLabel('Modèle local',{exact:true}).selectOption(largeTemplate.templateId);
    await page.getByRole('button',{name:'Lier ce modèle',exact:true}).click();
    await page.getByText('Modèle lié ✓',{exact:true}).waitFor();
    await batchPanel.getByLabel('Mode d’envoi',{exact:true}).selectOption('continuous');
    await batchPanel.getByLabel('Nombre maximal de pixels',{exact:true}).fill('30');
    await batchPanel.getByLabel('Budget maximal d’énergie',{exact:true}).fill('30');
    await batchPanel.getByLabel('Zone X',{exact:true}).fill('2');
    await batchPanel.getByLabel('Zone Y',{exact:true}).fill('3');
    await batchPanel.getByLabel('Largeur de zone',{exact:true}).fill('10');
    await batchPanel.getByLabel('Hauteur de zone',{exact:true}).fill('10');
    await batchPanel.getByRole('button',{name:'Prévisualiser la session',exact:true}).click();
    await page.locator('[data-batch-state="prepared"]').waitFor();
    await batchPanel.getByLabel('Autorisation continue',{exact:true}).getByText(/zone image \(2, 3\).*10 × 10/).waitFor();
    const callsBefore=await reader.evaluate(()=>globalThis.fixtureSiteCalls);
    await batchPanel.getByRole('button',{name:'Autoriser et démarrer la session',exact:true}).click();
    await batchPanel.getByText('Attente de ressources observables',{exact:false}).waitFor();
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),callsBefore);
    // Only a native worker response supplies spendable energy; the page clock alone cannot.
    await reader.evaluate(()=>{
      syncWorker.postMessage({type:'sync-delta'});
      for(const fn of fixtureEnergyListeners)fn({data:{ok:true,userData:{energy:10,colors:'0,16777215'}}});
    });
    await page.waitForFunction(()=>document.querySelector('[data-batch-state]')?.textContent.includes('10 / 30'));
    await batchPanel.getByText('Attente de ressources observables',{exact:false}).waitFor();
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),callsBefore+2);
    await batchPanel.getByRole('button',{name:'Mettre la session en pause',exact:true}).click();
    await page.locator('[data-batch-state="paused"]').waitFor();
    await reader.evaluate(()=>{
      currentEnergy=90; // A separate, explicit fixture response; no regeneration assumption.
      syncWorker.postMessage({type:'sync-delta'});
      for(const fn of fixtureEnergyListeners)fn({data:{ok:true,userData:{energy:20,colors:'0,16777215'}}});
    });
    await batchPanel.getByRole('button',{name:'Reprendre la session autorisée',exact:true}).click();
    await page.locator('[data-batch-state="completed"]').waitFor();
    const continuous=await api('connector/status',undefined,'GET');
    assert.equal(continuous.batch.confirmed,30);assert.equal(continuous.batch.acceptedRequests,6);
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),callsBefore+6);
    const actual=await reader.evaluate(()=>globalThis.fixtureWrites);
    // The fixture's existing fetch mock retains the last request only.
    assert.ok(actual.every(p=>p.GridX>=1001&&p.GridX<1011&&p.GridY<=998&&p.GridY>988));
    assert.ok(continuous.batch.targets.every(p=>p.x>=1001&&p.x<1011&&p.y<=998&&p.y>988));
    assert.equal(new Set(continuous.batch.targets.map(p=>p.x+','+p.y)).size,30);
    assert.equal(continuous.progress.correct,0); // ACK never mutates the cache.
    record('OK continuous 20x20 model: rectangle preview, one approval, native-energy wait, 30 unique targets in six groups <=5, pause/resume, bounded stop; no real service requests');
    await page.screenshot({path:path.join(out,'continuous-dashboard-local-fixture.png'),fullPage:true});
    await page.getByRole('button',{name:'Révoquer le canal',exact:true}).click();

    // Default simple workflow: genuine PNG import/hash match, no manual binding or monitor start.
    await page.getByLabel('Réglages avancés',{exact:true}).uncheck();
    const simple=page.locator('#simpleDrawing');
    await simple.getByLabel('Image à dessiner',{exact:true}).setInputFiles(path.join(repo,'public/fixtures/geoplacer-20x20.png'));
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    await simple.getByText('Options du dessin',{exact:true}).click();
    await simple.getByLabel('Mode énergétique',{exact:true}).selectOption('continuous');
    await simple.getByLabel('Budget du dessin',{exact:true}).fill('20');
    await simple.locator('#drawingImportNotice').filter({hasText:/^Image importée :/}).waitFor();
    await reader.evaluate(()=>{
      currentEnergy=100;globalThis.fixtureWrites=[];
      // Start a fresh native evidence stream. Its first response arrives after launch.
      syncWorker={postMessage(){},addEventListener(type,fn){if(type==='message')fixtureEnergyListeners.add(fn);},removeEventListener(type,fn){if(type==='message')fixtureEnergyListeners.delete(fn);}};
      const paint=globalThis.fetch;
      globalThis.holdNextFixtureGroup=true;
      globalThis.fetch=async(url,options)=>{
        if(url==='/GetUserData')return new Response(null,{status:503});
        if(url===location.origin+'/PlacePixels' && holdNextFixtureGroup){
          globalThis.holdNextFixtureGroup=false;
          await new Promise(resolve=>globalThis.releaseFixtureGroup=resolve);
        }
        return paint(url,options);
      };
    });
    await pair(); // Auto-observation after approved coupling must match the imported PNG hash.
    await simple.getByRole('button',{name:'Lancer le dessin',exact:true}).waitFor();
    await page.waitForFunction(()=>![...document.querySelectorAll('#simpleDrawing button')].find(b=>b.textContent==='Lancer le dessin')?.disabled);
    const nav = page.getByRole('navigation', {name:'Navigation principale'});
    await nav.getByRole('link',{name:'File de travail',exact:true}).click();
    await page.getByRole('heading',{name:'Travail courant',exact:true}).waitFor();
    await nav.getByRole('link',{name:'Modes de dessin',exact:true}).click();
    const bottomMode = page.getByRole('article').filter({has:page.getByRole('heading',{name:'Bas vers haut',exact:true})});
    await bottomMode.getByRole('button',{name:'Choisir bas vers haut',exact:true}).click();
    await bottomMode.getByRole('button',{name:'Mode sélectionné',exact:true}).waitFor();
    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    await page.waitForFunction(()=>![...document.querySelectorAll('#simpleDrawing button')].find(b=>b.textContent==='Lancer le dessin')?.disabled);
    const beforeSimple=await reader.evaluate(()=>globalThis.fixtureSiteCalls);
    await simple.getByRole('button',{name:'Lancer le dessin',exact:true}).click();
    await simple.getByText('En attente d’une lecture d’énergie GeoPixels.',{exact:true}).waitFor();
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),beforeSimple);
    await reader.evaluate(()=>{
      syncWorker.postMessage({type:'sync-delta'});
      for(const fn of fixtureEnergyListeners)fn({data:{ok:true,userData:{energy:0,colors:'0,16777215'}}});
    });
    await simple.getByText('En attente de recharge. Énergie exploitable : 0.',{exact:true}).waitFor();
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),beforeSimple);
    await reader.evaluate(()=>{
      syncWorker.postMessage({type:'sync-delta'});
      for(const fn of fixtureEnergyListeners)fn({data:{ok:true,userData:{energy:0,colors:'0,16777215',checkedTick:Math.floor(Date.now()/1000)-3600,energyRate:30,maxEnergy:100}}});
    });
    await reader.waitForFunction(()=>typeof globalThis.releaseFixtureGroup==='function');
    await nav.getByRole('link',{name:'File de travail',exact:true}).click();
    await page.getByRole('heading',{name:'Groupe transmis au lecteur',exact:true}).waitFor();
    await page.getByText('16 cibles · Résultat attendu',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'file-de-travail.png'),fullPage:true});
    await reader.evaluate(()=>globalThis.releaseFixtureGroup());
    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    await simple.getByText('Envois terminés — vérifier les observations',{exact:true}).waitFor();
    const autonomous=await api('connector/status',undefined,'GET');
    assert.equal(autonomous.batch.execution,'autonomous');assert.equal(autonomous.batch.confirmed,20);
    assert.equal(autonomous.batch.acceptedRequests,2);assert.equal(autonomous.monitoring.state,'stopped');
    assert.equal(await reader.evaluate(()=>globalThis.fixtureSiteCalls),beforeSimple+2);
    assert.equal(autonomous.batch.scope.strategy,'bottom-to-top');
    assert.equal(await reader.evaluate(()=>globalThis.fixtureWrites[0].GridY),982);
    assert.equal(new Set((await reader.evaluate(()=>globalThis.fixtureWrites)).map(p=>p.GridX+','+p.GridY)).size,20);
    assert.equal(autonomous.progress.correct,0); // Acceptances are not synthesized into observations.
    await page.screenshot({path:path.join(out,'simple-drawing-local-fixture.png'),fullPage:true});
    await nav.getByRole('link',{name:'Mes dessins',exact:true}).click();
    await page.getByText('20 cibles acquittées dans le journal GeoPixels',{exact:true}).first().waitFor();
    const oldDrawing = page.getByRole('article').filter({has:page.getByRole('heading',{name:'LOCAL FIXTURE — continuous 20 × 20',exact:true})});
    await oldDrawing.getByRole('button',{name:'Retirer',exact:true}).click();
    const remove = oldDrawing.getByRole('button',{name:'Confirmer le retrait',exact:true});
    assert.equal(await remove.isDisabled(),true);
    await oldDrawing.getByLabel('Nom exact du dessin').fill('LOCAL FIXTURE — continuous 20 × 20');
    await remove.click();
    await oldDrawing.waitFor({state:'detached'});
    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    record('OK saved strategy changes actual group order, queue shows a reserved in-flight group, gallery shows durable ACKs and confirms removal by exact name');
    record('OK DEFAULT simple workflow: missing then zero balance, native recharge checkpoint unlocks 20 targets / two adaptive groups, no service requests');
    await page.getByRole('button',{name:'Révoquer le canal',exact:true}).click();

    await page.locator('#connectorConnection').filter({hasText:/^D\u00e9connect\u00e9$/}).waitFor();

    // Optional upgrades: actual dashboard + capability routes + generated browser code.
    // BOTH native endpoints are local stubs. No GeoPixels request is permitted by this recipe.
    await reader.evaluate(()=>{
      ghostImageTopLeft={...ghostImageTopLeft,gridX:ghostImageTopLeft.gridX+40};
      globalThis.MakePurchase=function(){return '/MakePurchase UserId Subject';};
      for(const [id,price] of [['EnergyInput','10 Pixels / +20 energy'],['EnergyCapacityInput','50 Pixels / +5 max'],['FasterRechargeInput','500 Pixels / -1s (cap at 15s)'],['ExtraColorInput','100 Pixels / Any hex color allowed']]) {
        const card=document.createElement('div'),label=document.createElement('p'),row=document.createElement('div'),input=document.createElement('input');
        input.id=id;label.textContent=price;row.append(input);card.append(label,row);card.hidden=true;document.body.append(card);
      }
      globalThis.fixturePurchaseCalls=0;globalThis.fixtureShopBalance={energy:0,colors:'0,16777215',pixels:500,maxEnergy:100,energyRate:20,checkedTick:Math.floor(Date.now()/1000)};
      const paint=globalThis.fetch;
      globalThis.fetch=async(url,options)=>{
        if(url==='/GetUserData')return new Response(JSON.stringify(fixtureShopBalance),{status:200});
        if(url==='/MakePurchase') {
          const b=JSON.parse(options.body);
          if(b.type!=='Energy'||b.amount!==1)throw new Error('Unexpected fixture purchase');
          fixturePurchaseCalls++;fixtureShopBalance.energy+=20;fixtureShopBalance.pixels-=50;
          return new Response('fixture accepted',{status:200});
        }
        const response=await paint(url,options);
        if(response.ok)fixtureShopBalance.energy-=JSON.parse(options.body).Pixels.length;
        return response;
      };
    });
    if (!(await simple.getByLabel('Mode énergétique',{exact:true}).isVisible())) {
      await simple.getByText('Options du dessin',{exact:true}).click();
    }
    await simple.getByLabel('Mode énergétique',{exact:true}).selectOption('bursts');
    await simple.getByLabel('Démarrage (énergies)',{exact:true}).fill('20');
    await simple.getByLabel('Reprise (énergies)',{exact:true}).fill('20');
    await simple.getByLabel('Budget des améliorations',{exact:true}).selectOption('unlimited');
    await pair();
    await reader.evaluate(()=>{
      syncWorker.postMessage({type:'sync-delta'});
      for(const fn of fixtureEnergyListeners)fn({data:{ok:true,userData:{...fixtureShopBalance}}});
    });
    await page.waitForFunction(()=>![...document.querySelectorAll('#simpleDrawing button')].find(b=>b.textContent==='Lancer le dessin')?.disabled);
    await simple.getByRole('button',{name:'Lancer le dessin',exact:true}).click();
    await simple.getByText('Envois terminés — vérifier les observations',{exact:true}).waitFor();
    const upgraded=await api('connector/status',undefined,'GET');
    assert.equal(upgraded.batch.confirmed,20);assert.equal(upgraded.upgrades.history.at(-1).state,'verified');
    assert.equal(upgraded.batch.scope.upgrades.maxBudget,null);
    assert.equal(upgraded.batch.scope.upgrades.minimumReserve,0);
    assert.equal(await reader.evaluate(()=>fixturePurchaseCalls),1);assert.equal(upgraded.upgrades.uncertain,0);
    await page.screenshot({path:path.join(out,'automatic-upgrade-local-fixture.png'),fullPage:true});
    await nav.getByRole('link',{name:'Ressources et améliorations',exact:true}).click();
    await page.getByRole('cell',{name:'Effet et débit observés',exact:true}).waitFor();
    for(const name of ['Recharge d’énergie','Capacité énergétique','Vitesse de recharge','Déblocage de couleur']) {
      await page.getByRole('heading',{name,exact:true}).waitFor();
    }
    await page.screenshot({path:path.join(out,'ressources.png'),fullPage:true});
    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    record('OK unlimited upgrades with zero reserve: a stub recharge is verified while bursts wait, crossed threshold then draws 20 targets; no external requests');

    // The account palette changes only after a native fixture observation, independently of the user's fallback.
    const palettePanel = simple.locator('.drawing-options-palette');
    if (!(await palettePanel.isVisible())) await simple.getByText('Options du dessin',{exact:true}).click();
    await palettePanel.getByText('Palette',{exact:true}).click();
    await palettePanel.getByText('2 couleurs disponibles sur le compte.',{exact:false}).waitFor();
    await palettePanel.getByText('Couleurs du compte',{exact:true}).click();
    const unavailable = palettePanel.getByRole('list',{name:'Couleurs du préréglage communautaire indisponibles sur le compte'});
    await unavailable.locator('[title="#FF9F1C"]').waitFor();
    const displayedPalette = palettePanel.getByLabel('Palette locale (#RRGGBB)',{exact:true});
    await palettePanel.getByText('Palette manuelle conservée',{exact:true}).click();
    const manualPalette = palettePanel.getByLabel('Codes de la palette manuelle',{exact:true});
    await manualPalette.fill('#ffffff');
    const nativeColors = [0, 0xffffff, 0xff9f1c, ...Array.from({length:31}, (_, index) => index + 1)];
    const expectedPalette = nativeColors.map(value => '#' + value.toString(16).padStart(6,'0')).join('\n');
    await reader.evaluate(colors => {
      Colors.push('#00000000'); // The page adds transparency separately from account RGB values.
      fixtureShopBalance.colors = [...colors, 0xff9f1c].join(',');
      syncWorker.postMessage({type:'sync-delta'});
      for (const listener of fixtureEnergyListeners) listener({data:{ok:true,userData:{...fixtureShopBalance}}});
    }, nativeColors);
    await palettePanel.getByText('34 couleurs disponibles sur le compte.',{exact:false}).waitFor();
    const extra = palettePanel.getByRole('list',{name:'Couleurs supplémentaires disponibles'});
    await extra.locator('[title="#FF9F1C"]').waitFor();
    assert.equal(await unavailable.locator('[title="#FF9F1C"]').count(),0);
    assert.equal(await manualPalette.inputValue(),'#ffffff');
    assert.equal(await displayedPalette.inputValue(),expectedPalette);
    const orange = new PNG({width: 1, height: 1});
    Buffer.from([255, 159, 28, 255]).copy(orange.data);
    await simple.getByLabel('Image à dessiner',{exact:true}).setInputFiles({name:'palette-orange.png',mimeType:'image/png',buffer:PNG.sync.write(orange)});
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    await simple.locator('#drawingImportNotice').filter({hasText:/Image importée : palette-orange/}).waitFor();
    const { selection } = await api('connector/status',undefined,'GET');
    const prepared = await page.request.get(`${base}/api/v1/connector/drawing/${selection.templateId}/image`);
    assert.equal(prepared.ok(),true);
    assert.deepEqual([...PNG.sync.read(await prepared.body()).data],[255,159,28,255]);
    const ghostPage = await page.context().newPage();
    try {
      await ghostPage.goto(`${base}/geopixels`);
      await ghostPage.locator('#ghostPaletteMode').selectOption('account');
      await ghostPage.getByText('34 couleurs disponibles sur le compte.',{exact:false}).waitFor();
      assert.match(await ghostPage.locator('#ghostPalette').inputValue(), /#ff9f1c/);
    } finally {
      await ghostPage.close();
    }
    await page.getByRole('button',{name:'Révoquer le canal',exact:true}).click();
    await palettePanel.getByText(/34 couleurs dans la dernière palette connue\. Disponibilité actuelle non vérifiée/).waitFor();
    assert.equal(await displayedPalette.inputValue(),expectedPalette);
    assert.equal(await manualPalette.inputValue(),'#ffffff');
    const manualMode = palettePanel.getByLabel('Utiliser la palette manuelle dans cette configuration',{exact:true});
    await manualMode.check();
    assert.equal(await displayedPalette.inputValue(),'#ffffff');
    await manualMode.uncheck();
    assert.equal(await displayedPalette.inputValue(),expectedPalette);
    record('OK native palette is deduplicated, stays visible unverified after revocation, and the separate manual list can be restored');

    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    writeFileSync(
      path.join(out, 'http-metrics.json'),
      JSON.stringify(
        {
          fixture: true,
          extension: 'GM API simulated by Node; not Tampermonkey',
          pixels: 40,
          opaque: 38,
          roundTripsMs: timings,
          dashboardLatencyMs,
          noExternalRequests: true,
        },
        null,
        2
      )
    );
  } catch (error) {
    writeFileSync(path.join(out, 'http-failure-diagnostic.json'), JSON.stringify({
      fixture: true, error: String(error), state: await api('connector/status', undefined, 'GET').catch(()=>null),
      reader: await reader.locator('aside').textContent().catch(()=>null),
      dashboardAlerts: await page.getByRole('alert').allTextContents().catch(()=>[]), managementResponses, pageErrors: errors
    },null,2));
    throw error;
  } finally {
    page.off('response',trace);
    await context.close();
  }
}
