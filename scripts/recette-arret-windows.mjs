// Stop and resume acceptance on Windows (Phase 1B.10), on an INSTALLED copy of GeoPlacer (a fresh
// clone after npm run setup:windows), never on a working copy with a demonstration in progress:
//
//   node scripts/recette-arret-windows.mjs <dossier de GeoPlacer> <dossier du compte rendu>
//
// start.bat --demo runs in its own hidden console window; the demonstration is set up and started
// from the API; a CTRL_C_EVENT is generated on that console (GenerateConsoleCtrlEvent: the event the
// keyboard sends, NOT a key press); the progress must be found again after a restart; the run goes
// to the end; a backup is made from the API; the simulated world is deleted, the backup verified and
// restored from the command line; the restored state is checked. Each server output is kept.
// Port 3941 must be free. It writes data\demo and sauvegardes\ in the target directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [clone, outArg] = process.argv.slice(2);
if (!clone || !outArg) throw new Error('usage: node scripts/recette-arret-windows.mjs <dossier de GeoPlacer> <dossier du compte rendu>');
if (process.platform !== 'win32') throw new Error('Windows only (console control events)');
if (existsSync(path.join(clone, 'data', 'demo'))) throw new Error(`${path.join(clone, 'data', 'demo')} exists: use a fresh installed copy (this acceptance creates and modifies its own demonstration data)`);
const here = path.resolve(outArg);
mkdirSync(here, { recursive: true });
const PORT = 3941;
const base = `http://127.0.0.1:${PORT}`;
const report = path.join(here, 'compte-rendu.txt');
writeFileSync(report, '');
const say = (s) => {
  console.log(s);
  appendFileSync(report, s + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class K {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
}
'@`;
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, PORT: String(PORT) } }).trim();

function launch(label, args) {
  const log = path.join(here, `${label}.log`);
  if (existsSync(log)) rmSync(log);
  const run = path.join(here, `${label}.cmd`);
  writeFileSync(run, `@echo off\r\nchcp 65001 >nul\r\ncd /d "${clone}"\r\ncall .\\start.bat ${args} > "${log}" 2>&1\r\necho [run.cmd] exit=%errorlevel% >> "${log}"\r\n`);
  const pid = Number(ps(`${K}\n[void][K]::SetConsoleCtrlHandler([IntPtr]::Zero, $false); $p = Start-Process -FilePath cmd.exe -ArgumentList '/d','/c','"${run}"' -WindowStyle Hidden -PassThru; $p.Id`));
  return { pid, log, out: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}
const ctrlC = (pid) => ps(`${K}\n[void][K]::FreeConsole(); if (-not [K]::AttachConsole(${pid})) { 'attach failed'; exit 2 }; [void][K]::SetConsoleCtrlHandler([IntPtr]::Zero, $true); [void][K]::GenerateConsoleCtrlEvent(0,0); Start-Sleep -Milliseconds 300; 'sent'`);
const alive = (pid) => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(String(pid));
const portFree = () => fetch(`${base}/api/v1/engine/status`).then(() => false, () => true);
async function until(f, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(500);
  }
}
const api = (m, p, b) =>
  fetch(`${base}/api/v1${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const status = () => api('GET', '/engine/status').then((r) => r.body);

async function stopWithCtrlC(w, label) {
  const sent = ctrlC(w.pid);
  say(`${label}: CTRL_C_EVENT ${sent}`);
  const t0 = Date.now();
  await until(async () => /Graceful shutdown completed/.test(w.out()), 30_000, 'graceful shutdown');
  say(`${label}: « Graceful shutdown completed » en ${Date.now() - t0} ms ; SIGINT reçu : ${/Received SIGINT/.test(w.out())} ; moteur libéré : ${/Engine stopped and data directory released/.test(w.out())}`);
  await until(portFree, 15_000, 'port released');
  say(`${label}: port ${PORT} libéré`);
  await sleep(2000);
  const prompt = /Terminer le programme de commandes|Terminate batch job/i.test(w.out());
  const stillThere = alive(w.pid);
  say(`${label}: fenêtre cmd encore ouverte : ${stillThere} ; question « Terminer le programme de commandes » : ${prompt}`);
  if (stillThere) execFileSync('taskkill', ['/PID', String(w.pid), '/T', '/F'], { stdio: 'ignore' });
}

const demoDir = path.join(clone, 'data', 'demo');
let w = launch('run1', '--demo');
try {
  await until(async () => /Server listening on http:\/\/127\.0\.0\.1:/.test(w.out()), 120_000, 'listening');
  say(`run1: start.bat --demo écoute ; mode démonstration annoncé : ${/Demonstration mode/.test(w.out())}`);
  const avail = await api('GET', '/demo');
  say(`run1: GET /demo -> ${JSON.stringify(avail.body)}`);
  const setup = await api('POST', '/demo', {});
  say(`run1: POST /demo -> ${setup.status}`);
  if (setup.status !== 200) throw new Error('the demonstration could not be set up');
  const start = await api('POST', '/engine/start', {});
  say(`run1: start -> ${start.status} ${start.body.status?.state}`);
  const mid = await until(async () => {
    const s = await status();
    return (s.scheduler?.correct ?? 0) > 600 ? s : null;
  }, 60_000, 'some progress');
  say(`run1: progression avant Ctrl+C : ${mid.scheduler.correct} pixels corrects (état ${mid.state})`);
  await stopWithCtrlC(w, 'run1');

  w = launch('run2', '--demo');
  await until(async () => /Server listening on http:\/\/127\.0\.0\.1:/.test(w.out()), 120_000, 'listening 2');
  // The progress counters appear at the next start; the server log tells what was found again.
  const s2 = await status();
  const replayed = /simulated world restored \(generation \d+, (\d+) change\(s\) replayed\)/.exec(w.out());
  say(`run2: après redémarrage : état ${s2.state}, modèle ${s2.selection?.name ?? s2.selection?.templateId} ; toile simulée retrouvée : ${replayed ? `${replayed[1]} changement(s) rejoué(s)` : 'NON'}`);
  if (!replayed || s2.selection === null) throw new Error('the progress was not found again after the restart');
  const st2 = await api('POST', '/engine/start', {});
  say(`run2: start -> ${st2.status}`);
  const t0 = Date.now();
  const done = await until(async () => {
    const s = await status();
    return s.state === 'completed' ? s : null;
  }, 400_000, 'completion');
  say(`run2: terminé en ${Math.round((Date.now() - t0) / 1000)} s après la reprise ; corrects ${done.scheduler.correct}, pourcentage ${done.scheduler.progressPercent ?? '—'}`);
  const backup = await api('POST', '/backup', {});
  say(`run2: POST /backup -> ${backup.status} ${JSON.stringify(backup.body)}`);
  if (backup.status !== 200) throw new Error('the backup failed');
  await stopWithCtrlC(w, 'run2');

  // Damage the demo data, then restore the backup from the command line (GeoPlacer stopped).
  const testWorld = path.resolve(demoDir, 'world');
  if (!testWorld.startsWith(path.resolve(clone) + path.sep) || path.basename(testWorld) !== 'world') throw new Error('unexpected test-world path');
  rmSync(testWorld, { recursive: true, force: true });
  const bdir = path.join(clone, 'sauvegardes', backup.body.name);
  const verify = spawnSync('npm.cmd', ['run', 'backup:verify', '--', bdir], { cwd: clone, encoding: 'utf8', shell: true });
  say(`verify: code ${verify.status} ; ${verify.stdout.trim().split('\n').pop()}`);
  const restore = spawnSync('npm.cmd', ['run', 'restore', '--', bdir, '--data', 'data\\demo'], { cwd: clone, encoding: 'utf8', shell: true });
  say(`restore: code ${restore.status} ;\n${restore.stdout.trim().split('\n').filter((l) => !l.startsWith('>')).join('\n')}${restore.stderr.trim() ? '\nstderr: ' + restore.stderr.trim() : ''}`);

  if (verify.status !== 0 || restore.status !== 0) throw new Error('the backup verification or the restore failed');

  w = launch('run3', '--demo');
  await until(async () => /Server listening on http:\/\/127\.0\.0\.1:/.test(w.out()), 120_000, 'listening 3');
  const s3 = await status();
  say(`run3: après restauration : état ${s3.state}, monde disponible ${JSON.stringify(s3.world?.available)}`);
  // The restored canvas is the finished one: a start ends at once, nothing left to paint.
  const st3 = await api('POST', '/engine/start', {});
  const s4 = await until(async () => {
    const s = await status();
    return s.state === 'completed' ? s : null;
  }, 30_000, 'restored state completed');
  say(`run3: start -> ${st3.status} ; état ${s4.state} ; ${s4.reason ?? ''}`);
  await stopWithCtrlC(w, 'run3');
  say('FIN');
} catch (e) {
  say(`ÉCHEC: ${e.stack ?? e}`);
  say(`--- sortie ---\n${w.out().slice(-3000)}`);
  try {
    execFileSync('taskkill', ['/PID', String(w.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
  process.exitCode = 1;
}
