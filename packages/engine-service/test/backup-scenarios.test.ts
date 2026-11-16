/**
 * Phase 1C.0: realistic backup and restore scenarios, on top of backup.test.ts (protocol, corruption,
 * incompatibility, interrupted restores with real process kills):
 * - a demonstration interrupted mid-run, backed up, restored into a NEW directory, resumed to the end;
 * - several templates and revisions, the selection included;
 * - the same backup restored twice in a row;
 * - the demonstration and a project never mixed by accident (and older backups still restorable).
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupError, EngineService, createBackup, restoreBackup } from '../src/index.js';
import { cleanup, decodeRegion, demoPng, openFast, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});
const open = async (dataDir: string): Promise<EngineService> => {
  const s = await EngineService.open({ dataDir, eventIntervalMs: 20 });
  opened.push(s);
  return s;
};

/** Hash of every file under a directory, lock files excluded. */
async function treeHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  const visit = async (d: string, rel: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.geoplacer.lock')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await visit(p, `${rel}/${e.name}`);
      else h.update(`${rel}/${e.name}:`).update(await readFile(p));
    }
  };
  await visit(dir, '');
  return h.digest('hex');
}

/** The canvas under a template equals the template (every non-transparent pixel). */
async function matchesTemplate(service: EngineService, templateId: string): Promise<boolean> {
  const img = await service.templateImage(templateId);
  const region = decodeRegion((await service.canvasRegion({ minX: img.x, minY: img.y, width: img.width, height: img.height })).data);
  const want = decodeRegion(img.data);
  return want.every((v, i) => v === -1 || region[i] === v);
}

describe('backup and restore: realistic scenarios (Phase 1C.0)', () => {
  it('a demonstration interrupted mid-run, backed up, restored into a new directory: it resumes and finishes', { timeout: 300_000 }, async () => {
    const root = await tempDir();
    const demo = path.join(root, 'data', 'demo');
    const service = await open(demo);
    expect((await service.demoAvailability()).available).toBe(true);
    await service.setupDemo();
    const templateId = service.status().selection!.templateId;
    await service.start();
    await waitFor(service, (s) => (s.scheduler?.applied ?? 0) >= 300, 60_000);
    await service.stop();
    const stopped = service.status();
    expect(stopped.state).toBe('stopped');
    expect(stopped.journal.openAttempts).toBe(0);
    const correctBefore = stopped.scheduler!.correct!;
    expect(correctBefore).toBeGreaterThan(0);
    const backup = await service.backup();
    expect(backup.name).toMatch(/^geoplacer-sauvegarde-demo-/);
    await service.close();
    opened.splice(opened.indexOf(service), 1);

    // Restored into a NEW directory (another machine, another folder): same kind (demo).
    const elsewhere = path.join(await tempDir(), 'data', 'demo');
    const report = await restoreBackup(path.join(root, 'data', 'sauvegardes', backup.name), elsewhere);
    expect(report.previous).toBeNull();
    const restored = await open(elsewhere);
    expect(restored.status().selection?.templateId).toBe(templateId);
    await restored.start();
    // The demonstration runs in real time (40 pixels per second): about 2 minutes to finish.
    const done = await waitFor(restored, (s) => s.state === 'completed' || s.state === 'error', 240_000);
    expect(done.state, done.reason ?? '').toBe('completed');
    expect(await matchesTemplate(restored, templateId)).toBe(true);
    // Resumed, not restarted: the pixels already right in the backup were not painted again.
    expect(done.scheduler!.applied).toBe(done.scheduler!.correct! - correctBefore);
  });

  it('several templates and revisions survive a backup and a restore, the selection included', async () => {
    const root = await tempDir();
    const data = path.join(root, 'engine');
    const { service } = await openFast(data);
    opened.push(service);
    const a = await service.importTemplate({ name: 'A', png: await demoPng(8, 6, (x, y) => (x + y) % 3), x: 2, y: 2, strategy: 'top-to-bottom' });
    const b = await service.importTemplate({ name: 'B', png: await demoPng(5, 5, (x) => x % 2), x: 30, y: 30, strategy: 'random' });
    await service.moveTemplate(a.templateId, 4, 3);
    await service.moveTemplate(a.templateId, 6, 5);
    await service.selectTemplate(b.templateId);
    const listing = await service.listTemplates();
    const images = await Promise.all([a, b].map((t) => service.templateImage(t.templateId)));
    await service.close();
    opened.splice(opened.indexOf(service), 1);
    const { dir } = await createBackup(data, await tempDir());

    const target = path.join(await tempDir(), 'engine');
    await restoreBackup(dir, target);
    const restored = await open(target);
    const again = await restored.listTemplates();
    const pick = (l: typeof listing) => l.templates.map((t) => ({ id: t.templateId, name: t.name, revision: t.revision, placement: t.placement })).sort((p, q) => p.id.localeCompare(q.id));
    expect(pick(again)).toEqual(pick(listing));
    expect(again.templates.find((t) => t.templateId === a.templateId)?.revision).toBe(3);
    expect(restored.status().selection?.templateId).toBe(b.templateId);
    expect(await Promise.all([a, b].map((t) => restored.templateImage(t.templateId)))).toEqual(images);
  });

  it('the same backup restored twice in a row: same result, each previous state kept aside', async () => {
    const root = await tempDir();
    const data = path.join(root, 'engine');
    const { service } = await openFast(data);
    const t = await service.importTemplate({ name: 'R', png: await demoPng(6, 6, (x, y) => (x * y) % 3), x: 1, y: 1, strategy: 'center-out' });
    await service.selectTemplate(t.templateId);
    await service.close();
    const { dir } = await createBackup(data, await tempDir());
    const target = path.join(await tempDir(), 'engine');
    const first = await restoreBackup(dir, target);
    const afterFirst = await treeHash(target);
    const second = await restoreBackup(dir, target);
    expect(await treeHash(target)).toBe(afterFirst);
    expect(first.previous).toBeNull();
    expect(second.previous).not.toBeNull();
    expect(await treeHash(second.previous!)).toBe(afterFirst);
    const s = await open(target);
    expect(s.status().selection?.templateId).toBe(t.templateId);
  });

  it('a demonstration backup is never restored into a project by accident (and the reverse); older backups still restore', async () => {
    const root = await tempDir();
    const demo = path.join(root, 'data', 'demo');
    const demoService = await open(demo);
    await demoService.setupDemo();
    await demoService.close();
    opened.splice(opened.indexOf(demoService), 1);
    const demoBackup = await createBackup(demo, path.join(root, 'sauvegardes'));
    expect(path.basename(demoBackup.dir)).toMatch(/^geoplacer-sauvegarde-demo-/);
    expect(demoBackup.manifest.summary.dataDirName).toBe('demo');

    // A project with data: the demonstration backup must not replace it silently.
    const project = path.join(root, 'data', 'engine');
    const { service } = await openFast(project);
    await service.importTemplate({ name: 'Mon projet', png: await demoPng(4, 4, () => 1), x: 1, y: 1, strategy: 'top-to-bottom' });
    await service.close();
    const before = await treeHash(project);
    const refused = await restoreBackup(demoBackup.dir, project).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BackupError);
    expect((refused as BackupError).code).toBe('BACKUP_KIND_MISMATCH');
    expect(await treeHash(project)).toBe(before);

    // The reverse: a project backup into the demonstration directory.
    const projectBackup = await createBackup(project, path.join(root, 'sauvegardes'));
    expect(path.basename(projectBackup.dir)).not.toMatch(/-demo-/);
    const reverse = await restoreBackup(projectBackup.dir, demo).catch((e: unknown) => e);
    expect((reverse as BackupError).code).toBe('BACKUP_KIND_MISMATCH');

    // Explicitly allowed: done, the previous data kept aside as always.
    const forced = await restoreBackup(demoBackup.dir, project, { allowKindChange: true });
    expect(forced.previous).not.toBeNull();
    expect(await treeHash(forced.previous!)).toBe(before);

    // A backup made before Phase 1C.0 (no dataDirName in its manifest) is restored as before.
    const manifestPath = path.join(projectBackup.dir, 'MANIFEST.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.summary.dataDirName;
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, text);
    await writeFile(path.join(projectBackup.dir, 'MANIFEST.sha256'), `${createHash('sha256').update(text).digest('hex')}  MANIFEST.json\n`);
    const old = await restoreBackup(projectBackup.dir, demo);
    expect(old.restoredFiles).toBeGreaterThan(0);
  });
});
