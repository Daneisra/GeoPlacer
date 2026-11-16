// Windows distribution archive of GeoPlacer, reproducible (Release Candidate 6.0.0-rc.1).
//
//   node scripts/build-release-archive.mjs [commit] [--out <dossier>] [--verify-install]
//
// - The archive is `git archive` of ONE identified commit (default HEAD): only tracked files, the
//   line endings of .gitattributes applied (.bat in CRLF), every file dated at the commit time, so
//   the same commit gives the same bytes with the same Git version (the script checks it by
//   building twice). Nothing local is added (no node_modules, dist, data, .env).
// - Name: geoplacer-<version>-windows-<commit court>.zip (version read from package.json AT that
//   commit); folder inside: GeoPlacer-<version>/.
// - Written next to it: <archive>.sha256 (sha256sum format) and <archive>.manifest.json (commit,
//   version, Git and Node.js versions, size, files, checks).
// - Content checks (failure = no archive kept): required files present (LICENSE, README.md,
//   MODIFICATIONS.md, package.json, package-lock.json, frontend/package-lock.json, setup.bat,
//   start.bat, scripts/setup-windows.mjs), forbidden paths absent (node_modules, dist, data,
//   sauvegardes, test-logs, .env), .bat files in CRLF.
// - --verify-install: extracts the archive into a new temporary folder (no Git there), runs
//   start.bat with GEOPLACER_SETUP_ONLY=1 (the whole installation, its start test included), then
//   `setup-windows.mjs --check` (expected 0). Downloads the dependencies.
// It is a source archive: the installation fetches the exact dependencies of the lockfiles and
// the official prebuilt canvas binary (its SHA-256 checked), as from a clone.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const verifyInstall = flag('--verify-install');
const outDir = path.resolve(option('--out') ?? path.join(repo, 'release'));
const commitArg = args[0] ?? 'HEAD';
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`ÉCHEC : ${message}`);
  process.exit(1);
};

const commit = git('rev-parse', '--verify', `${commitArg}^{commit}`);
const short = commit.slice(0, 7);
if (commitArg === 'HEAD' && git('status', '--porcelain') !== '') console.log('Remarque : des modifications non commitées existent ; elles ne sont PAS dans l’archive (seul le commit compte).');
const version = JSON.parse(git('show', `${commit}:package.json`)).version;
const pkg = JSON.parse(git('show', `${commit}:package.json`));
if (pkg.license !== 'AGPL-3.0-only' || !/JinxTheCatto.*luluwaffless/.test(pkg.author) || !git('show', `${commit}:LICENSE`).includes('GNU AFFERO GENERAL PUBLIC LICENSE')) fail('licence ou attribution absente');
// Report file names only: never print a potential secret value into a release log.
const secretPattern = '(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)';
const scan = spawnSync('git', ['-C', repo, 'grep', '-I', '-l', '-E', secretPattern, commit, '--', '.'], { encoding: 'utf8' });
if (scan.status !== 1) fail(scan.status === 0 ? `secret potentiel dans : ${scan.stdout.trim()}` : 'contrôle de secrets impossible');
const name = `geoplacer-${version}-windows-${short}`;
const prefix = `GeoPlacer-${version}/`;
mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `${name}.zip`);

const build = (target) => execFileSync('git', ['-C', repo, 'archive', '--format=zip', `--prefix=${prefix}`, '-o', target, commit]);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// 1. Build twice: the same commit must give the same bytes.
build(zip);
const again = path.join(mkdtempSync(path.join(tmpdir(), 'geoplacer-archive-')), 'again.zip');
build(again);
const hash = sha256(zip);
const reproducible = sha256(again) === hash;
const temporaryArchiveDir = path.resolve(path.dirname(again));
if (path.dirname(temporaryArchiveDir) !== path.resolve(tmpdir()) || !path.basename(temporaryArchiveDir).startsWith('geoplacer-archive-')) fail('dossier temporaire inattendu');
rmSync(temporaryArchiveDir, { recursive: true, force: true });
if (!reproducible) fail('deux constructions du même commit diffèrent (archive non reproductible)');

// 2. Content checks (bsdtar, present in Windows 10, reads zip archives).
// Windows' own bsdtar (System32): another tar first in the PATH (Git Bash, MSYS) reads « d: » as a host.
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const tar = (...a) => spawnSync(tarExe, a, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
const listing = tar('-tf', zip);
if (listing.status !== 0) fail(`impossible de lire l’archive (tar) : ${listing.stderr.toString()}`);
const entries = listing.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
const files = entries.filter((e) => !e.endsWith('/'));
const required = ['LICENSE', 'README.md', 'MODIFICATIONS.md', 'package.json', 'package-lock.json', 'frontend/package-lock.json', 'setup.bat', 'start.bat', 'scripts/setup-windows.mjs'];
const missing = required.filter((f) => !files.includes(prefix + f));
const forbidden = files.filter((f) => /(^|\/)(node_modules|dist|data|sauvegardes|test-logs)\//.test(f.slice(prefix.length)) || /(^|\/)\.env$/.test(f));
const bats = files.filter((f) => f.endsWith('.bat'));
const notCrlf = bats.filter((f) => {
  const bytes = tar('-xOf', zip, f).stdout;
  return bytes.includes(Buffer.from('\n')) && bytes.toString('latin1').replace(/\r\n/g, '').includes('\n');
});
if (missing.length > 0) fail(`fichiers absents : ${missing.join(', ')}`);
if (forbidden.length > 0) fail(`fichiers interdits : ${forbidden.slice(0, 5).join(', ')}`);
if (notCrlf.length > 0) fail(`.bat sans fins de ligne CRLF : ${notCrlf.join(', ')}`);

// 3. Provenance.
writeFileSync(`${zip}.sha256`, `${hash}  ${path.basename(zip)}\n`);
const manifest = {
  name: path.basename(zip),
  version,
  commit,
  commitDate: git('show', '-s', '--format=%cI', commit),
  sha256: hash,
  bytes: statSync(zip).size,
  files: files.length,
  builtWith: { git: git('--version'), node: process.version, command: `git archive --format=zip --prefix=${prefix} ${commit}` },
  checks: { reproducible, required: 'present', forbidden: 'absent', batLineEndings: 'CRLF', license: 'AGPL-3.0-only; original attribution retained', secretScan: 'no high-confidence match in tracked text' },
};
writeFileSync(`${zip}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Archive : ${zip}`);
console.log(`SHA-256 : ${hash}`);
console.log(`Commit : ${commit} (version ${version}) ; ${files.length} fichiers ; reproductible : oui`);

// 4. Optional: install from the extracted archive.
if (verifyInstall) {
  const work = mkdtempSync(path.join(tmpdir(), 'geoplacer-install-'));
  const extract = tar('-xf', zip, '-C', work);
  if (extract.status !== 0) fail(`extraction impossible : ${extract.stderr.toString()}`);
  const root = path.join(work, prefix);
  if (existsSync(path.join(root, '.git'))) fail('l’archive contient un dépôt Git');
  const start = spawnSync('cmd.exe', ['/d', '/c', '.\\start.bat'], { cwd: root, env: { ...process.env, GEOPLACER_SETUP_ONLY: '1' }, encoding: 'utf8' });
  const check = spawnSync(process.execPath, [path.join('scripts', 'setup-windows.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  const installLog = `${zip}.install.log`;
  writeFileSync(installLog, `${start.stdout ?? ''}\n${start.stderr ?? ''}\n--check (${check.status})\n${check.stdout ?? ''}\n${check.stderr ?? ''}`);
  const ok = start.status === 0 && /GeoPlacer est install/.test(start.stdout) && check.status === 0;
  const verification = { folder: root, log: installLog, startBat: start.status, check: check.status, checkText: check.stdout.trim(), canvas: (start.stdout.match(/OK \(binaire chargé[^\n]*/) ?? [''])[0] };
  writeFileSync(`${zip}.manifest.json`, `${JSON.stringify({ ...manifest, installation: { ...verification, ok } }, null, 2)}\n`);
  console.log(`Installation depuis l’archive : ${ok ? 'réussie' : 'ÉCHEC'} (${verification.checkText}) ${verification.canvas}`);
  if (!ok) {
    console.log(start.stdout.slice(-2000));
    fail('installation depuis l’archive');
  }
  console.log(`Dossier d’installation (à supprimer à la main) : ${root}`);
}
