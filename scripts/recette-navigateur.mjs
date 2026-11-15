#!/usr/bin/env node
/**
 * Automated browser acceptance of the management UI (Phase 1B.7).
 *
 * Drives a REAL browser (Microsoft Edge or Chrome, installed on the
 * machine) through playwright-core, which is NOT a dependency of the
 * project: install it outside the repository, for example
 *
 *   npm install playwright-core@1.49.1 --prefix <dir> --ignore-scripts
 *   $env:GEOPLACER_PLAYWRIGHT_CORE="<dir>\node_modules\playwright-core"
 *   npm run build
 *   node scripts/recette-navigateur.mjs [report.json]
 *
 * The compiled server (dist/server.js) runs in a temporary working
 * directory: its data/ never touches the repository. Port 3000 must be
 * free (the logs WebSocket port is fixed to 3000). No account, no
 * template is created or started; no request leaves the machine.
 *
 * Limits: a real Ctrl+C cannot be sent to a child process on Windows (the
 * stop is abrupt): the graceful shutdown message stays a manual check.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:3000';
const results = [];
const record = (id, check, ok, detail = '') => {
  results.push({ id, check, status: ok === null ? 'INFO' : ok ? 'OK' : 'KO', detail });
  process.stdout.write(`${ok === null ? 'INFO' : ok ? 'OK  ' : 'KO  '} ${id} ${check}${detail ? ` — ${detail}` : ''}\n`);
};

function loadPlaywright() {
  const where = process.env.GEOPLACER_PLAYWRIGHT_CORE;
  const require = createRequire(import.meta.url);
  return require(where ?? 'playwright-core');
}

function findBrowser() {
  const candidates = [
    process.env.GEOPLACER_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('no Edge or Chrome found (set GEOPLACER_BROWSER)');
  return found;
}

/** Starts the compiled server in `cwd`; resolves once it says it listens (explicit synchronisation). */
function startServer(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, 'dist', 'server.js')], {
      cwd,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '3000', NODE_ENV: 'production', GEOPLACER_OPEN_BROWSER: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      const m = /listening on (http:\/\/[^\s]+)/i.exec(out);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, url: m[1], output: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => (out += c.toString()));
    child.on('exit', (code) => reject(new Error(`server exited (${code}) before listening:\n${out}`)));
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.child.removeAllListeners('exit');
    server.child.on('exit', () => resolve());
    server.child.kill('SIGINT'); // abrupt on Windows (no signal delivery)
  });
}

const running = { server: null, browser: null, work: null };

async function main() {
  const reportFile = process.argv[2];
  const { chromium } = loadPlaywright();
  const browserPath = findBrowser();
  const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-recette-'));
  running.work = work;
  let server = await startServer(work);
  running.server = server;
  record('1', 'le serveur compilé démarre', server.url.startsWith(BASE), server.url);

  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  running.browser = browser;
  record('0', 'navigateur', null, `${path.basename(browserPath)} ${browser.version()}`);
  const context = await browser.newContext(); // private: no extension, no stored data
  const consoleErrors = [];
  const failed = [];
  const watch = (page, name) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${name}: [${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`${name}: [pageerror] ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${name}: ${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
    });
  };
  const page = await context.newPage();
  watch(page, 'onglet 1');
  const frames = [];
  page.on('websocket', (ws) => {
    frames.push(`open ${ws.url()}`);
    ws.on('framereceived', (f) => frames.push(String(f.payload)));
  });

  // 2. Interface and connection indicator.
  const settingsPolls = [];
  page.on('response', (r) => {
    if (r.request().method() === 'GET' && new URL(r.url()).pathname === '/settings' && r.request().resourceType() !== 'document') settingsPolls.push(r.status());
  });
  await page.goto(`${BASE}/`);
  await page.waitForSelector('nav, .sidebar, [class*="sidebar"]', { timeout: 15_000 });
  record('2.1', 'le tableau de bord s’affiche', (await page.title()) !== '' && (await page.locator('body').innerText()).length > 0, await page.title());
  await page.waitForResponse((r) => new URL(r.url()).pathname === '/settings' && r.request().resourceType() !== 'document', { timeout: 15_000 });
  record('2.2', 'GET /settings (indicateur de connexion) renvoie 200', settingsPolls.every((s) => s === 200) && settingsPolls.length > 0, `${settingsPolls.length} requête(s)`);

  // 3. Navigation by the side menu.
  const visit = async (href, expectText) => {
    await page.click(`a[href="${href}"]`);
    await page.waitForURL(`${BASE}${href}`);
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    return { ok: expectText.test(text), text: text.slice(0, 80).replace(/\s+/g, ' ') };
  };
  for (const [id, href, re] of [
    ['3.1', '/users', /user/i],
    ['3.2', '/templates', /template/i],
    ['3.4', '/logs', /log/i],
    ['3.5', '/settings', /setting/i],
    ['3.0', '/', /./],
  ]) {
    const r = await visit(href, re);
    record(id, `menu → ${href}`, r.ok, r.text);
  }
  await page.click('a[href="/templates"]');
  await page.waitForURL(`${BASE}/templates`);
  const addButton = page.getByRole('button', { name: /add template/i });
  await addButton.click();
  await page.waitForURL(`${BASE}/templates/add`);
  record('3.3', 'Templates → Add affiche le formulaire (sans créer de modèle)', (await page.locator('form, input').count()) > 0);

  // F12: actions toward routes the server does not have.
  await page.click('a[href="/templates"]');
  await page.waitForURL(`${BASE}/templates`);
  const startAll = page.getByRole('button', { name: /start all/i });
  const startAllShown = (await startAll.count()) > 0 && (await startAll.first().isEnabled());
  if (startAllShown) {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/templates/start-all', { timeout: 5_000 }).catch(() => null);
    await startAll.first().click(); // no template exists: harmless either way
    const r = await response;
    record('F12', '« Start All » n’appelle pas une route absente', r !== null && r.status() < 400, r === null ? 'aucune requête' : `POST /templates/start-all -> ${r.status()}`);
  } else {
    record('F12', '« Start All » n’appelle pas une route absente', true, 'actions désactivées et expliquées dans l’interface');
  }

  // 4. Settings: save, refused value, persistence.
  await page.click('a[href="/settings"]');
  await page.waitForURL(`${BASE}/settings`);
  await page.waitForSelector('#drawingDirectionSelect');
  const openCooldowns = async () => {
    if (!(await page.locator('#accountCooldown').isVisible())) await page.getByText(/cooldown/i).first().click();
    await page.waitForSelector('#accountCooldown', { state: 'visible' });
  };
  await page.selectOption('#drawingDirectionSelect', 'center_out');
  await openCooldowns();
  await page.fill('#accountCooldown', '25');
  let put = page.waitForResponse((r) => new URL(r.url()).pathname === '/settings' && r.request().method() === 'PUT');
  await page.getByRole('button', { name: /save settings/i }).click();
  let r = await put;
  const saved = JSON.parse(readFileSync(path.join(work, 'data', 'settings.json'), 'utf8'));
  record('4.1', 'enregistrer : PUT /settings 200 et fichier écrit', r.status() === 200 && saved.accountCooldown === 25000 && saved.drawingDirection === 'center_out', `PUT -> ${r.status()}, accountCooldown ${saved.accountCooldown}, drawingDirection ${saved.drawingDirection}`);
  record('4.1b', 'notification « Settings Saved »', await page.getByText(/settings saved/i).first().isVisible().catch(() => false));
  await page.fill('#accountCooldown', '5000');
  put = page.waitForResponse((x) => new URL(x.url()).pathname === '/settings' && x.request().method() === 'PUT');
  await page.getByRole('button', { name: /save settings/i }).click();
  r = await put;
  const unchanged = JSON.parse(readFileSync(path.join(work, 'data', 'settings.json'), 'utf8'));
  record('4.2', 'valeur hors bornes refusée (400), fichier inchangé', r.status() === 400 && unchanged.accountCooldown === 25000, `PUT -> ${r.status()}`);
  record('4.2b', 'notification « Save Failed »', await page.getByText(/save failed/i).first().isVisible().catch(() => false));

  // 5. Stop (abrupt) and restart: persistence.
  await stopServer(server);
  running.server = null;
  server = await startServer(work);
  running.server = server;
  await page.goto(`${BASE}/`);
  await page.click('a[href="/settings"]');
  await page.waitForURL(`${BASE}/settings`);
  await page.waitForSelector('#drawingDirectionSelect');
  await page.waitForFunction(() => document.querySelector('#drawingDirectionSelect')?.value === 'center_out', null, { timeout: 10_000 }).catch(() => null);
  await openCooldowns();
  const direction = await page.inputValue('#drawingDirectionSelect');
  const cooldown = await page.inputValue('#accountCooldown');
  record('5.2', 'paramètres conservés après redémarrage du serveur', direction === 'center_out' && cooldown === '25', `${direction}, ${cooldown}`);

  // 6. Logs and WebSocket.
  await page.click('a[href="/logs"]');
  await page.waitForURL(`${BASE}/logs`);
  await page.locator('#logsViewer').getByText('Connected', { exact: true }).waitFor({ timeout: 15_000 });
  record('6.1', 'Logs : indicateur « Connected », WebSocket ws://127.0.0.1:3000 ouvert', frames.some((f) => f.startsWith('open ws://127.0.0.1:3000')));
  record('6.2', 'messages « subscribed to logs » et « Connected to log stream »', frames.some((f) => /subscribed to logs/i.test(f)) && frames.some((f) => /Connected to log stream/.test(f)));
  // Phase 1B.9: the count includes the engine WebSocket of each dashboard tab, so the check is that
  // the count announced live grows when the second tab connects, not a fixed value.
  const maxTotal = async () => Math.max(0, ...[...(await page.locator('body').innerText()).matchAll(/connected \((\d+) total\)/gi)].map((m) => Number(m[1])));
  const totalBefore = await maxTotal();
  const second = await context.newPage();
  watch(second, 'onglet 2');
  await second.goto(`${BASE}/`);
  await second.click('a[href="/logs"]');
  await second.locator('#logsViewer').getByText('Connected', { exact: true }).waitFor({ timeout: 15_000 });
  await page
    .waitForFunction((before) => [...document.body.innerText.matchAll(/connected \((\d+) total\)/gi)].some((m) => Number(m[1]) > Math.max(1, before)), totalBefore, { timeout: 10_000 })
    .catch(() => null);
  const totalAfter = await maxTotal();
  record('6.3', 'le premier onglet reçoit en direct « WebSocket client connected (N total) » du second onglet', totalAfter > Math.max(1, totalBefore), `${totalBefore} → ${totalAfter}`);
  const logFile = path.join(work, 'data', 'logs.log');
  const logs = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  record('6.4', 'data/logs.log existe, sans cookie ni jeton', logs.length > 0 && !/cookie|token=|j=ey/i.test(logs), `${logs.length} octets`);
  await second.close();

  // F13: reload (F5) on a page whose address is also an API route.
  for (const href of ['/logs', '/users', '/templates', '/settings']) {
    const response = await page.goto(`${BASE}${href}`);
    const type = response?.headers()['content-type'] ?? '';
    record(`F13 ${href}`, `F5 sur ${href} affiche l’interface (pas du JSON)`, type.includes('text/html') && (await page.locator('a[href="/settings"]').count()) > 0, type);
  }

  // 8. Cross-site: a page of another origin cannot read the accounts.
  const foreign = await context.newPage();
  await foreign.route('http://autre-site.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>autre</title>' }));
  await foreign.goto('http://autre-site.test/');
  const crossSite = await foreign.evaluate(async (base) => {
    try {
      const res = await fetch(`${base}/users`);
      return `statut ${res.status}`;
    } catch (e) {
      return `bloqué: ${e.message}`;
    }
  }, BASE);
  record('8', 'une autre origine ne peut pas lire /users', !/statut 200/.test(crossSite), crossSite);
  await foreign.close();

  // 7. Console and failed requests over the whole session.
  // The refused save of check 4.2 logs its 400 on purpose: those two lines are expected, nothing else is.
  // Phase 1B.9: during the restart of check 5.2, the dashboard's engine WebSocket reconnects: refused while the server is down.
  const expected = (e) =>
    /status of 400 \(Bad Request\)/.test(e) ||
    /Failed to save settings: AxiosError: Request failed with status code 400/.test(e) ||
    /ws:\/\/127\.0\.0\.1:3000\/api\/v1\/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED/.test(e);
  const unexpected = consoleErrors.filter((e) => !expected(e));
  record('7', 'aucune erreur ni avertissement en console (hors refus voulu du contrôle 4.2)', unexpected.length === 0, unexpected.join(' | '));
  record('7a', 'erreurs console attendues (refus 400 du contrôle 4.2)', null, `${consoleErrors.length - unexpected.length} ligne(s)`);
  record('7b', 'aucune requête en erreur (hors refus attendus)', failed.filter((f) => !/PUT \/settings -> 400/.test(f) && !f.includes('autre-site')).length === 0, failed.join(' | '));

  await browser.close();
  running.browser = null;
  await stopServer(server);
  running.server = null;
  rmSync(work, { recursive: true, force: true });
  running.work = null;
  if (reportFile) writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const ko = results.filter((x) => x.status === 'KO').length;
  process.stdout.write(`\n${results.length} contrôles, ${ko} KO\n`);
  process.exitCode = ko === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
