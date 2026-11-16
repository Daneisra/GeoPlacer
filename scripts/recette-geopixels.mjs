/**
 * Browser acceptance of the GeoPixels ghost image preparation (Phase 1C.1), in a real Edge (or the
 * Firefox of Playwright with GEOPLACER_BROWSER_ENGINE=firefox), against the compiled server in a
 * temporary directory. NEVER opens geopixels.net: it checks what GeoPlacer can check alone.
 *
 *   $env:GEOPLACER_PLAYWRIGHT_CORE="<dir>\node_modules\playwright-core"   (installed outside the repo)
 *   npm run build
 *   node scripts/recette-geopixels.mjs <out dir>      # port 3918 must be free
 *
 * Journey: open « Préparer pour GeoPixels » from the menu -> a non-square PNG with a transparent band
 * and an asymmetric marker, the player's colors, a smaller width, GeoPixels coordinates -> prepare ->
 * preview, information -> DOWNLOAD the PNG -> the downloaded file must be pixel for pixel what the
 * preview displays (drawn in a canvas of the page), alpha 0 or 255, top-left marker at the top left,
 * colors from the palette only -> the external links are plain links, never followed -> no request
 * of the page to another host -> delete.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'recette-geopixels');
const pw = process.env.GEOPLACER_PLAYWRIGHT_CORE;
if (!pw) throw new Error('set GEOPLACER_PLAYWRIGHT_CORE to a playwright-core directory (installed outside the repository)');
const engineName = process.env.GEOPLACER_BROWSER_ENGINE === 'firefox' ? 'firefox' : 'chromium';
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const browserPath = engineName === 'firefox' ? undefined : [process.env.GEOPLACER_BROWSER, ...edge].find((p) => p && (() => { try { readFileSync(p); return true; } catch { return false; } })());
const playwright = createRequire(import.meta.url)(pw);
const { PNG } = createRequire(path.join(repo, 'package.json'))('pngjs');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-recette-gp-'));
const PORT = 3918;
const base = `http://127.0.0.1:${PORT}`;
const log = [];
let failures = 0;
// Chromium leaves an internal navigation promise of the download pending; closing the browser
// rejects it (TargetClosedError). Ignored ONLY once the acceptance is over; anything else fails.
let closing = false;
process.on('unhandledRejection', (error) => {
  if (closing && /Target page, context or browser has been closed/.test(String(error))) return;
  console.error(error);
  process.exitCode = 1;
});
const step = (name, data = '') => {
  const line = `${new Date().toISOString().slice(11, 23)} ${name} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  log.push(line);
  console.log(line);
};
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  step(`${ok ? 'OK ' : 'KO '} ${name}`, detail);
};

// Source: 48 x 20, a red marker top-left (6 x 4), a blue marker bottom-right, a transparent band
// (rows 8 to 11: whole 2 x 2 blocks once halved), near-colors elsewhere (reduced to the player's colors).
const SW = 48;
const SH = 20;
const src = new PNG({ width: SW, height: SH });
for (let y = 0; y < SH; y++) {
  for (let x = 0; x < SW; x++) {
    const o = (y * SW + x) * 4;
    const c = x < 6 && y < 4 ? [255, 0, 0, 255] : x >= 42 && y >= 16 ? [0, 0, 255, 255] : y >= 8 && y <= 11 ? [0, 0, 0, 0] : x % 4 < 2 ? [235, 225, 10, 255] : [30, 180, 40, 255];
    src.data.set(c, o);
  }
}
const sourceFile = path.join(work, 'source fantôme.png');
writeFileSync(sourceFile, PNG.sync.write(src));
const PALETTE = ['#ff0000', '#0000ff', '#ffee00', '#22b14c'];

const proc = spawn(process.execPath, [path.join(repo, 'dist', 'server.js')], { cwd: work, env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let serverOut = '';
await new Promise((resolve, reject) => {
  proc.stdout.on('data', (c) => {
    serverOut += c;
    if (/Server started successfully/i.test(serverOut)) resolve();
  });
  proc.stderr.on('data', (c) => (serverOut += c));
  proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${serverOut}`)));
});
step('server ready', engineName);
let browser;
try {
  browser = await playwright[engineName].launch({ ...(browserPath === undefined ? {} : { executablePath: browserPath }), headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1100 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const foreign = new Set();
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['data:', 'blob:', 'about:'].includes(u.protocol) || ['127.0.0.1', 'localhost'].includes(u.hostname)) return route.continue();
    foreign.add(u.host);
    return route.abort();
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:', 'about:'].includes(u.protocol) && !['127.0.0.1', 'localhost'].includes(u.hostname)) foreign.add(u.host);
  });
  page.on('dialog', (d) => void d.accept());

  await page.goto(`${base}/`);
  await page.click('a[href="/geopixels"]');
  await page.waitForSelector('#geopixelsPage');
  check('page « Préparer pour GeoPixels » ouverte depuis le menu', true);

  const personal = (await page.inputValue('#ghostPalette')).split(/\s+/).filter(Boolean);
  check('préréglage initial de 28 couleurs, blanc corrigé et ordre conservé', personal.length === 28 && personal[0] === '#ffffff' && personal[27] === '#000000');
  check('identité GeoPlacer visible', await page.locator('.sidebar-title').innerText() === 'GeoPlacer' && (await page.title()).startsWith('GeoPlacer'));
  await page.selectOption('#ghostPaletteMode', 'community30');
  const community = (await page.inputValue('#ghostPalette')).split(/\s+/).filter(Boolean);
  check('préréglage communautaire distinct de 30 couleurs', community.length === 30 && community.includes('#ff9f1c') && community.includes('#ffff00'));
  await page.selectOption('#ghostPaletteMode', 'custom');
  await page.fill('#ghostPalette', '#fffff');
  check('code #fffff explicitement refusé', (await page.locator('#ghostPaletteState').innerText()).includes('six chiffres') && await page.isDisabled('#ghostImport'));
  await page.fill('#ghostPalette', `${PALETTE.join('\n')}\n#FF0000`);
  check('doublon signalé', (await page.locator('#ghostPaletteState').innerText()).includes('doublons ignorés'));
  await page.fill('#ghostPalette', PALETTE.join('\n'));
  await page.selectOption('#ghostPaletteMode', 'personal28');
  await page.reload();
  check('choix de préréglage conservé après rechargement', await page.inputValue('#ghostPaletteMode') === 'personal28');
  await page.selectOption('#ghostPaletteMode', 'custom');
  check('palette personnalisée conservée après préréglage et rechargement', await page.inputValue('#ghostPalette') === PALETTE.join('\n'));

  await page.setInputFiles('#ghostFile', sourceFile);
  await page.selectOption('#ghostPaletteMode', 'image');
  await page.waitForFunction(() => document.querySelector('#ghostPalette').value.includes('#ff0000'));
  check('couleurs originales de l’image disponibles', (await page.inputValue('#ghostPalette')).includes('#0000ff'));
  await page.fill('#ghostAlpha', '256');
  await page.waitForFunction(() => document.querySelector('#ghostPalette').value === '');
  check('image entièrement filtrée : aucune couleur opaque ajoutée', await page.isDisabled('#ghostImport'));
  await page.fill('#ghostAlpha', '128');
  await page.selectOption('#ghostPaletteMode', 'custom');
  await page.fill('#ghostName', 'Essai fantôme');
  await page.fill('#ghostPalette', PALETTE.join('\n'));
  await page.fill('#ghostWidth', '24');
  await page.fill('#ghostX', '107958');
  await page.fill('#ghostY', '196137');
  check('palette lue (4 couleurs)', /^4 couleur/.test(await page.locator('#ghostPaletteState').innerText()), await page.locator('#ghostPaletteState').innerText());
  await page.click('#ghostImport');
  await page.waitForFunction(() => {
    const img = document.querySelector('#ghostPreview');
    return img !== null && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20_000 });
  const info = (await page.locator('#ghostInfo').innerText()).replace(/\s+/g, ' ');
  check('dimensions réduites, proportions gardées : 24 × 10', /24 × 10/.test(info), info);
  check('pixels transparents comptés : 2 lignes de 24', /transparents : 48/.test(info));
  check('coin haut-gauche saisi, non converti', /\(107958, 196137\)/.test(info));
  check('nom de fichier explicite', /geopixels-essai-fantome-24x10-x107958-y196137\.png/.test(info));
  await page.screenshot({ path: path.join(out, '01-geopixels-apercu.png'), fullPage: true });

  // Download, exactly as a user does.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ghostDownload')]);
  const file = path.join(out, download.suggestedFilename());
  await download.saveAs(file);
  check('fichier téléchargé avec le nom proposé', download.suggestedFilename() === 'geopixels-essai-fantome-24x10-x107958-y196137.png', download.suggestedFilename());
  const bytes = readFileSync(file);
  const got = PNG.sync.read(bytes);
  // The preview, as the browser displays it, drawn in a canvas of the page.
  const shown = await page.evaluate(() => {
    const img = document.querySelector('#ghostPreview');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
  const same = shown.w === got.width && shown.h === got.height && shown.data.every((v, i) => v === got.data[i]);
  check('le PNG téléchargé est, pixel pour pixel, l’aperçu affiché par GeoPlacer', same, `${got.width} x ${got.height}`);
  let alphaOk = true;
  let paletteOk = true;
  for (let i = 0; i < got.data.length; i += 4) {
    const a = got.data[i + 3];
    if (a !== 0 && a !== 255) alphaOk = false;
    if (a === 255 && !PALETTE.includes(`#${[got.data[i], got.data[i + 1], got.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`)) paletteOk = false;
  }
  check('transparence nette (alpha 0 ou 255)', alphaOk);
  check('seulement des couleurs de la palette', paletteOk);
  const px = (x, y) => Array.from(got.data.subarray((y * got.width + x) * 4, (y * got.width + x) * 4 + 4));
  check('orientation gardée : repère rouge en haut à gauche, bleu en bas à droite', JSON.stringify(px(0, 0)) === '[255,0,0,255]' && JSON.stringify(px(23, 9)) === '[0,0,255,255]', `${px(0, 0)} / ${px(23, 9)}`);
  check('bande transparente gardée (lignes 4 et 5, alpha 0)', px(10, 4)[3] === 0 && px(10, 5)[3] === 0 && px(10, 3)[3] === 255 && px(10, 6)[3] === 255, `${px(10, 3)} ${px(10, 4)} ${px(10, 5)} ${px(10, 6)}`);
  const apiBytes = Buffer.from(await page.evaluate(async (u) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), await page.locator('#ghostDownload').getAttribute('href')));
  check('mêmes octets que l’export de l’API', apiBytes.equals(bytes));

  const firstId = await page.inputValue('#ghostList');
  await page.selectOption('#ghostPaletteMode', 'personal28');
  await page.click('#ghostImport');
  await page.waitForFunction((id) => document.querySelector('#ghostList')?.value !== id, firstId);
  const secondId = await page.inputValue('#ghostList');
  const prepared = await page.evaluate(async () => (await (await fetch('/api/v1/geopixels/templates')).json()).templates);
  const newModel = prepared.find((g) => g.templateId === secondId);
  check('le changement de palette alimente réellement la quantification', JSON.stringify(newModel?.palette) === JSON.stringify(personal) && newModel.colors.every((c) => personal.includes(c.hex)));
  check('couleurs inutilisées affichées pour le modèle enregistré', (await page.locator('#ghostUnusedColors').innerText()).includes(String(28 - newModel.colors.length)));
  await page.selectOption('#ghostList', firstId);
  const originalBytes = Buffer.from(await page.evaluate(async (u) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), await page.locator('#ghostDownload').getAttribute('href')));
  check('le modèle précédent garde sa palette et son PNG', originalBytes.equals(bytes));
  await page.screenshot({ path: path.join(out, '02-palettes-et-modele-conserve.png'), fullPage: true });

  // External links: plain links, opened in a new tab only by the user; never followed here.
  const links = await page.locator('#ghostGuide a').evaluateAll((as) => as.map((a) => ({ href: a.href, rel: a.rel, target: a.target })));
  check('liens vers GeoPixels : simples liens, noopener', links.length === 2 && links.every((l) => /^https:\/\/(www\.)?geopixels\.net\//.test(l.href) && /noopener/.test(l.rel) && l.target === '_blank'), JSON.stringify(links));

  for (let i = 0; i < 2; i++) {
    const id = await page.inputValue('#ghostList');
    await page.click('#ghostDelete');
    await page.waitForFunction((old) => document.querySelector('#ghostList') === null || document.querySelector('#ghostList').value !== old, id, { timeout: 10_000 });
  }
  check('suppression dans GeoPlacer', true);
  check('aucune requête de la page vers un autre hôte (geopixels.net compris)', foreign.size === 0, [...foreign].join(' | '));
  check('console sans erreur', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (error) {
  failures++;
  step('FAILED', String(error));
} finally {
  step('RÉSULTAT', `${failures} échec(s)`);
  writeFileSync(path.join(out, 'recette.log'), `${log.join('\n')}\n`);
  writeFileSync(path.join(out, 'server.log'), serverOut);
  closing = true;
  // Close the pages first, then the browser.
  for (const c of browser?.contexts() ?? []) await c.close().catch(() => undefined);
  await browser?.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = failures === 0 ? 0 : 1;
}
