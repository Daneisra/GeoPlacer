/**
 * Phase 1B.9 browser acceptance: the whole user journey of the local simulation in a real Edge (or
 * Chrome), against the compiled server (dist/server.js) running in a temporary directory: the
 * repository's data\ is never touched, nothing leaves the machine. Screenshots and a log in <out>.
 *
 *   $env:GEOPLACER_PLAYWRIGHT_CORE="<dir>
ode_modules\playwright-core"   (installed outside the repo)
 *   npm run build
 *   node scripts/recette-simulation.mjs <out dir>      # port 3917 must be free
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'recette-simulation');
const pw = process.env.GEOPLACER_PLAYWRIGHT_CORE;
if (!pw) throw new Error('set GEOPLACER_PLAYWRIGHT_CORE to a playwright-core directory (installed outside the repository)');
const browserPath = [process.env.GEOPLACER_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('no Edge or Chrome found (set GEOPLACER_BROWSER)');
const { chromium } = createRequire(import.meta.url)(pw);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-recette-'));
const PORT = 3917;
const base = `http://127.0.0.1:${PORT}`;
const log = [];
const step = (name, data = '') => {
  const line = `${new Date().toISOString().slice(11, 23)} ${name} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  log.push(line);
  console.log(line);
};

function startServer() {
  const proc = spawn(process.execPath, [path.join(repo, 'dist', 'server.js')], { cwd: work, env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', (c) => {
      o += c;
      if (/Server started successfully/i.test(o)) resolve();
    });
    proc.stderr.on('data', (c) => (o += c));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${o}`)));
  });
  return { proc, ready, output: () => o };
}

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
  const palette = [[0xed, 0x1c, 0x24], [0x00, 0xa2, 0xe8], [0xff, 0xf2, 0x00], [0x22, 0xb1, 0x4c], [0xff, 0xff, 0xff]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      const d = Math.hypot(x - w / 2, y - h / 2);
      if (d > w / 2) continue; // a disc: transparent corners
      const [r, g, b] = palette[Math.floor(d / 4) % palette.length];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const pngFile = path.join(work, 'disque.png');
writeFileSync(pngFile, png(48, 48));
let server = startServer();
await server.ready;
step('server ready');
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const consoleErrors = [];
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  step('screenshot', name);
};
const stateText = (page) => page.locator('#engineState').innerText();
const waitState = async (page, label, timeout = 60_000) => {
  await page.waitForFunction((l) => document.querySelector('#engineState')?.textContent === l, label, { timeout });
  step('state', label);
};
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message().slice(0, 80));
    if (d.type() === 'prompt') await d.accept('RESET');
    else await d.accept();
  });

  // 1. Open GeoPlacer: the simulation banner, no template, Start unavailable.
  await page.goto(`${base}/`);
  await page.waitForSelector('#simulationBanner');
  await page.waitForFunction(() => document.querySelector('#wsConnection')?.textContent === 'Temps réel connecté');
  step('opened', { banner: await page.locator('#simulationBanner').innerText(), state: await stateText(page), startEnabled: await page.getByRole('button', { name: 'Démarrer' }).isEnabled() });
  await shot(page, '01-accueil');

  // 3. Parameters: a faster simulation (capacity and energy change the world: confirmed reset).
  const set = async (label, value) => {
    const input = page.locator('#simulatorPanel label', { hasText: label }).locator('input');
    await input.fill(String(value));
  };
  await set('Capacité d’énergie', 3000);
  await set('Énergie de départ', 3000);
  await set('Latence d’écriture (ms)', 25);
  await set('Lot maximal (pixels)', 25);
  await set('Lot minimal (pixels)', 5);
  await set('Monnaie de départ', 5000);
  await page.locator('#simulatorPanel').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Réglages enregistrés.').first().waitFor();
  step('settings saved', { dialogs });

  // 2. Import a template (PNG), strategy, position.
  await page.locator('#templatePanel summary').click();
  await page.setInputFiles('#templateFile', pngFile);
  await page.locator('#templatePanel input[placeholder="Nom"]').fill('Disque de recette');
  const coords = page.locator('#templatePanel details input[type="number"]');
  await coords.nth(0).fill('20');
  await coords.nth(1).fill('30');
  await page.locator('#templatePanel details select').selectOption('center-out');
  await page.getByRole('button', { name: 'Importer et sélectionner' }).click();
  await page.getByText('Modèle importé et sélectionné.').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#engineOverview')?.textContent?.includes('Disque de recette'));
  step('template selected');
  await shot(page, '02-modele-selectionne');

  // 4/5. Agent and resources.
  await page.waitForSelector('#upgradeList li');
  step('resources', { panel: (await page.locator('#resourcesPanel').innerText()).slice(0, 300) });

  // 6. Start; progress; canvas updates.
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await waitState(page, 'En cours');
  step('start disabled while running', !(await page.getByRole('button', { name: 'Démarrer' }).isEnabled()));
  await page.waitForFunction(() => {
    const t = document.querySelector('#progressPercent')?.textContent ?? '';
    return parseFloat(t) > 15;
  }, null, { timeout: 60_000 });
  await shot(page, '03-en-cours');
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#simCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (!(d[i] === 30 && d[i + 1] === 30 && d[i + 2] === 46)) n++;
    return { w: c.width, h: c.height, painted: n };
  });
  step('canvas while running', painted);

  // 9/10. Pause, resume.
  await page.getByRole('button', { name: 'Pause' }).click();
  await waitState(page, 'En pause');
  // The full status follows the state change at once: Resume becomes available, Start does not.
  const pausedAt = Date.now();
  await page.waitForFunction(() => [...document.querySelectorAll('#engineControls button')].some((b) => b.textContent === 'Reprendre' && !b.disabled), null, { timeout: 2_000 });
  step('commands while paused', { afterMs: Date.now() - pausedAt, start: await page.getByRole('button', { name: 'Démarrer' }).isEnabled(), resume: await page.getByRole('button', { name: 'Reprendre' }).isEnabled() });
  await shot(page, '04-pause');
  await page.getByRole('button', { name: 'Reprendre' }).click();
  await page.waitForFunction(() => ['En cours', 'Attente ressources'].includes(document.querySelector('#engineState')?.textContent ?? ''));
  step('resumed', await stateText(page));

  // 11. Stop cleanly.
  await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
  await waitState(page, 'Arrêté');
  step('stopped', { openAttempts: await page.locator('#attemptsPanel').innerText().then((t) => t.slice(0, 120)) });
  await shot(page, '05-arrete');

  // Run to the end.
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await waitState(page, 'Terminé', 120_000);
  step('completed', { progress: await page.locator('#progressPercent').innerText() });
  await shot(page, '06-termine');

  // External actor: detected and repainted.
  await page.getByRole('button', { name: 'Simuler un acteur extérieur' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await waitState(page, 'Terminé', 60_000);
  step('external edit repaired');

  // Upgrade with explicit confirmation (simulated world only).
  const before = await page.locator('#resourcesPanel').innerText();
  await page.locator('#upgradeList li').filter({ has: page.getByRole('button', { name: 'Appliquer…', disabled: false }) }).first().getByRole('button', { name: 'Appliquer…' }).click();
  await page.getByText(/appliquée à l’agent simulé/).first().waitFor();
  step('upgrade applied', { dialogs: dialogs.slice(-1), currencyBefore: /Monnaie simulée : (\d+)/.exec(before)?.[1], currencyAfter: /Monnaie simulée : (\d+)/.exec(await page.locator('#resourcesPanel').innerText())?.[1] });
  await shot(page, '07-amelioration');

  // Journal diagnosis and compaction.
  await page.getByRole('button', { name: 'Diagnostic du journal' }).click();
  await page.waitForSelector('#journalDiagnosis');
  step('diagnosis', await page.locator('#journalDiagnosis').innerText());
  await page.getByRole('button', { name: 'Compacter' }).click();
  await page.getByText(/Journal compacté/).first().waitFor();
  step('compacted');

  // 12. Restart the server (brutal kill), the page reconnects and finds a consistent state.
  const progressBefore = await page.locator('#progressPercent').innerText();
  server.proc.kill();
  await page.waitForFunction(() => document.querySelector('#wsConnection')?.textContent !== 'Temps réel connecté', null, { timeout: 20_000 });
  step('disconnection shown', await page.locator('#wsConnection').innerText());
  server = startServer();
  await server.ready;
  await page.waitForFunction(() => document.querySelector('#wsConnection')?.textContent === 'Temps réel connecté', null, { timeout: 30_000 });
  step('reconnected without reload');
  await page.waitForFunction(() => document.querySelector('#engineOverview')?.textContent?.includes('Disque de recette'));
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await waitState(page, 'Terminé', 60_000);
  step('after restart', { progressBefore, progressAfter: await page.locator('#progressPercent').innerText(), overview: (await page.locator('#engineOverview').innerText()).slice(0, 400) });
  await shot(page, '08-apres-redemarrage');

  // Notifications seen.
  step('toasts visible', await page.locator('.toast').count());
  step('console errors', consoleErrors);
  writeFileSync(path.join(out, 'recette.log'), `${log.join('\n')}\n`);
} catch (error) {
  step('FAILED', String(error));
  writeFileSync(path.join(out, 'recette.log'), `${log.join('\n')}\n\nserver output:\n${server.output()}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
