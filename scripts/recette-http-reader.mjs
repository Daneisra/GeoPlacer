/** Browser CSP/GM contract fixture. GM requests are simulated by Node, not a real extension. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function runHttpReaderRecipe({ browser, page, api, base, approvalKey, repo, out, record }) {
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
  } finally {
    await context.close();
  }
}
