import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupError, EngineService, createBackup, restoreBackup, resumeRestore, restoreStateFile, verifyBackup } from '../src/index.js';
import { cleanup, decodeRegion, demoPng, openFast, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});

/** A data directory with a finished simulation; returns it closed. */
async function finishedEngine(): Promise<{ data: string; templateId: string; energy: number; canvas: string }> {
  const root = await tempDir();
  const data = path.join(root, 'engine');
  const { service } = await openFast(data);
  const t = await service.importTemplate({ name: 'Sauvée', png: await demoPng(12, 9, (x, y) => ((x * y) % 5 === 0 ? null : (x + y) % 3)), x: 4, y: 6, strategy: 'center-out' });
  await service.selectTemplate(t.templateId);
  await service.start();
  await waitFor(service, (s) => s.state === 'completed');
  const energy = (await service.resourcesView()).energy;
  const canvas = (await service.canvasRegion({ minX: 0, minY: 0, width: 32, height: 32 })).data;
  await service.close();
  return { data, templateId: t.templateId, energy, canvas };
}

/** Hash of every file under a directory (to prove it was not touched); the lock files of a killed holder excluded. */
async function treeHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  const visit = async (d: string, rel: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.name.startsWith('.geoplacer.lock')) continue;
      if (e.isDirectory()) await visit(p, `${rel}/${e.name}`);
      else h.update(`${rel}/${e.name}:`).update(await readFile(p));
    }
  };
  await visit(dir, '');
  return h.digest('hex');
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  );
}

/** Rewrites the manifest of a backup after a change, with a valid hash (only the content checks can catch it). */
async function rehash(backup: string, change: (m: { files: { path: string; bytes: number; sha256: string }[] }) => void): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(backup, 'MANIFEST.json'), 'utf8'));
  change(manifest);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(backup, 'MANIFEST.json'), text);
  await writeFile(path.join(backup, 'MANIFEST.sha256'), `${createHash('sha256').update(text).digest('hex')}  MANIFEST.json\n`);
}

describe('backup and restore (Phase 1B.10)', () => {
  it('a backup restored into another directory gives the same simulation, which resumes without painting twice', async () => {
    const src = await finishedEngine();
    const out = await tempDir();
    const { dir, manifest } = await createBackup(src.data, out);
    expect(path.basename(dir)).toMatch(/^geoplacer-sauvegarde-/);
    expect(manifest.summary.selectedTemplate).toBe(src.templateId);
    expect(manifest.files.some((f) => f.path.startsWith('world/'))).toBe(true);
    expect(manifest.files.some((f) => f.path.startsWith('journal/'))).toBe(true);
    expect(manifest.files.some((f) => f.path.startsWith('projects/'))).toBe(true);
    expect(manifest.files.some((f) => f.path === 'engine.json')).toBe(true);
    expect(manifest.files.some((f) => f.path.includes('.geoplacer.lock'))).toBe(false);
    expect((await verifyBackup(dir)).summary.files).toBe(manifest.files.length);

    const target = path.join(await tempDir(), 'engine');
    const report = await restoreBackup(dir, target);
    expect(report.previous).toBeNull();
    expect(report.restoredFiles).toBe(manifest.files.length);
    expect(await exists(restoreStateFile(target))).toBe(false);
    const service = await EngineService.open({ dataDir: target, eventIntervalMs: 20 });
    opened.push(service);
    expect(service.status().selection?.templateId).toBe(src.templateId);
    expect((await service.canvasRegion({ minX: 0, minY: 0, width: 32, height: 32 })).data).toBe(src.canvas);
    expect((await service.resourcesView()).energy).toBe(src.energy);
    await service.start();
    const done = await waitFor(service, (s) => s.state === 'completed');
    expect(done.scheduler?.applied).toBe(0);
  });

  it('refuses to back up or to restore while GeoPlacer runs on the directory', async () => {
    const src = await finishedEngine();
    const out = await tempDir();
    const { dir } = await createBackup(src.data, out);
    const running = await EngineService.open({ dataDir: src.data });
    opened.push(running);
    await expect(createBackup(src.data, out)).rejects.toMatchObject({ code: 'ENGINE_RUNNING' });
    await expect(restoreBackup(dir, src.data)).rejects.toMatchObject({ code: 'ENGINE_RUNNING' });
  });

  it('the service backs up while stopped, never while the simulation writes', async () => {
    const root = await tempDir();
    const { service } = await openFast(path.join(root, 'engine'));
    opened.push(service);
    await service.configure({ simulator: { writeLatencyMs: 200 } });
    const t = await service.importTemplate({ name: 'X', png: await demoPng(20, 20, () => 2), x: 0, y: 0, strategy: 'random' });
    await service.selectTemplate(t.templateId);
    const first = await service.backup();
    expect(first.name).toMatch(/^geoplacer-sauvegarde-/);
    await verifyBackup(path.join(root, 'sauvegardes', first.name));
    await service.start();
    await expect(service.backup()).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    await service.stop();
  });

  it('a corrupt, incomplete, altered or incompatible backup is refused and the current data is never touched', async () => {
    const src = await finishedEngine();
    const other = await finishedEngine();
    const before = await treeHash(other.data);
    const out = await tempDir();
    const cases: [string, (dir: string) => Promise<void>, string][] = [
      ['altered file', async (d) => writeFile(path.join(d, 'donnees', 'engine.json'), '{"tampered":true}'), 'BACKUP_CORRUPT'],
      ['missing file', async (d) => rm(path.join(d, 'donnees', 'engine.json')), 'BACKUP_CORRUPT'],
      ['extra file', async (d) => writeFile(path.join(d, 'donnees', 'extra.txt'), 'x'), 'BACKUP_CORRUPT'],
      ['altered manifest', async (d) => writeFile(path.join(d, 'MANIFEST.json'), '{}'), 'BACKUP_CORRUPT'],
      ['no manifest', async (d) => rm(path.join(d, 'MANIFEST.json')), 'BACKUP_CORRUPT'],
      ['path outside', async (d) => rehash(d, (m) => m.files.push({ path: '../../evil.txt', bytes: 1, sha256: 'a'.repeat(64) })), 'BACKUP_CORRUPT'],
      ['absolute path', async (d) => rehash(d, (m) => m.files.push({ path: 'C:/Windows/evil.txt', bytes: 1, sha256: 'a'.repeat(64) })), 'BACKUP_CORRUPT'],
      ['newer format', async (d) => rehash(d, (m) => ((m as unknown as { formatVersion: number }).formatVersion = 99)), 'BACKUP_INCOMPATIBLE'],
    ];
    for (const [label, damage, code] of cases) {
      const { dir } = await createBackup(src.data, out);
      await damage(dir);
      await expect(restoreBackup(dir, other.data), label).rejects.toMatchObject({ code });
      expect(await treeHash(other.data), label).toBe(before);
      expect((await readdir(path.dirname(other.data))).filter((n) => n.includes('restauration')), label).toEqual([]);
    }
  });

  it('a backup whose content is inconsistent (damaged world, consistent hashes) is refused before any move', async () => {
    const src = await finishedEngine();
    const other = await finishedEngine();
    const before = await treeHash(other.data);
    const { dir } = await createBackup(src.data, await tempDir());
    const log = (await readdir(path.join(dir, 'donnees', 'world'))).find((n) => n.endsWith('.log'))!;
    const file = path.join(dir, 'donnees', 'world', log);
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines[0] = lines[0]!.replace('"seq":1', '"seq":5');
    await writeFile(file, lines.join('\n'));
    const text = await readFile(file);
    await rehash(dir, (m) => {
      const entry = m.files.find((f) => f.path === `world/${log}`)!;
      entry.bytes = text.length;
      entry.sha256 = createHash('sha256').update(text).digest('hex');
    });
    await expect(restoreBackup(dir, other.data)).rejects.toMatchObject({ code: 'BACKUP_INCONSISTENT' });
    expect(await treeHash(other.data)).toBe(before);
    expect((await readdir(path.dirname(other.data))).filter((n) => n.includes('restauration'))).toEqual([]);
  });

  it('restoring over existing data keeps the previous data aside', async () => {
    const src = await finishedEngine();
    const other = await finishedEngine();
    const before = await treeHash(other.data);
    const { dir } = await createBackup(src.data, await tempDir());
    const report = await restoreBackup(dir, other.data);
    expect(report.previous).not.toBeNull();
    expect(await treeHash(report.previous!)).toBe(before);
    const service = await EngineService.open({ dataDir: other.data });
    opened.push(service);
    expect(service.status().selection?.templateId).toBe(src.templateId);
  });
});

describe('the command line (npm run backup / backup:verify / restore)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, '..', 'src', 'backup-cli.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');
  const env = { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') };
  const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
      proc.on('error', reject);
      proc.on('exit', (code) => resolve({ code, out }));
    });

  it('backs up, verifies and restores with French messages; refuses while running with an explanation', { timeout: 120_000 }, async () => {
    const src = await finishedEngine();
    const out = await tempDir();
    const made = await run(['backup', '--data', src.data, '--out', out]);
    expect(made.code, made.out).toBe(0);
    expect(made.out).toContain('Sauvegarde créée');
    const name = (await readdir(out))[0]!;
    const checked = await run(['verify', path.join(out, name)]);
    expect(checked.out).toContain('Sauvegarde intègre');
    const target = path.join(await tempDir(), 'engine');
    const restored = await run(['restore', path.join(out, name), '--data', target]);
    expect(restored.code, restored.out).toBe(0);
    expect(restored.out).toContain('Restauration terminée');
    const running = await EngineService.open({ dataDir: target });
    opened.push(running);
    const refused = await run(['backup', '--data', target, '--out', out]);
    expect(refused.code).toBe(3);
    expect(refused.out).toContain('GeoPlacer est en cours d’exécution');
    expect((await run(['restore', '--resume', '--data', target])).out).toContain('Aucune restauration interrompue');
  });
});

describe('interrupted restores: real process kills at named steps (no timer)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'fixtures', 'restore-child.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');
  const childEnv = { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') };

  function run(backup: string, data: string, step: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child, backup, data, step], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
      proc.on('error', reject);
      proc.on('exit', () => (out.includes('ready') ? resolve(out + err) : reject(new Error(`child failed: ${err}`))));
    });
  }

  it('after a kill at each step: never without data; the engine refuses to open until resumed; resume restores or rolls back', { timeout: 300_000 }, async () => {
    const src = await finishedEngine();
    const { dir: backup } = await createBackup(src.data, await tempDir());
    for (const step of ['verified', 'staged', 'state-written', 'previous-moved', 'restored-moved']) {
      const other = await finishedEngine();
      const before = await treeHash(other.data);
      const out = await run(backup, other.data, step);
      expect(out, step).toContain(`reached ${step}`);
      const pending = await exists(restoreStateFile(other.data));
      if (step === 'verified' || step === 'staged') {
        // Before the state file: the current data is untouched and usable.
        expect(pending, step).toBe(false);
        expect(await treeHash(other.data), step).toBe(before);
        const s = await EngineService.open({ dataDir: other.data });
        expect(s.status().selection?.templateId, step).toBe(other.templateId);
        await s.close();
        continue;
      }
      // After it: the engine refuses to open (whatever the directories look like) until resumed.
      expect(pending, step).toBe(true);
      await expect(EngineService.open({ dataDir: other.data }), step).rejects.toBeInstanceOf(BackupError);
      // The restored copy already in place (killed after the last move): only the state file was left.
      expect(await resumeRestore(other.data), step).toBe(step === 'restored-moved' ? 'already-done' : 'finished');
      expect(await exists(restoreStateFile(other.data)), step).toBe(false);
      const s = await EngineService.open({ dataDir: other.data });
      expect(s.status().selection?.templateId, step).toBe(src.templateId);
      expect((await s.canvasRegion({ minX: 0, minY: 0, width: 32, height: 32 })).data, step).toBe(src.canvas);
      await s.close();
      // The previous data is kept aside, intact.
      const kept = (await readdir(path.dirname(other.data))).find((n) => n.startsWith('engine.avant-restauration-'));
      expect(kept, step).toBeDefined();
      expect(await treeHash(path.join(path.dirname(other.data), kept!)), step).toBe(before);
    }
  });

  it('a restore whose restored copy disappeared is rolled back: the previous data comes back', async () => {
    const src = await finishedEngine();
    const { dir: backup } = await createBackup(src.data, await tempDir());
    const other = await finishedEngine();
    const before = await treeHash(other.data);
    await run(backup, other.data, 'previous-moved');
    const state = JSON.parse(await readFile(restoreStateFile(other.data), 'utf8')) as { staging: string };
    await rm(state.staging, { recursive: true, force: true });
    expect(await resumeRestore(other.data)).toBe('rolled-back');
    expect(await treeHash(other.data)).toBe(before);
    expect(decodeRegion(src.canvas).length).toBe(32 * 32);
  });
});
