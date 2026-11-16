// Installation audit for Windows (Phase 1C.0): a fresh clone placed in a path with spaces and an
// accent, installed by a Node.js whose path has spaces (like C:\Program Files\nodejs), with an empty
// npm cache; then an interrupted installation, a repeated one, new sources (a commit), changed
// dependencies (lockfile), a folder that cannot be created, and nothing global changed.
//
//   node scripts/audit-installation-windows.mjs <dépôt source> <branche> <dossier de travail, absent>
//
// Downloads the dependencies (registry.npmjs.org, github.com). Writes only under the work folder
// (the clone, a copy of node.exe, an npm cache, compte-rendu.txt). Exit code 0 when every check passes.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [source, branch, workArg] = process.argv.slice(2);
if (!source || !branch || !workArg) throw new Error('usage: node scripts/audit-installation-windows.mjs <dépôt source> <branche> <dossier de travail, absent>');
const work = path.resolve(workArg);
if (existsSync(work)) throw new Error(`${work} exists: give a new folder`);
const base = path.join(work, 'audit installation é');
const repo = path.join(base, 'GeoPlacer');
const node = path.join(work, 'node avec espaces', 'node.exe');
const cache = path.join(work, 'npm-cache');
const report = path.join(work, 'compte-rendu.txt');
mkdirSync(path.dirname(node), { recursive: true });
copyFileSync(process.execPath, node);
writeFileSync(report, '');
const say = (s) => {
  console.log(s);
  appendFileSync(report, `${s}\n`);
};
const env = { ...process.env, npm_config_cache: cache };
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  say(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const setup = (extra = []) => spawnSync(node, [path.join(repo, 'scripts', 'setup-windows.mjs'), ...extra], { cwd: repo, env, encoding: 'utf8' });
const checkCode = () => spawnSync(node, [path.join(repo, 'scripts', 'setup-windows.mjs'), '--check'], { cwd: repo, env, encoding: 'utf8' });
const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');

const globalState = () => spawnSync('npm.cmd', ['ls', '-g', '--depth=0'], { encoding: 'utf8', shell: true }).stdout + spawnSync('npm.cmd', ['config', 'get', 'prefix'], { encoding: 'utf8', shell: true }).stdout;
const globalBefore = globalState();
rmSync(base, { recursive: true, force: true });
rmSync(cache, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
mkdirSync(cache, { recursive: true });
execFileSync('git', ['clone', '-q', '--branch', branch, source, repo]);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'audit@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'audit']);
say(`clone: ${repo} (${execFileSync('git', ['-C', repo, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim()})`);
say(`node: ${node} (${execFileSync(node, ['-v'], { encoding: 'utf8' }).trim()})`);

// 1. Full installation from nothing: spaced and accented path, spaced Node.js path, empty cache.
let t = Date.now();
let r = setup();
check('1. installation complète (chemins avec espaces et accent, Node.js dans un chemin avec espaces, cache vide)', r.status === 0, `${Math.round((Date.now() - t) / 1000)} s ; ${tail(r)}`);
check('   empreinte SHA-256 de l’archive canvas vérifiée', /empreinte SHA-256 conforme/.test(r.stdout), (r.stdout.match(/OK \(binaire chargé[^\n]*/) ?? [''])[0]);
r = checkCode();
check('   --check après installation : 0', r.status === 0, r.stdout.trim());

// 2. Interrupted installation: killed during npm ci.
const child = spawn(node, [path.join(repo, 'scripts', 'setup-windows.mjs')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (c) => (out += c));
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (/\[2\/6\]/.test(out)) {
      clearInterval(timer);
      setTimeout(resolve, 8000); // npm ci is busy (node_modules being replaced)
    }
  }, 200);
});
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
await new Promise((resolve) => child.on('close', resolve));
r = checkCode();
check('2. installation interrompue pendant npm ci : --check = 1 (jamais vue comme complète)', r.status === 1, r.stdout.trim());
t = Date.now();
r = spawnSync('cmd.exe', ['/d', '/c', '.\\start.bat'], { cwd: repo, env: { ...env, GEOPLACER_SETUP_ONLY: '1', PATH: `${path.dirname(node)};${env.PATH}` }, encoding: 'utf8' });
check('   start.bat la reprend (installation complète) puis s’arrête (GEOPLACER_SETUP_ONLY)', r.status === 0 && /GeoPlacer est install/.test(r.stdout), `${Math.round((Date.now() - t) / 1000)} s ; ${tail(r)}`);
r = checkCode();
check('   --check : 0', r.status === 0, r.stdout.trim());

// 3. Repeated installation over an existing one: .env kept, data kept.
mkdirSync(path.join(repo, 'data'), { recursive: true });
writeFileSync(path.join(repo, 'data', 'temoin.txt'), 'données de l’utilisateur');
const envBefore = readFileSync(path.join(repo, '.env'), 'utf8') + '\n# réglage local de test\n';
writeFileSync(path.join(repo, '.env'), envBefore);
r = setup();
check('3. installation répétée sur une installation existante', r.status === 0, tail(r));
check('   .env et data\\ conservés', readFileSync(path.join(repo, '.env'), 'utf8') === envBefore && existsSync(path.join(repo, 'data', 'temoin.txt')));

// 4. New sources (a commit, as after git pull): only a build.
execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'audit: nouveau commit']);
r = checkCode();
check('4. nouveau commit : --check = 2 (recompilation seule)', r.status === 2, r.stdout.trim());
t = Date.now();
r = spawnSync('cmd.exe', ['/d', '/c', '.\\start.bat'], { cwd: repo, env: { ...env, GEOPLACER_SETUP_ONLY: '1', PATH: `${path.dirname(node)};${env.PATH}` }, encoding: 'utf8' });
check('   start.bat recompile sans réinstaller', r.status === 0 && /Sources modifiees/.test(r.stdout) && /\[2\/6\] Dépendances : étape sautée/.test(r.stdout), `${Math.round((Date.now() - t) / 1000)} s`);
r = checkCode();
check('   --check : 0', r.status === 0, r.stdout.trim());

// 5. Dependencies changed (lockfile): a full installation is required.
const lock = path.join(repo, 'frontend', 'package-lock.json');
const original = readFileSync(lock);
writeFileSync(lock, Buffer.concat([original, Buffer.from('\n')]));
r = checkCode();
check('5. lockfile modifié : --check = 1', r.status === 1, r.stdout.trim());
writeFileSync(lock, original);
r = checkCode();
check('   lockfile restauré : --check = 0', r.status === 0, r.stdout.trim());

// 6. A folder that cannot be created: a clear explanation, not a stack trace.
rmSync(path.join(repo, 'sauvegardes'), { recursive: true, force: true });
writeFileSync(path.join(repo, 'sauvegardes'), 'un fichier à la place du dossier');
r = setup(['--skip-install']);
check('6. dossier impossible à créer : échec expliqué', r.status === 1 && /ÉCHEC à l'étape « dossiers »/.test(r.stdout) && /Que faire/.test(r.stdout) && !/at .*\.mjs:\d+/.test(r.stdout + r.stderr), tail(r));
r = checkCode();
check('   --check : 1 (l’installation interrompue n’est pas complète)', r.status === 1, r.stdout.trim());
rmSync(path.join(repo, 'sauvegardes'), { force: true });
r = setup(['--skip-install']);
check('   corrigé, relancée : réussie', r.status === 0, tail(r));

// 7. Nothing global: the global npm packages and prefix are unchanged.
check('7. aucune modification globale (paquets npm globaux et préfixe inchangés)', globalState() === globalBefore);
say(`RÉSULTAT ${failures} échec(s)`);
process.exitCode = failures === 0 ? 0 : 1;
