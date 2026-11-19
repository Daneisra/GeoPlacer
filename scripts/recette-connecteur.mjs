import { randomBytes } from 'node:crypto';
import { runHttpReaderRecipe } from './recette-http-reader.mjs';
/** Local browser acceptance only. Every non-loopback request is aborted. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'test-logs/phase2a/browser');
const importOnly=process.argv.includes('--import-only');
const studioOnly=process.argv.includes('--studio-only');
mkdirSync(out, { recursive: true });
// Independent acceptance scenarios: do not exhaust the production 300/min management
// budget with the preceding simulator stress workflow, or weaken that protection.
if (!importOnly && !studioOnly && !process.argv.includes('--fake-only') && !process.argv.includes('--http-only')) {
  for (const part of ['fake', 'http']) {
    const code = await new Promise(resolve => {
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),path.join(out,part),`--${part}-only`],{
        env:process.env,stdio:'inherit',windowsHide:true
      });
      child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));
    });
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}
const require = createRequire(import.meta.url);
const pw = require(process.env.GEOPLACER_PLAYWRIGHT_CORE);
const { PNG } = createRequire(path.join(repo, 'package.json'))('pngjs');
const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-phase2a-browser-'));
const base = 'http://127.0.0.1:3919';
const log = [];
const approvalKey = randomBytes(32).toString('hex');
const record = (message) => {
  log.push(message);
  console.log(message);
};
const server = spawn(process.execPath, [path.join(repo, 'dist/server.js')], {
  cwd: work,
  env: {
    ...process.env,
    PORT: '3919',
    GEOPLACER_READER_APPROVAL_KEY: approvalKey,
    HOST: '127.0.0.1',
    GEOPLACER_ENGINE_DIR: path.join(work, 'engine'),
    GEOPLACER_BACKUP_DIR: path.join(work, 'backups'),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + '/api/v1/engine/status')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const api = async (url, body, method = 'POST') => {
    const response = await fetch(base + '/api/v1/' + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      png.data[i + 3] = (x + y) % 7 === 0 ? 0 : 255;
    }
  const imported = await api('templates', {
    name: 'Phase 2A — modèle factice 64 × 64',
    pngBase64: PNG.sync.write(png).toString('base64'),
    x: 0,
    y: 0,
    strategy: 'top-to-bottom',
  });
  await api('engine/selection', { templateId: imported.templateId }, 'PUT');
  const engineName = process.env.GEOPLACER_BROWSER_ENGINE === 'firefox' ? 'firefox' : 'chromium';
  browser = await pw[engineName].launch({
    headless: true,
    ...(engineName === 'chromium' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}),
  });
  const context = await browser.newContext();
  const external = [];
  const errors = [];
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
    external.push(u.origin);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(base);
  if (studioOnly) {
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await page.getByRole('heading', { name: 'Tableau de bord', exact: true }).waitFor();
    await page.locator('#simCanvas').waitFor();
    await page.screenshot({path:path.join(out,'simulation.png'),fullPage:true});

    await nav.getByRole('link', { name:'Modes de dessin', exact:true }).click();
    await page.getByRole('heading', { name:'Modes de dessin', exact:true }).waitFor();
    assert.equal(await page.getByRole('link',{name:'Utiliser en simulation',exact:true}).count(),8);
    await page.screenshot({path:path.join(out,'modes.png'),fullPage:true});
    await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Contours d’abord',exact:true})}).getByRole('link').click();
    await page.getByRole('heading', { name:'Mes dessins', exact:true }).waitFor();
    assert.equal(await page.getByLabel('Stratégie du modèle',{exact:true}).inputValue(),'outline-first');
    const thumbnail = page.getByRole('img', {name:/Aperçu de Phase 2A/});
    await thumbnail.waitFor();
    await page.waitForFunction(() => [...document.images].some(img => img.alt.startsWith('Aperçu de Phase 2A') && img.complete && img.naturalWidth === 64));
    await page.screenshot({path:path.join(out,'dessins.png'),fullPage:true});

    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    await page.getByRole('button',{name:'Ouvrir le connecteur',exact:true}).click();
    const simple=page.locator('#simpleDrawing');
    await simple.getByLabel('Image à dessiner',{exact:true}).setInputFiles(path.join(repo,'public/fixtures/geoplacer-20x20.png'));
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    await simple.locator('#drawingImportNotice').filter({hasText:/Image importée.*20 × 20/}).waitFor();
    assert.equal(await simple.getByRole('button',{name:'Lancer le dessin',exact:true}).isDisabled(), true);
    await page.screenshot({path:path.join(out,'dashboard.png'),fullPage:true});

    const statusUrl = '**/api/v1/connector/status';
    const expiredCapture = async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      const capturedAt = Date.now() - 35_000;
      await route.fulfill({ response, json: {
        ...state, lastSync: capturedAt, captureExpired: true,
        lastCompleteProgress: { capturedAt, total: 400, correct: 24, incorrect: 376, unknown: 0 },
        progress: { total: 400, correct: 0, incorrect: 0, unknown: 400 },
      } });
    };
    await page.route(statusUrl, expiredCapture);
    await simple.getByRole('heading',{name:'Dernière capture complète',exact:true}).waitFor();
    assert.equal(await simple.locator('[data-count="correct"]').last().textContent(),'24');
    await simple.getByText(/Couverture exploitable actuellement : 0 cibles/).waitFor();
    await page.screenshot({path:path.join(out,'capture-expiree.png'),fullPage:true});
    await page.unroute(statusUrl, expiredCapture);
    record('OK historical capture stays visible when operational coverage expires');

    await nav.getByRole('link',{name:'Ressources et améliorations',exact:true}).click();
    await page.getByText('Ressources indisponibles.',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'ressources.png'),fullPage:true});
    await page.getByLabel('Budget des améliorations',{exact:true}).selectOption('limited');
    await page.getByLabel('Budget maximal de monnaie',{exact:true}).fill('10');
    await nav.getByRole('link',{name:'File de travail',exact:true}).click();
    await page.getByRole('heading',{name:'Travail courant',exact:true}).waitFor();
    await nav.getByRole('link',{name:'Journal',exact:true}).click();
    await page.locator('#logsViewer').getByText('Connecté',{exact:true}).waitFor();
    await nav.getByRole('link',{name:'Diagnostics',exact:true}).click();
    await page.getByLabel('Clé locale d’approbation',{exact:true}).fill(approvalKey);
    await nav.getByRole('link',{name:'Paramètres',exact:true}).click();
    assert.equal(await page.getByLabel('Budget maximal de monnaie',{exact:true}).inputValue(),'10');
    await nav.getByRole('link',{name:'Tableau de bord',exact:true}).click();
    assert.notEqual(await page.getByLabel('Clé locale d’approbation',{exact:true}).inputValue(),'');
    await page.getByLabel('Clé locale d’approbation',{exact:true}).fill('');

    for (const width of [1024, 390]) {
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.screenshot({path:path.join(out,`dashboard-${width}.png`),fullPage:true});
    }
    const menu = page.getByRole('button',{name:'Menu',exact:true});
    await menu.click();
    await nav.getByRole('link',{name:'File de travail',exact:true}).click();
    assert.equal(await menu.getAttribute('aria-expanded'),'false');
    await page.getByRole('heading',{name:'Travail courant',exact:true}).waitFor();
    const state = await api('connector/status',undefined,'GET');
    assert.equal(state.connected,false);
    assert.equal(state.batch.confirmed,0);
    record('OK 8 pages, strategy import, gallery PNG, simple import, live journal, settings preserved across navigation, responsive layout (1024/390 px), no sends');
  }
  if(importOnly){
    await page.getByLabel('Source de toile').selectOption('geopixels');
    const simple=page.locator('#simpleDrawing'),notice=simple.locator('#drawingImportNotice');
    await simple.getByLabel('Image à dessiner',{exact:true}).setInputFiles(path.join(repo,'public/fixtures/geoplacer-20x20.png'));
    const url='**/api/v1/connector/drawing/import',refusal='Arrêter le dessin en cours avant d’importer une autre image.';
    const refuse=route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{message:refusal}})});
    await page.route(url,refuse);
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    await notice.filter({hasText:refusal}).waitFor();assert.equal(await notice.getAttribute('role'),'alert');
    assert.equal(await simple.getByRole('button',{name:'Importer l’image',exact:true}).isEnabled(),true);
    await page.unroute(url,refuse);
    record('OK import rejection remains visible beside the import button, without a false success');
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const hold=async route=>{await gate;await route.continue();};await page.route(url,hold);
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    assert.equal(await simple.getByRole('button',{name:'Importation en cours…',exact:true}).isDisabled(),true);
    await notice.filter({hasText:'Importation de l’image en cours…'}).waitFor();
    release();await notice.filter({hasText:/^Image importée :.*20 × 20/}).waitFor();
    assert.equal(await notice.getAttribute('role'),'status');
    await page.unroute(url,hold);
    const actual=await api('connector/status',undefined,'GET');assert.equal(actual.selection.width,20);assert.equal(actual.selection.height,20);
    assert.equal(actual.connected,false);assert.equal(actual.batch.confirmed,0);assert.equal(actual.batch.uncertain,0);
    assert.equal(await page.getByLabel('Clé locale d’approbation',{exact:true}).inputValue(),'');
    await simple.getByRole('link',{name:'Télécharger le fantôme pour GeoPixels',exact:true}).waitFor();
    record('OK real local import WITHOUT pairing/key: progress feedback, success with dimensions, selected model and downloadable PNG, zero placements');
    const missing=route=>route.fulfill({status:404,contentType:'application/json',body:'{}'});await page.route(url,missing);
    await simple.getByRole('button',{name:'Importer l’image',exact:true}).click();
    await notice.filter({hasText:/serveur doit être redémarré/}).waitFor();
    assert.equal(await notice.getAttribute('role'),'alert');await page.unroute(url,missing);
    assert.equal((await api('connector/status',undefined,'GET')).selection.templateId,actual.selection.templateId);
    record('OK stale server response gives an explicit restart instruction; existing imported model preserved');
    await page.screenshot({path:path.join(out,'import-local-regression.png'),fullPage:true});
  }
  if (!importOnly && !studioOnly && !process.argv.includes('--http-only')) {
  await page.getByLabel('Source de toile').selectOption('geopixels');
  await page.locator('#connectorDashboard').waitFor();
  await page.getByLabel('Réglages avancés',{exact:true}).check();
  await page.getByRole('button', { name: 'Coupler un navigateur factice' }).click();
  const capability = await page.getByLabel('Code de couplage', { exact: true }).inputValue();
  assert.match(capability, /^[0-9a-f]{64}$/);
  const fixture = await context.newPage();
  await fixture.goto(base + '/connector-fixture.html');
  await fixture.locator('#load').click();
  const nativeProbe = await fixture.evaluate(() => {
    const bitmap = document.createElement('canvas');
    bitmap.width = 1000;
    bitmap.height = 1000;
    const ctx = bitmap.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(999, 999, 1, 1);
    return GeoPlacerCapture.readRegion(
      { gridX: -1, gridY: 1000, width: 2, height: 2 },
      { x: -1, y: 999, width: 2, height: 2 },
      new Map([['-1000,0', { colorBitmap: bitmap }]]),
      (w, h) => new OffscreenCanvas(w, h)
    );
  });
  assert.deepEqual(nativeProbe, [0xff0000, -2, -2, -2]);
  record('OK actual browser cache reader at tile edges and missing tiles');
  await fixture.locator('#capability').fill(capability);
  await fixture.locator('#connect').click();
  await page
    .locator('#connectorConnection')
    .filter({ hasText: /^Connecté$/ })
    .waitFor();
  // Transport connection can precede the first observation; wait for the observed project.
  await page.getByText('Modèle du navigateur : 64 × 64, origine (-1001, 1001)', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Lier ce modèle' }).click();
  await page.getByText('Modèle lié ✓', { exact: true }).waitFor();
  record('OK controlled pairing, model binding, native negative coordinates');
  await page.getByRole('button', { name: 'Démarrer le fournisseur factice' }).click();
  await page.locator('#connectorState[data-state=completed]').waitFor({ timeout: 120_000 });
  assert.equal((await page.locator('#observedIncorrect').textContent()).trim(), '0');
  assert.equal((await page.locator('#observedUnknown').textContent()).trim(), '0');
  record('OK 64 x 64 planning, transparent pixels excluded, browser execution, zero incorrect/unknown');
  await page.screenshot({ path: path.join(out, 'dashboard-completed.png'), fullPage: true });
  await fixture.screenshot({ path: path.join(out, 'browser-fixture.png'), fullPage: true });
  const operationCount = JSON.parse(await fixture.locator('#details').textContent()).operations;
  assert.ok(operationCount > 0);
  await fixture.reload();
  await fixture.locator('#load').click();
  await fixture.waitForFunction(() => JSON.parse(document.querySelector('#details').textContent || '{}').operations > 0);
  assert.equal(JSON.parse(await fixture.locator('#details').textContent()).operations, operationCount);
  await page
    .locator('#connectorConnection')
    .filter({ hasText: /^Déconnecté$/ })
    .waitFor();
  await page.getByRole('button', { name: 'Coupler un navigateur factice' }).click();
  await page.waitForFunction((previous) => {
    const input = document.querySelector('input[aria-label="Code de couplage"]');
    return input && input.value.length === 64 && input.value !== previous;
  }, capability);
  const nextCapability = await page.getByLabel('Code de couplage', { exact: true }).inputValue();
  await fixture.locator('#capability').fill(nextCapability);
  await fixture.locator('#connect').click();
  await page
    .locator('#connectorConnection')
    .filter({ hasText: /^Connecté$/ })
    .waitFor();
  await page.getByText('Modèle du navigateur : 64 × 64, origine (-1001, 1001)', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Lier ce modèle' }).click();
  await page.getByText('Modèle lié ✓', { exact: true }).waitFor();
  assert.equal((await page.locator('#observedIncorrect').textContent()).trim(), '0');
  record('OK browser reload preserves durable fake pixels and operation results');
  await fixture.locator('#damage').click();
  await fixture.locator('#observe').click();
  await page.waitForFunction(() => Number(document.querySelector('#observedIncorrect').textContent.replace(/\s/g, '')) > 0);
  record('OK external canvas modification observed');
  await page.getByRole('button', { name: 'Démarrer le fournisseur factice' }).click();
  await page.locator('#connectorState[data-state=completed]').waitFor({ timeout: 30_000 });
  const details = page.locator('details').filter({ has: page.getByText('Politique d’améliorations — propositions factices', { exact: true }) });
  await details.locator('summary').click();
  await page.getByRole('button', { name: 'Calculer les propositions' }).click();
  await details.locator('li').first().waitFor();
  record('OK policy costs/benefits and explicit non-executable proposals');
  await page.getByRole('button', { name: 'Révoquer le canal' }).click();
  await page
    .locator('#connectorConnection')
    .filter({ hasText: /^Déconnecté$/ })
    .waitFor();
  await page.getByLabel('Source de toile').selectOption('simulation');
  await page.locator('#simulationDashboard').waitFor();
  record('OK revocation and return to existing simulation dashboard');
  await api('simulator/settings', { simulator: { width: 2048, height: 2048 }, resetWorld: true }, 'PUT');
  for (const [width, height] of [
    [595, 894],
    [2000, 2000],
  ]) {
    const large = new PNG({ width, height });
    for (let i = 3; i < large.data.length; i += 4) large.data[i] = 255;
    const local = await api('templates', {
      name: `Storage ${width} x ${height}`,
      pngBase64: PNG.sync.write(large).toString('base64'),
      x: 0,
      y: 0,
      strategy: 'top-to-bottom',
    });
    await api('engine/selection', { templateId: local.templateId }, 'PUT');
    await fixture.reload();
    await fixture.locator('#load').click();
    await fixture.waitForFunction((w) => JSON.parse(document.querySelector('#details').textContent || '{}').project?.width === w, width);
    await fixture.reload();
    await fixture.locator('#load').click();
    await fixture.waitForFunction((w) => JSON.parse(document.querySelector('#details').textContent || '{}').project?.width === w, width);
    const stored = await fixture.evaluate(async (id) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('geoplacer-fixture-v1', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = reject;
      });
      return new Promise((resolve, reject) => {
        const r = db.transaction('worlds', 'readonly').objectStore('worlds').get(`geoplacer.fixture.v1.${id}.1`);
        r.onsuccess = () => resolve(r.result?.pixels.length);
        r.onerror = reject;
      });
    }, local.templateId);
    assert.equal(stored, width * height);
    record(`OK browser fixture stores and reloads ${width} x ${height} without placement`);
  }
  }
  if (!importOnly && !studioOnly && !process.argv.includes('--fake-only'))
    await runHttpReaderRecipe({ browser, page, api, base, approvalKey, repo, out, record });
  assert.equal(external.length, 0, JSON.stringify(external));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  record(`OK ${engineName}, no page errors, no external requests`);
} catch (error) {
  record('FAIL ' + error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  writeFileSync(path.join(out, 'server.log'), serverLog);
  writeFileSync(path.join(out, 'recipe.log'), log.join('\n') + '\n');
  writeFileSync(
    path.join(out, 'environment.json'),
    JSON.stringify(
      { work, head: process.env.GEOPLACER_TEST_HEAD ?? 'working tree', browser: process.env.GEOPLACER_BROWSER_ENGINE ?? 'edge' },
      null,
      2
    )
  );
}
