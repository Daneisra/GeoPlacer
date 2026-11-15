/**
 * Phase 1B.9 measurement: a long run at DEFAULT settings with two tabs (rate limiter, waiting for
 * energy, browser fluidity), then the browser on a 2000 x 2000 template. Compiled server in a
 * temporary directory (the repository's data\ is never touched); results in <out>/long-run.json.
 *
 *   $env:GEOPLACER_PLAYWRIGHT_CORE="<dir>\node_modules\playwright-core"   (installed outside the repo)
 *   npm run build
 *   node scripts/mesure-longue-simulation.mjs <out dir> [seconds, default 150]   # port 3918 free
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, secondsArg] = process.argv.slice(2);
const out = path.resolve(outArg ?? 'mesure-longue');
const pw = process.env.GEOPLACER_PLAYWRIGHT_CORE;
if (!pw) throw new Error('set GEOPLACER_PLAYWRIGHT_CORE to a playwright-core directory (installed outside the repository)');
const browserPath = [process.env.GEOPLACER_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('no Edge or Chrome found (set GEOPLACER_BROWSER)');
const SECONDS = Number(secondsArg ?? 150);
const { chromium } = createRequire(import.meta.url)(pw);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-long-'));
const PORT = 3918;
const base = `http://127.0.0.1:${PORT}`;
const result = {};

const server = spawn(process.execPath, [path.join(repo, 'dist', 'server.js')], { cwd: work, env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
await new Promise((resolve, reject) => {
  server.stdout.on('data', (c) => {
    serverOut += c;
    if (/Server started successfully/.test(serverOut)) resolve();
  });
  server.stderr.on('data', (c) => (serverOut += c));
  server.on('exit', (code) => reject(new Error(`server exited ${code}: ${serverOut}`)));
});

function png(w, h) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  const colors = [[0xed, 0x1c, 0x24], [0x00, 0xa2, 0xe8], [0xff, 0xf2, 0x00], [0x22, 0xb1, 0x4c], [0xff, 0xff, 0xff]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      const [r, g, b] = colors[((x >> 4) + (y >> 4)) % colors.length];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const api = async (method, p, body) => {
  const r = await fetch(`${base}/api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${PORT}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
try {
  // Phase 1: default settings, 350 x 350 template.
  const imp = await api('POST', '/templates', { name: 'Long', pngBase64: png(350, 350), x: 10, y: 10, strategy: 'top-to-bottom' });
  await api('PUT', '/engine/selection', { templateId: imp.body.templateId });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage();
    const stats = { requests: 0, rateLimited: 0, failed: [], console: [], wsMessages: 0 };
    page.on('request', (r) => r.url().startsWith(base) && !r.url().includes('/assets/') && stats.requests++);
    page.on('response', (r) => r.status() === 429 && stats.rateLimited++);
    page.on('requestfailed', (r) => stats.failed.push(r.url()));
    page.on('console', (m) => m.type() === 'error' && stats.console.push(m.text()));
    page.on('websocket', (ws) => ws.url().includes('/api/v1/ws') && ws.on('framereceived', () => stats.wsMessages++));
    await page.goto(`${base}/`);
    await page.evaluate(() => {
      window.__long = { count: 0, total: 0, max: 0 };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          window.__long.count++;
          window.__long.total += e.duration;
          window.__long.max = Math.max(window.__long.max, e.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    });
    tabs.push({ page, stats });
  }
  await tabs[0].page.getByRole('button', { name: 'Démarrer' }).click();
  const states = new Set();
  const t0 = Date.now();
  for (const t of tabs) t.stats.requests = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    states.add(await tabs[0].page.locator('#engineState').innerText());
    await tabs[0].page.waitForTimeout(1000);
  }
  const minutes = (Date.now() - t0) / 60000;
  const status = (await api('GET', '/engine/status')).body;
  result.phase1 = {
    seconds: SECONDS,
    statesSeen: [...states],
    applied: status.scheduler?.applied,
    progressPercent: status.scheduler?.progressPercent,
    tabs: await Promise.all(
      tabs.map(async (t) => ({
        requestsPerMinute: Math.round(t.stats.requests / minutes),
        rateLimited: t.stats.rateLimited,
        wsMessagesPerSecond: Math.round((t.stats.wsMessages / minutes / 60) * 10) / 10,
        failed: t.stats.failed.length,
        consoleErrors: t.stats.console,
        longTasks: await t.page.evaluate(() => ({ count: window.__long.count, totalMs: Math.round(window.__long.total), maxMs: Math.round(window.__long.max) })),
        heapMiB: await t.page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)),
      }))
    ),
  };
  // Commands still answer during a long run (never rate limited).
  const pause = Date.now();
  await tabs[1].page.getByRole('button', { name: 'Pause' }).click();
  await tabs[1].page.waitForFunction(() => document.querySelector('#engineState')?.textContent === 'En pause', null, { timeout: 10_000 });
  result.phase1.pauseClickToPausedMs = Date.now() - pause;
  await tabs[0].page.waitForFunction(() => document.querySelector('#engineState')?.textContent === 'En pause', null, { timeout: 10_000 });
  result.phase1.otherTabSawPause = true;
  await tabs[1].page.screenshot({ path: path.join(out, 'long-run-tab2.png') });
  await api('POST', '/engine/stop', {});
  await context.close();

  // Phase 2: a 2000 x 2000 template in the browser (canvas 2048 x 2048, abundant energy).
  const cfg = await api('PUT', '/simulator/settings', { simulator: { width: 2048, height: 2048, capacity: 1000000, regenIntervalMs: 3600000, writeLatencyMs: 0 }, agent: { startEnergy: 1000000 }, run: { maxBatchSize: 1000, minBatchSize: 1 }, resetWorld: true });
  result.phase2 = { configure: cfg.status };
  const big = await api('POST', '/templates', { name: 'Grand', pngBase64: png(2000, 2000), x: 0, y: 0, strategy: 'top-to-bottom' });
  await api('PUT', '/engine/selection', { templateId: big.body.templateId });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const loadStart = Date.now();
  await page.goto(`${base}/`);
  await page.waitForFunction(() => /Zone 2000×2000/.test(document.querySelector('#canvasView')?.textContent ?? ''), null, { timeout: 60_000 });
  result.phase2.firstCanvasMs = Date.now() - loadStart;
  await page.evaluate(() => {
    window.__long = { count: 0, total: 0, max: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__long.count++;
        window.__long.total += e.duration;
        window.__long.max = Math.max(window.__long.max, e.duration);
      }
    }).observe({ type: 'longtask' });
  });
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await page.waitForTimeout(20_000);
  const st = (await api('GET', '/engine/status')).body;
  result.phase2.after20s = {
    applied: st.scheduler?.applied,
    longTasks: await page.evaluate(() => ({ count: window.__long.count, totalMs: Math.round(window.__long.total), maxMs: Math.round(window.__long.max) })),
    heapMiB: await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)),
    consoleErrors,
  };
  const clickAt = Date.now();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForFunction(() => document.querySelector('#engineState')?.textContent === 'En pause', null, { timeout: 10_000 });
  result.phase2.pauseClickToPausedMs = Date.now() - clickAt;
  await page.screenshot({ path: path.join(out, 'large-2000.png') });
  await api('POST', '/engine/stop', {});
} catch (error) {
  result.error = String(error);
} finally {
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(path.join(out, 'long-run.json'), JSON.stringify(result, null, 2));
  await browser.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
