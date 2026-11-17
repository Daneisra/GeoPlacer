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
mkdirSync(out, { recursive: true });
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
  if (!process.argv.includes('--http-only')) {
  await page.getByLabel('Source de toile').selectOption('geopixels');
  await page.locator('#connectorDashboard').waitFor();
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
  await page.getByText('Modèle lié', { exact: true }).waitFor();
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
  await page.getByText('Modèle lié', { exact: true }).waitFor();
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
