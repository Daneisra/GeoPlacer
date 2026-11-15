/**
 * Browser acceptance of the local simulation (Phase 1B.9, extended in 1B.10): the user journey in a
 * real Edge (or Chrome, or the Firefox of Playwright with GEOPLACER_BROWSER_ENGINE=firefox), against
 * the compiled server (dist/server.js) in a temporary directory: the repository's data\ is never
 * touched, nothing leaves the machine. Screenshots and a log in <out>.
 *
 *   $env:GEOPLACER_PLAYWRIGHT_CORE="<dir>\node_modules\playwright-core"   (installed outside the repo)
 *   npm run build
 *   node scripts/recette-simulation.mjs <out dir> [--quick]      # port 3917 must be free
 *
 * Journey: empty project -> demonstration (prepare, start, pixels placed, pause, resume, run to the end)
 * -> French texts -> inherited features absent -> a refused setting (translated) -> backup -> a large
 * template (2000 x 2000: whole, zoom, pan, overlay) -> server stopped, the backup restored, restarted:
 * the backed-up state is back. --quick: the demonstration is stopped instead of run to the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'recette-simulation');
const quick = process.argv.includes('--quick');
const pw = process.env.GEOPLACER_PLAYWRIGHT_CORE;
if (!pw) throw new Error('set GEOPLACER_PLAYWRIGHT_CORE to a playwright-core directory (installed outside the repository)');
const engineName = process.env.GEOPLACER_BROWSER_ENGINE === 'firefox' ? 'firefox' : 'chromium';
const browserPath =
  engineName === 'firefox'
    ? undefined
    : [process.env.GEOPLACER_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
if (engineName === 'chromium' && !browserPath) throw new Error('no Edge or Chrome found (set GEOPLACER_BROWSER)');
const playwright = createRequire(import.meta.url)(pw);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-recette-'));
const PORT = 3917;
const base = `http://127.0.0.1:${PORT}`;
const log = [];
let failures = 0;
const step = (name, data = '') => {
  const line = `${new Date().toISOString().slice(11, 23)} ${name} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  log.push(line);
  console.log(line);
};
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  step(`${ok ? 'OK ' : 'KO '} ${name}`, detail);
};

function startServer() {
  const proc = spawn(process.execPath, [path.join(repo, 'dist', 'server.js')], { cwd: work, env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let o = '';
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', (c) => {
      o += c;
      if (/Server started successfully/i.test(o)) resolve();
    });
    proc.stderr.on('data', (c) => (o += c));
    void exited.then((code) => reject(new Error(`server exited ${code}: ${o}`)));
  });
  return { proc, ready, exited, output: () => o };
}

function png(w, h, colorOf) {
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      const c = colorOf(x, y);
      if (c === null) continue;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PALETTE = [
  [0xed, 0x1c, 0x24],
  [0x00, 0xa2, 0xe8],
  [0xff, 0xf2, 0x00],
  [0x22, 0xb1, 0x4c],
  [0xff, 0xff, 0xff],
];
const bigPng = path.join(work, 'grand.png');
writeFileSync(bigPng, png(2000, 2000, (x, y) => PALETTE[((x >> 6) + (y >> 6)) % PALETTE.length]));

let server = startServer();
await server.ready;
step('server ready', engineName);
const browser = await playwright[engineName].launch({ ...(browserPath === undefined ? {} : { executablePath: browserPath }), headless: true });
const consoleErrors = [];
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  step('screenshot', name);
};
const stateText = (page) => page.locator('#engineState').innerText();
const waitState = (page, label, timeout = 60_000) => page.waitForFunction((l) => document.querySelector('#engineState')?.textContent === l, label, { timeout });
const progress = async (page) => parseFloat((await page.locator('#progressPercent').innerText()).replace(',', '.'));
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept('RESET');
    else await d.accept();
  });

  // 1. Open GeoPlacer: simulation banner, an empty project, the demonstration offered.
  await page.goto(`${base}/`);
  await page.waitForSelector('#simulationBanner');
  await page.waitForFunction(() => document.querySelector('#wsConnection')?.textContent === 'Temps réel connecté');
  check('ouverture : bandeau « SIMULATION LOCALE », temps réel connecté', (await page.locator('#simulationBanner').innerText()).includes('SIMULATION LOCALE'));
  await page.waitForSelector('#demoSetup');
  check('démonstration proposée sur un projet vide', await page.locator('#demoSetup').isEnabled());
  check('fonctions héritées absentes du menu', (await page.locator('a[href="/users"], a[href="/templates"]').count()) === 0);
  await shot(page, '01-accueil-demonstration');

  // 2. Demonstration: prepare, start, pixels placed, pause, resume.
  await page.locator('#demoSetup').click();
  await page.waitForFunction(() => document.querySelector('#engineOverview')?.textContent?.includes('Démonstration'), null, { timeout: 30_000 });
  check('modèle d’exemple chargé et sélectionné', (await page.locator('#engineOverview').innerText()).includes('Démonstration — paysage'));
  const demoResources = await page
    .waitForFunction(() => /Énergie : 400 \/ 400/.test(document.querySelector('#resourcesPanel')?.textContent?.replace(/\s+/g, ' ') ?? ''), null, { timeout: 10_000 })
    .then(
      () => true,
      () => false
    );
  check('ressources de démonstration (agent simulé)', demoResources, (await page.locator('#resourcesPanel').innerText()).replace(/\s+/g, ' ').slice(0, 120));
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await page.waitForFunction(() => ['En cours', 'Attente ressources'].includes(document.querySelector('#engineState')?.textContent ?? ''));
  await page.waitForFunction(() => parseFloat((document.querySelector('#progressPercent')?.textContent ?? '0').replace(',', '.')) > 5, null, { timeout: 60_000 });
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#simCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (!(d[i] === 30 && d[i + 1] === 30 && d[i + 2] === 46)) n++;
    return n;
  });
  check('les pixels se placent sur la toile affichée', painted > 300, `${painted} pixels`);
  await shot(page, '02-demonstration-en-cours');
  await page.getByRole('button', { name: 'Pause' }).click();
  await waitState(page, 'En pause');
  await page.waitForFunction(() => [...document.querySelectorAll('#engineControls button')].some((b) => b.textContent === 'Reprendre' && !b.disabled), null, { timeout: 2_000 });
  check('pause : « Reprendre » disponible, « Démarrer » non', !(await page.getByRole('button', { name: 'Démarrer' }).isEnabled()));
  const reason = await page.locator('#engineReason').innerText();
  check('raison d’état en français', reason === 'Pause demandée.', reason);
  await page.getByRole('button', { name: 'Reprendre' }).click();
  await page.waitForFunction(() => ['En cours', 'Attente ressources'].includes(document.querySelector('#engineState')?.textContent ?? ''));
  if (quick) {
    await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
    await waitState(page, 'Arrêté');
    step('démonstration arrêtée (--quick)');
  } else {
    const t0 = Date.now();
    await waitState(page, 'Terminé', 300_000);
    check('démonstration terminée', (await progress(page)) === 100, `${Math.round((Date.now() - t0) / 1000)} s de plus après la reprise`);
    check('raison finale en français', (await page.locator('#engineReason').innerText()) === 'La toile correspond au modèle.');
  }
  await shot(page, '03-demonstration-fin');
  const demoProgress = await progress(page);

  // 3. A refused setting: the explanation in French.
  const width = page.locator('#simulatorPanel label', { hasText: 'Largeur de la toile' }).locator('input');
  await width.fill('5');
  await page.locator('#simulatorPanel').getByRole('button', { name: 'Enregistrer' }).click();
  const toast = await page.locator('.toast').filter({ hasText: 'Largeur de la toile' }).first().innerText({ timeout: 10_000 }).catch(() => '');
  check('réglage refusé expliqué en français', /un nombre entier entre 16 et 4096/.test(toast), toast.replace(/\s+/g, ' ').slice(0, 160));
  await page.reload();
  await page.waitForSelector('#simulatorPanel');

  // 4. Inherited features: direct address shows the disabled page.
  await page.goto(`${base}/users`);
  check('accès direct à /users : page « désactivé »', await page.locator('#legacyDisabled').isVisible({ timeout: 10_000 }));
  await page.goto(`${base}/`);
  await page.waitForSelector('#simulatorPanel');

  // 5. Backup (stopped).
  await page.getByRole('button', { name: 'Sauvegarder' }).click();
  await page.waitForSelector('#journalDiagnosis', { timeout: 30_000 });
  const backupText = await page.locator('#journalDiagnosis').innerText();
  const backupName = /geoplacer-sauvegarde-[\w-]+/.exec(backupText)?.[0];
  check('sauvegarde créée depuis l’interface', backupName !== undefined && existsSync(path.join(work, 'sauvegardes', backupName)), backupName ?? backupText);

  // 6. A large template: whole, zoom, pan, overlay.
  const set = async (label, value) => page.locator('#simulatorPanel label', { hasText: label }).locator('input').fill(String(value));
  await set('Largeur de la toile', 2048);
  await set('Hauteur de la toile', 2048);
  await page.locator('#simulatorPanel').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Réglages enregistrés.').first().waitFor({ timeout: 60_000 });
  await page.locator('#templatePanel summary').click();
  await page.setInputFiles('#templateFile', bigPng);
  await page.locator('#templatePanel input[placeholder="Nom"]').fill('Grand modèle');
  await page.getByRole('button', { name: 'Importer et sélectionner' }).click();
  await page.getByText('Modèle importé et sélectionné.').first().waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => /Modèle entier affiché : 2000 × 2000.*1 pixel sur \d+/.test(document.querySelector('#canvasInfo')?.textContent ?? ''), null, { timeout: 60_000 });
  const info = await page.locator('#canvasInfo').innerText();
  check('grand modèle affiché entier, échelle indiquée', /Modèle entier affiché : 2000 × 2000/.test(info) && /1 pixel sur \d+/.test(info), info);
  await page.locator('#zoomIn').click();
  await page.locator('#zoomIn').click();
  await page.locator('#zoomIn').click();
  await page.waitForFunction(() => /Zone visible/.test(document.querySelector('#canvasInfo')?.textContent ?? ''));
  // The notifications (bottom right) can cover the canvas: closed first, as a user would.
  for (const close of await page.locator('.toast-close').all()) await close.click().catch(() => undefined);
  const before = await page.locator('#canvasInfo').innerText();
  const box = await page.locator('#canvasBox').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 200, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((b) => document.querySelector('#canvasInfo')?.textContent !== b, before, { timeout: 5_000 }).catch(() => undefined);
  const after = await page.locator('#canvasInfo').innerText();
  const zone = (t) => /Zone visible : x (\d+) à \d+, y (\d+) à/.exec(t)?.slice(1).join(',') ?? null;
  check('zoom puis déplacement : la zone visible change et est annoncée', zone(after) !== null && zone(after) !== zone(before), `${zone(before)} -> ${zone(after)}`);
  await page.locator('label', { hasText: 'Superposer le modèle' }).locator('input').check();
  await page.waitForTimeout(800);
  await shot(page, '04-grand-modele-zoom');
  await page.locator('#zoomFit').click();
  await page.waitForFunction(() => /Modèle entier affiché/.test(document.querySelector('#canvasInfo')?.textContent ?? ''));
  check('« Ajuster » remontre le modèle entier', true);
  await shot(page, '05-grand-modele-entier');

  // 7. Stop the server, restore the backup, restart: the backed-up state is back.
  const stopped = server.proc.send('shutdown');
  const code = await server.exited;
  check('arrêt contrôlé du serveur (IPC)', stopped && code === 0, `code ${code}`);
  const restore = spawnSync(process.execPath, [path.join(repo, 'packages', 'engine-service', 'dist', 'backup-cli.js'), 'restore', path.join('sauvegardes', backupName ?? 'missing')], { cwd: work, encoding: 'utf8' });
  check('restauration (npm run restore)', restore.status === 0 && /Restauration terminée/.test(restore.stdout), (restore.stdout + restore.stderr).replace(/\s+/g, ' ').slice(0, 200));
  check('état précédent conservé à côté', readdirSync(path.join(work, 'data')).some((n) => n.startsWith('engine.avant-restauration-')));
  server = startServer();
  await server.ready;
  await page.waitForFunction(() => document.querySelector('#wsConnection')?.textContent === 'Temps réel connecté', null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('#engineOverview')?.textContent?.includes('Démonstration — paysage'), null, { timeout: 30_000 });
  check('après restauration : le modèle de démonstration sauvegardé est sélectionné', (await page.locator('#engineOverview').innerText()).includes('Démonstration — paysage'));
  await page.getByRole('button', { name: 'Démarrer' }).click();
  if (!quick) {
    await waitState(page, 'Terminé', 120_000);
    const overview = await page.locator('#engineOverview').innerText();
    check(
      'après restauration : la progression sauvegardée est retrouvée, rien n’est repeint',
      (await progress(page)) === demoProgress && /Pixels posés depuis le démarrage : 0 /.test(overview),
      `progression ${await progress(page)} % (sauvegardée : ${demoProgress} %)`
    );
  } else await page.waitForTimeout(1500);
  await shot(page, '06-apres-restauration');

  step('notifications visibles', await page.locator('.toast').count());
  const expected = (e) => /status of 409 \(Conflict\)/.test(e) || /status of 400 \(Bad Request\)/.test(e) || /ERR_CONNECTION_REFUSED/.test(e);
  const unexpected = consoleErrors.filter((e) => !expected(e));
  check('console : aucune erreur inattendue', unexpected.length === 0, unexpected.join(' | '));
  step('console (attendues : refus volontaires, redémarrage)', consoleErrors.length - unexpected.length);
} catch (error) {
  failures++;
  step('FAILED', String(error));
} finally {
  step('RÉSULTAT', `${failures} échec(s)`);
  writeFileSync(path.join(out, 'recette.log'), `${log.join('\n')}\n\nserver output:\n${server.output().slice(-4000)}\n`);
  await browser.close();
  if (server.proc.exitCode === null) server.proc.kill();
  await new Promise((r) => setTimeout(r, 800));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = failures === 0 ? 0 : 1;
}
