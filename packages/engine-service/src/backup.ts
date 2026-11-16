/**
 * Backup and restore of the engine data directory (Phase 1B.10).
 *
 * BACKUP (engine stopped: the directory lock is taken, so nothing writes):
 * - a dated directory `<out>/geoplacer-sauvegarde-<date>/`, written as
 *   `<name>.partial`, verified, then renamed: a backup is either complete or
 *   absent;
 * - `donnees/` holds every file of the data directory (simulated world,
 *   templates and revisions, attempt journal and checkpoints, history,
 *   settings) except the lock files, temporary files and the worlds kept
 *   aside after a reset;
 * - `MANIFEST.json` lists each file with its size and SHA-256, the format
 *   versions and a summary; `MANIFEST.sha256` holds the hash of the manifest.
 *
 * RESTORE (engine stopped, journaled):
 * 1. the backup is verified (manifest hash, every file's size and hash, no
 *    path outside `donnees/`) and its formats must be known;
 * 2. the target directory is locked (refused while GeoPlacer runs);
 * 3. the files are copied into a sibling staging directory and checked
 *    again, then its content is checked (settings, simulated world, journal);
 * 4. the current directory is moved aside (`<data>.avant-restauration-<date>`,
 *    KEPT), the staging directory takes its place.
 * A state file `<data>.restauration.json` records the step reached: while it
 * exists the engine refuses to open, and `resume` finishes the restore or
 * puts the previous data back. A corrupt backup never touches the current
 * data (refused at step 1, or at step 3 before any move).
 *
 * Phase 1C.0: the demonstration (data/demo) and the project (data/engine)
 * must not be mixed by accident. The manifest records the name of the backed-up
 * directory (`summary.dataDirName`, optional: older backups have none and stay
 * restorable), a demonstration backup is named `geoplacer-sauvegarde-demo-<date>`,
 * and a restore across kinds (demonstration into a project directory, or the
 * reverse) is refused (BACKUP_KIND_MISMATCH) unless explicitly allowed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CORE_CONTRACT_VERSION } from '@geoplacer/core';
import { acquireDataDirectoryLock, diagnoseJournal, type DataDirectoryLock } from '@geoplacer/adapters-node';
import { loadSettings, rulesOf } from './settings.js';
import { FileWorldStore, WORLD_FORMAT_VERSION } from './world-store.js';

export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST = 'MANIFEST.json';
const MANIFEST_HASH = 'MANIFEST.sha256';
const DATA = 'donnees';

export type BackupErrorCode =
  | 'ENGINE_RUNNING'
  | 'BACKUP_CORRUPT'
  | 'BACKUP_INCOMPATIBLE'
  | 'BACKUP_INCONSISTENT'
  | 'BACKUP_KIND_MISMATCH'
  | 'RESTORE_IN_PROGRESS'
  | 'NOTHING_TO_RESUME'
  | 'NOT_FOUND';

/** The demonstration directory is named `demo` (npm run demo); every other one is a project. */
export const dataDirKind = (name: string): 'demonstration' | 'project' => (name === 'demo' ? 'demonstration' : 'project');

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

export interface BackupFileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly format: 'geoplacer-backup';
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly versions: { readonly coreContract: number; readonly worldFormat: number; readonly settingsSchema: number };
  readonly summary: {
    readonly files: number;
    readonly bytes: number;
    readonly selectedTemplate: string | null;
    readonly canvas: { readonly width: number; readonly height: number };
    readonly rulesVersion: number;
    /** Phase 1C.0: name of the backed-up directory (`demo` for the demonstration); absent before. */
    readonly dataDirName?: string;
  };
  readonly files: readonly BackupFileEntry[];
}

/** Named steps of a restore (the crash tests stop a process at each). */
export type RestoreStep = 'verified' | 'staged' | 'state-written' | 'previous-moved' | 'restored-moved' | 'done';

export interface RestoreOptions {
  /** Test hook, called after each named step. */
  readonly onStep?: (step: RestoreStep) => void;
  /** Phase 1C.0: allows a demonstration backup into a project directory, or the reverse. */
  readonly allowKindChange?: boolean;
}

export interface RestoreReport {
  readonly restoredFiles: number;
  /** Where the data that was there before is kept (null: there was none). */
  readonly previous: string | null;
  readonly warnings: readonly string[];
}

interface RestoreState {
  readonly format: 'geoplacer-restore';
  readonly id: string;
  readonly target: string;
  readonly staging: string;
  readonly previous: string;
  readonly backup: string;
  readonly step: 'staged' | 'previous-moved';
}

const EXCLUDED = (name: string): boolean => name === '.geoplacer.lock' || name === '.geoplacer.lock.owner' || name.endsWith('.tmp') || /^world-reset-/.test(name) || name.includes('.stale-');

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Relative paths ('/' separated) of the files under `root`, excluded names skipped. */
async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return out;
    throw error;
  }
  for (const e of entries) {
    if (EXCLUDED(e.name)) continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

async function fsyncFile(file: string): Promise<void> {
  const h = await open(file, 'r+');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The data directory lock, or ENGINE_RUNNING when GeoPlacer holds it. */
async function lockOrRefuse(dataDir: string): Promise<DataDirectoryLock> {
  try {
    return await acquireDataDirectoryLock(dataDir);
  } catch (error) {
    if ((error as { code?: string }).code === 'DATA_DIRECTORY_LOCKED') {
      throw new BackupError('ENGINE_RUNNING', `${(error as Error).message}: stop GeoPlacer first (backups and restores are made while it is stopped)`);
    }
    throw error;
  }
}

/** Sibling state file of a restore in progress (the engine refuses to open while it exists). */
export function restoreStateFile(dataDir: string): string {
  return `${path.resolve(dataDir)}.restauration.json`;
}

/** Throws RESTORE_IN_PROGRESS when an interrupted restore must be resumed first. */
export async function assertNoRestoreInProgress(dataDir: string): Promise<void> {
  if (await exists(restoreStateFile(dataDir))) {
    throw new BackupError('RESTORE_IN_PROGRESS', `an interrupted restore must be finished first: run "npm run restore -- --resume" (state file ${path.basename(restoreStateFile(dataDir))})`);
  }
}

/**
 * Backs up `dataDir` (engine stopped) into a new directory under `outDir`.
 * Returns the backup directory and its manifest.
 */
export async function createBackup(dataDir: string, outDir: string, options: { readonly lock?: DataDirectoryLock } = {}): Promise<{ readonly dir: string; readonly manifest: BackupManifest }> {
  const root = path.resolve(dataDir);
  if (!(await exists(root))) throw new BackupError('NOT_FOUND', `no data directory at ${root}`);
  await assertNoRestoreInProgress(root);
  const lock = options.lock ?? (await lockOrRefuse(root));
  try {
    const settings = await loadSettings(root);
    const name = `geoplacer-sauvegarde-${dataDirKind(path.basename(root)) === 'demonstration' ? 'demo-' : ''}${stamp()}`;
    const final = path.join(path.resolve(outDir), name);
    const partial = `${final}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(path.join(partial, DATA), { recursive: true });
    const files: BackupFileEntry[] = [];
    let total = 0;
    for (const rel of await walk(root)) {
      const from = path.join(root, ...rel.split('/'));
      const to = path.join(partial, DATA, ...rel.split('/'));
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      await fsyncFile(to);
      const source = await sha256File(from);
      const copy = await sha256File(to);
      if (source.sha256 !== copy.sha256) throw new Error(`copy of ${rel} differs from its source`);
      files.push({ path: rel, bytes: copy.bytes, sha256: copy.sha256 });
      total += copy.bytes;
    }
    const manifest: BackupManifest = {
      format: 'geoplacer-backup',
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      versions: { coreContract: CORE_CONTRACT_VERSION, worldFormat: WORLD_FORMAT_VERSION, settingsSchema: settings.schemaVersion },
      summary: {
        files: files.length,
        bytes: total,
        selectedTemplate: settings.selection?.templateId ?? null,
        canvas: { width: settings.simulator.width, height: settings.simulator.height },
        rulesVersion: settings.simulator.rulesVersion,
        dataDirName: path.basename(root),
      },
      files,
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(partial, MANIFEST), text);
    await writeFile(path.join(partial, MANIFEST_HASH), `${createHash('sha256').update(text).digest('hex')}  ${MANIFEST}\n`);
    await fsyncFile(path.join(partial, MANIFEST));
    await fsyncFile(path.join(partial, MANIFEST_HASH));
    await verifyBackup(partial);
    await rename(partial, final);
    return { dir: final, manifest };
  } finally {
    if (options.lock === undefined) await lock.release();
  }
}

/** Verifies a backup (integrity and compatibility); returns its manifest. Never writes. */
export async function verifyBackup(backupDir: string): Promise<BackupManifest> {
  const dir = path.resolve(backupDir);
  let text: string;
  let hashLine: string;
  try {
    text = await readFile(path.join(dir, MANIFEST), 'utf8');
    hashLine = await readFile(path.join(dir, MANIFEST_HASH), 'utf8');
  } catch {
    throw new BackupError('BACKUP_CORRUPT', `${MANIFEST} or ${MANIFEST_HASH} is missing: not a GeoPlacer backup, or an incomplete one`);
  }
  if (createHash('sha256').update(text).digest('hex') !== hashLine.trim().split(/\s+/)[0]) throw new BackupError('BACKUP_CORRUPT', 'the manifest does not match its hash: the backup was altered');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    throw new BackupError('BACKUP_CORRUPT', 'the manifest is not valid JSON');
  }
  if (manifest.format !== 'geoplacer-backup' || !Array.isArray(manifest.files)) throw new BackupError('BACKUP_CORRUPT', 'not a GeoPlacer backup manifest');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION || manifest.versions.worldFormat > WORLD_FORMAT_VERSION || manifest.versions.coreContract > CORE_CONTRACT_VERSION || manifest.versions.settingsSchema !== 1) {
    throw new BackupError('BACKUP_INCOMPATIBLE', `the backup was made by a newer or unknown GeoPlacer (backup ${manifest.formatVersion}, world ${manifest.versions.worldFormat}, contracts ${manifest.versions.coreContract}): update GeoPlacer first`);
  }
  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || f.path === '' || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some((s: string) => s === '..' || s === '.' || s === '') || /^[a-zA-Z]:/.test(f.path)) {
      throw new BackupError('BACKUP_CORRUPT', `invalid path in the manifest: ${JSON.stringify(f.path)}`);
    }
    const file = path.join(dir, DATA, ...f.path.split('/'));
    let actual;
    try {
      actual = await sha256File(file);
    } catch {
      throw new BackupError('BACKUP_CORRUPT', `missing file: ${f.path}`);
    }
    if (actual.bytes !== f.bytes || actual.sha256 !== f.sha256) throw new BackupError('BACKUP_CORRUPT', `file altered: ${f.path}`);
    listed.add(f.path);
  }
  for (const rel of await walk(path.join(dir, DATA))) if (!listed.has(rel)) throw new BackupError('BACKUP_CORRUPT', `file not in the manifest: ${rel}`);
  return manifest;
}

/** Checks a restored directory's content: settings, simulated world, journal. */
async function checkContent(dir: string): Promise<string[]> {
  const warnings: string[] = [];
  let settings;
  try {
    settings = await loadSettings(dir);
  } catch (error) {
    throw new BackupError('BACKUP_INCONSISTENT', `engine.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rules = rulesOf(settings.simulator);
  const opened = await FileWorldStore.open(path.join(dir, 'world'), {
    bounds: { minX: 0, minY: 0, width: settings.simulator.width, height: settings.simulator.height },
    coordinateSystem: { yAxis: 'down' },
    rules: { id: rules.id, version: rules.version },
  }).catch((error: unknown) => {
    throw new BackupError('BACKUP_INCONSISTENT', `simulated world: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (opened.kind === 'restored') {
    await opened.store.close();
    if (opened.report.tornTailCut) warnings.push('the simulated world had a torn last change (cut off): it was never acknowledged');
  } else warnings.push('the backup holds no simulated world: a new one will be created');
  const journal = await diagnoseJournal(dir);
  if (journal.verdict !== 'healthy' && journal.verdict !== 'empty') warnings.push(`attempt journal: ${journal.verdict} (it is reconciled or repaired at the next start)`);
  return warnings;
}

async function writeState(file: string, state: RestoreState): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fsyncFile(tmp);
  await rename(tmp, file);
}

/**
 * Restores `backupDir` into `dataDir` (GeoPlacer stopped). The current data
 * is kept aside. Throws before touching anything when the backup is corrupt,
 * incompatible or inconsistent, or GeoPlacer runs.
 */
export async function restoreBackup(backupDir: string, dataDir: string, options: RestoreOptions = {}): Promise<RestoreReport> {
  const target = path.resolve(dataDir);
  await assertNoRestoreInProgress(target);
  const manifest = await verifyBackup(backupDir);
  const from = manifest.summary.dataDirName;
  if (from !== undefined && dataDirKind(from) !== dataDirKind(path.basename(target)) && options.allowKindChange !== true) {
    throw new BackupError(
      'BACKUP_KIND_MISMATCH',
      `a ${dataDirKind(from)} backup (${from}) into a ${dataDirKind(path.basename(target))} directory (${path.basename(target)}): refused, nothing was changed`
    );
  }
  options.onStep?.('verified');
  const hadData = await exists(target);
  const lock = hadData ? await lockOrRefuse(target) : null;
  const id = stamp();
  const staging = `${target}.restauration-${id}.partial`;
  const previous = `${target}.avant-restauration-${id}`;
  let released = false;
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    for (const f of manifest.files) {
      const to = path.join(staging, ...f.path.split('/'));
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(path.resolve(backupDir), DATA, ...f.path.split('/')), to);
      await fsyncFile(to);
      const copied = await sha256File(to);
      if (copied.sha256 !== f.sha256) throw new BackupError('BACKUP_CORRUPT', `copy of ${f.path} differs from the backup`);
    }
    let warnings: string[];
    try {
      warnings = await checkContent(staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    options.onStep?.('staged');
    await writeState(restoreStateFile(target), { format: 'geoplacer-restore', id, target, staging, previous, backup: path.resolve(backupDir), step: 'staged' });
    options.onStep?.('state-written');
    // The lock must be released for the directory to be moved (Windows keeps it open).
    await lock?.release();
    released = true;
    await finishRestore(target, options);
    return { restoredFiles: manifest.files.length, previous: hadData ? previous : null, warnings };
  } catch (error) {
    if (!released && (await exists(staging)) && !(await exists(restoreStateFile(target)))) await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (!released) await lock?.release();
  }
}

/** Moves the directories according to the state file, then removes it (idempotent: also the resume). */
async function finishRestore(target: string, options: RestoreOptions = {}): Promise<void> {
  const file = restoreStateFile(target);
  const state = JSON.parse(await readFile(file, 'utf8')) as RestoreState;
  if (state.step === 'staged') {
    if (await exists(state.target)) await rename(state.target, state.previous);
    await writeState(file, { ...state, step: 'previous-moved' });
    options.onStep?.('previous-moved');
  }
  if (await exists(state.staging)) {
    await rename(state.staging, state.target);
    options.onStep?.('restored-moved');
  }
  await rm(file, { force: true });
  options.onStep?.('done');
}

/**
 * Resumes an interrupted restore: finishes it when the restored data is
 * complete (staging kept), otherwise puts the previous data back.
 * Returns what was done.
 */
export async function resumeRestore(dataDir: string): Promise<'finished' | 'rolled-back' | 'already-done'> {
  const target = path.resolve(dataDir);
  const file = restoreStateFile(target);
  if (!(await exists(file))) throw new BackupError('NOTHING_TO_RESUME', 'no interrupted restore for this data directory');
  const state = JSON.parse(await readFile(file, 'utf8')) as RestoreState;
  if (await exists(state.staging)) {
    await finishRestore(target);
    return 'finished';
  }
  if (await exists(state.target)) {
    await rm(file, { force: true });
    return 'already-done';
  }
  // Neither: the staging is gone but the target too: put the previous data back.
  if (await exists(state.previous)) await rename(state.previous, state.target);
  await rm(file, { force: true });
  return 'rolled-back';
}
