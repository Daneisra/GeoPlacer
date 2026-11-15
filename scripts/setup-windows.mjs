// GeoPlacer installation for Windows (Phase 1B.10): one command from a fresh clone.
//
//   npm run setup:windows        (or double-click setup.bat)
//
// Steps (each one explains what went wrong, in French, instead of a raw error):
//  1. Node.js >= 22.12 and npm >= 10;
//  2. dependencies from the lockfile, install scripts disabled: root (with the engine packages,
//     npm workspaces), then the frontend;
//  3. native module `canvas` (inherited server): its official PREBUILT binary (no compiler),
//     then a real load test;
//  4. build: engine packages, server, frontend;
//  5. folders and a non-sensitive .env (copied from .env.example only if absent);
//  6. a start test: the compiled server in a TEMPORARY folder (your data is not used), the API
//     answered, then a controlled stop.
// Nothing global is changed (no global npm package, no Windows setting). The full output is kept in
// test-logs/<date>-setup.log.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
mkdirSync(path.join(root, 'test-logs'), { recursive: true });
const logFile = path.join(root, 'test-logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-setup.log`);
const log = createWriteStream(logFile);
const say = (line = '') => {
  console.log(line);
  log.write(`${line}\n`);
};
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

function fail(step, message, hint) {
  say('');
  say(`ÉCHEC à l'étape « ${step} » : ${message}`);
  if (hint) say(`Que faire : ${hint}`);
  say(`Journal complet : ${path.relative(root, logFile)}`);
  log.end(() => process.exit(1));
}

/** Runs a command, its output shown and logged; resolves with the exit code. */
function run(command, commandArgs, cwd = root, env = process.env) {
  return new Promise((resolve) => {
    log.write(`\n$ ${command} ${commandArgs.join(' ')}   (in ${path.relative(root, cwd) || '.'})\n`);
    const child = spawn(command, commandArgs, { cwd, env, shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        log.write(chunk);
        if (args.has('--verbose')) process.stdout.write(chunk);
      });
    }
    child.on('error', (error) => {
      log.write(`${String(error)}\n`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

const version = (text) => text.trim().replace(/^v/, '').split('.').map(Number);
const atLeast = (v, min) => v[0] > min[0] || (v[0] === min[0] && (v[1] > min[1] || (v[1] === min[1] && (v[2] ?? 0) >= (min[2] ?? 0))));

say('Installation de GeoPlacer (simulation locale) — Windows');
say(`Dossier : ${root}`);
say('');

// 1. Node.js and npm.
const nodeVersion = version(process.version);
if (!atLeast(nodeVersion, [22, 12, 0])) {
  fail('Node.js', `version ${process.version}, GeoPlacer demande la 22.12 ou plus récente`, 'installez Node.js 22 LTS depuis https://nodejs.org (installateur Windows), puis rouvrez le terminal.');
} else {
  say(`[1/6] Node.js ${process.version} : OK`);
  const npmVersion = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: isWindows });
  if (npmVersion.status !== 0 || !atLeast(version(npmVersion.stdout), [10, 0, 0])) {
    fail('npm', `npm ${npmVersion.stdout?.trim() || 'introuvable'}, la version 10 ou plus récente est attendue`, 'npm est fourni avec Node.js 22 : réinstallez Node.js 22 LTS.');
  } else {
    say(`      npm ${npmVersion.stdout.trim()} : OK`);
    await main();
  }
}

async function main() {
  // 2. Dependencies (exact versions of the lockfiles, install scripts disabled).
  if (!args.has('--skip-install')) {
    say('[2/6] Dépendances (racine et paquets du moteur, puis interface) : installation…');
    if ((await run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])) !== 0) {
      return fail('dépendances', 'npm ci a échoué à la racine', 'vérifiez la connexion Internet (ou le proxy de votre réseau) puis relancez ; le détail est dans le journal.');
    }
    if ((await run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(root, 'frontend'))) !== 0) {
      return fail('dépendances', 'npm ci a échoué dans frontend', 'vérifiez la connexion Internet puis relancez ; le détail est dans le journal.');
    }
    say('      OK');
  } else say('[2/6] Dépendances : étape sautée (--skip-install)');

  // 3. canvas: the official prebuilt binary, then a real load.
  say('[3/6] Module natif canvas (serveur hérité) : binaire précompilé…');
  const canvasDir = path.join(root, 'node_modules', 'canvas');
  const binary = path.join(canvasDir, 'build', 'Release', 'canvas.node');
  if (!existsSync(canvasDir)) return fail('canvas', 'le paquet canvas est absent de node_modules', 'relancez sans --skip-install.');
  if (!existsSync(binary)) {
    const code = await run(process.execPath, [path.join('..', 'prebuild-install', 'bin.js'), '-r', 'napi'], canvasDir);
    if (code !== 0 || !existsSync(binary)) {
      return fail(
        'canvas',
        'le binaire précompilé de canvas n’a pas pu être téléchargé (aucune compilation n’est tentée)',
        'vérifiez l’accès à github.com (release officielle Automattic/node-canvas) puis relancez ; voir docs/fr/installation-windows.md, « Vérifier le binaire canvas ».'
      );
    }
  }
  const load = spawnSync(process.execPath, ['-e', "require('canvas'); console.log('ok')"], { cwd: root, encoding: 'utf8' });
  log.write(`canvas load: ${load.stdout}${load.stderr}\n`);
  if (load.status !== 0 || !load.stdout.includes('ok')) {
    return fail('canvas', 'le module canvas ne se charge pas', 'une bibliothèque système manque peut-être (Visual C++ Redistributable) ; le détail est dans le journal.');
  }
  say('      OK (binaire chargé)');

  // 4. Build.
  say('[4/6] Compilation (moteur, serveur, interface)…');
  if ((await run(npm, ['run', 'build'])) !== 0) return fail('compilation', 'npm run build a échoué', 'le détail est dans le journal ; signalez-le avec ce fichier.');
  say('      OK');

  // 5. Folders and configuration.
  say('[5/6] Dossiers et configuration…');
  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(path.join(root, 'sauvegardes'), { recursive: true });
  if (!existsSync(path.join(root, '.env')) && existsSync(path.join(root, '.env.example'))) {
    copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    say('      .env créé depuis .env.example (aucun secret)');
  } else say('      .env : déjà présent, conservé');
  say('      data\\ et sauvegardes\\ : OK');

  // 6. Start test in a temporary folder.
  say('[6/6] Démarrage de contrôle (dossier temporaire, vos données ne sont pas utilisées)…');
  const result = await startTest();
  if (result !== 'ok') return fail('démarrage', result, 'le détail est dans le journal ; vérifiez qu’aucun autre programme ne bloque le serveur.');
  say('      OK : le serveur a démarré, l’API a répondu, l’arrêt contrôlé a réussi');
  say('');
  say('GeoPlacer est installé.');
  say('  Lancer :          npm start        puis ouvrir http://127.0.0.1:3000');
  say('  Démonstration :   npm run demo     (dossier séparé data\\demo)');
  say('  Arrêter :         Ctrl+C dans la fenêtre du serveur');
  say('  Sauvegarder :     npm run backup   (GeoPlacer arrêté)');
  say(`Journal : ${path.relative(root, logFile)}`);
  log.end(() => process.exit(0));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startTest() {
  const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-setup-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], {
    cwd: work,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GEOPLACER_ENGINE_DIR: path.join(work, 'engine') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const listening = await Promise.race([
      new Promise((resolve) => child.on('message', (m) => m?.type === 'listening' && resolve(m.port))),
      exited.then(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 120_000)),
    ]);
    if (listening === null) return `le serveur ne démarre pas : ${output.slice(-600)}`;
    const status = await new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port: listening, path: '/api/v1/engine/status' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(res.statusCode === 200 && body.includes('"simulation"')));
        })
        .on('error', () => resolve(false));
    });
    if (!status) return 'l’API du moteur ne répond pas';
    child.send('shutdown');
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 30_000))]);
    if (code !== 0) return `l’arrêt contrôlé n’a pas abouti (${String(code)})`;
    return 'ok';
  } finally {
    log.write(`\n--- start test output ---\n${output}\n`);
    if (child.exitCode === null) child.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}
