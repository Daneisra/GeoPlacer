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
  assert.equal(png.width, 8); assert.equal(png.height, 5);
  const imported = await api('templates', {
    name: 'HTTP contract fixture 8 × 5',
    pngBase64: PNG.sync.write(png).toString('base64'),
    x: 0,
    y: 0,
    strategy: 'top-to-bottom',
  });
  await api('engine/selection', { templateId: imported.templateId }, 'PUT');
  await api('connector/source', { source: 'geopixels' });
  await page.reload();
  await page.getByLabel('Source de toile').selectOption('geopixels');
  await page.getByLabel('Clé locale d’approbation', { exact: true }).fill(approvalKey);
  const context = await browser.newContext();
  const external = [],
    errors = [],
    timings = [];
  const fixtureUrl = 'https://geopixels.net/__geoplacer_contract_fixture__';
  const html = `<!doctype html><html><body><h1>LOCAL CSP FIXTURE — no GeoPixels connection</h1><script>
let ghostImageOriginalData = new ImageData(new Uint8ClampedArray(${JSON.stringify([...png.data])}),8,5);
let ghostImageTopLeft = {gridX:999,gridY:1001}; let ghostActivePaletteColors = new Set();
let tileImageCache = new Map(); let userID='local-fixture-only'; let userData={}; let Colors=['#000000','#ffffff'];
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
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
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
      await reader.getByText('Couplé par HTTP privilégié, en lecture seule', { exact: true }).waitFor();
      reader.off('dialog', handle);
    }
    await pair();
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
    await reader.screenshot({ path: path.join(out, 'http-reader-local-fixture.png'), fullPage: true });
    await page.screenshot({ path: path.join(out, 'http-dashboard-local-fixture.png'), fullPage: true });
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
    record('OK HTTP disconnect, new pairing and live revocation');
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
